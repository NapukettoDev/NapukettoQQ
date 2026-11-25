/**
 * actions.ts：IPC 动作表（koishi 动作 → kernel API）。
 *
 * 协议契约：动作名点分域（`msg.sendMessage` 等），params 宽松透传。
 * 本轮实现 koishi Bot 核心动作（发消息/撤回/历史/已读/列表/self）；
 * 其余动作随 koishi 插件 actions.ts 轮次按需扩充。
 *
 * ⚠️ 不自研 kernel 依赖（loader 运行时 file:// 动态 import kernel，编译期不建
 * workspace 依赖——见 runtime/types.ts 注释）。错误码提取统一走 shared/type-guards。
 *
 * 2026-11-25 P1：Peer / at 归一化拆到 `at-resolver.ts`，本文件只剩动作定义与调用。
 */
import { z } from "zod";
import { IpcRespondToGroupRequestParamsSchema } from "../../contract/ipc-schema.js";
import { log } from "../../shared/boot-log.js";
import { getErrorCode, getErrorMessage } from "../../shared/type-guards.js";
import type { GroupNotifyApiLike, MsgApiLike } from "../runtime/types.js";
import { resolveAtElements, toPeer, type UinToUid } from "./at-resolver.js";
import { type IpcDiagnosticContext, registerDiagnosticActions } from "./diagnostics.js";

export type { IpcPeer } from "./at-resolver.js";
export { DIAGNOSTIC_ACTION_NAMES } from "./diagnostics.js";

/** kernel apis 最小面（仅本表用到的成员；真实实例由引导装配提供）。 */
export interface IpcApiContext extends IpcDiagnosticContext {
    msgApi: Pick<
        MsgApiLike,
        "sendMessage" | "recallMessage" | "fetchMessages" | "setMsgEmojiLikeById" | "markRead"
    >;
    groupApi: {
        /** 触发原生群列表刷新（数据经 onGroupListUpdate 事件推送，返回值无数据）。 */
        getGroupList(force?: boolean): Promise<unknown[]>;
    };
    /** 群缓存（事件维护群列表；listGroupsRefreshed 空缓存时主动刷新等待回填）。 */
    groupCache: {
        listGroupsRefreshed(): Promise<Array<{ groupCode: string; groupName: string }>>;
        /** 群成员（缓存优先 + 惰性回填；at 昵称补全用，可选——未注入则跳过补全）。 */
        getMember?(
            groupCode: string,
            uid: string,
        ): Promise<{ uid: string; nick?: string } | undefined>;
    };
    friendApi: {
        getFriendList(): Promise<unknown[]>;
    };
    groupNotifyApi?: GroupNotifyApiLike;
    /** 登录账号自身信息。 */
    self: { uin: string; nickname: string };
    /** uin → uid 转换（Peer 目标解析；注入 groupApi.uinToUid）。 */
    uinToUid?: UinToUid;
}

/** 动作处理函数：params 宽松透传，返回值原样序列化（JSON 可序列化）。 */
export type IpcActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

const addReactionParamsSchema = z
    .object({
        chatType: z.literal([1, 2, 100]).optional(),
        peerUid: z.string().trim().min(1).optional(),
        peerUin: z.string().trim().min(1).optional(),
        msgId: z.string(),
        emojiId: z.string(),
    })
    .refine(({ peerUid, peerUin }) => peerUid !== undefined || peerUin !== undefined, {
        message: "需要 peerUid 或 peerUin",
    });

/**
 * 注册 login.refreshQr 动作（登录期即可用——不依赖 session 服务，只依赖
 * core.refreshQr）。bootstrap 提前启动 IPC 服务端时先注册本动作，登录完成后
 * 再把 kernel 服务的完整动作并入同一张表。
 */
export function registerLoginRefreshAction(
    actions: Map<string, IpcActionHandler>,
    refreshQr: () => boolean,
): void {
    actions.set("login.refreshQr", async () => refreshQr());
}

/** 动作表构造选项。 */
export interface IpcActionOptions {
    /**
     * 是否注册 `diag.*` 诊断动作。默认 false：常规动作表不含反射面；
     * 只有本地显式调试（`NAPUKETTO_DIAG=1` / `LaunchOptions.diagnostics`）才开启。
     */
    diagnostics?: boolean;
}

/** 构造动作表（map 顺序即注册顺序，重复动作名后注册覆盖）。 */
export function createIpcActions(
    ctx: IpcApiContext,
    options: IpcActionOptions = {},
): Map<string, IpcActionHandler> {
    const actions = new Map<string, IpcActionHandler>();

    actions.set("login.getSelf", async () => ctx.self);

    actions.set("msg.sendMessage", async (params) => {
        const peer = await toPeer(params, ctx.uinToUid);
        const elements = Array.isArray(params["elements"]) ? params["elements"] : [];
        // at 目标归一化（uin → uid + 昵称补全）后再交给 kernel，见 at-resolver.ts
        const resolved = await resolveAtElements(peer.chatType, peer.peerUid, elements, ctx);
        return ctx.msgApi.sendMessage(peer, resolved);
    });

    actions.set("msg.recallMessage", async (params) => {
        const peer = await toPeer(params, ctx.uinToUid);
        // 清洗 msgIds：null/空字符串/纯空白过滤掉（`[null].map(String)` 会变成
        // "null" 字符串透传给 wrapper，只换回「无错误详情」）；清洗后为空交给
        // kernel 抛 INVALID_PARAM
        const msgIds = Array.isArray(params["msgIds"])
            ? params["msgIds"]
                  .map((id) => (typeof id === "string" ? id.trim() : ""))
                  .filter((id) => id !== "")
            : [];
        await ctx.msgApi.recallMessage(peer, msgIds);
    });

    actions.set("msg.fetchMessages", async (params) => {
        const peer = await toPeer(params, ctx.uinToUid);
        const count = typeof params["count"] === "number" ? params["count"] : 20;
        const msgId = typeof params["msgId"] === "string" ? params["msgId"] : undefined;
        return ctx.msgApi.fetchMessages(peer, { count, ...(msgId !== undefined ? { msgId } : {}) });
    });

    actions.set("msg.addReaction", async (params) => {
        const parsed = addReactionParamsSchema.safeParse(params);
        if (!parsed.success) {
            throw Object.assign(new Error(z.prettifyError(parsed.error)), {
                code: "INVALID_PARAM",
            });
        }
        const { msgApi } = ctx;
        if (msgApi.setMsgEmojiLikeById === undefined) {
            throw Object.assign(new Error("当前 kernel 版本不支持按原生消息 ID 表态"), {
                code: "INVALID_STATE",
            });
        }
        const { msgId, emojiId } = parsed.data;
        const peer = await toPeer(parsed.data, ctx.uinToUid);
        await msgApi.setMsgEmojiLikeById(peer, { msgId, emojiId, like: true });
    });

    actions.set("msg.markRead", async (params) => {
        const peer = await toPeer(params, ctx.uinToUid);
        await ctx.msgApi.markRead(peer);
    });

    actions.set("group.getGroupList", async () => {
        // 群列表数据唯一来源：GroupCache（实测原生 getGroupList 返回值无数据，
        // 列表经 onGroupListUpdate 事件推送；缓存为空时内部触发刷新等待回填）
        return ctx.groupCache.listGroupsRefreshed();
    });

    actions.set("friend.getFriendList", async () => ctx.friendApi.getFriendList());

    actions.set("group.respondToRequest", async (params) => {
        const parsed = IpcRespondToGroupRequestParamsSchema.safeParse(params);
        if (!parsed.success) {
            throw Object.assign(new Error(z.prettifyError(parsed.error)), {
                code: "INVALID_PARAM",
            });
        }
        const { selfUin, request, approve, reason } = parsed.data;
        if (selfUin !== ctx.self.uin) {
            throw Object.assign(new Error("群请求与当前登录账号不匹配"), { code: "INVALID_PARAM" });
        }
        const api = ctx.groupNotifyApi;
        if (api?.respondToRequest === undefined) {
            throw Object.assign(new Error("当前 kernel 版本不支持群请求审批"), {
                code: "INVALID_STATE",
            });
        }
        await api.respondToRequest(request, approve, reason);
    });

    // 诊断动作默认不注册：常规动作表只含业务动作，避免外部驱动触达原生反射面。
    // 显式调试（NAPUKETTO_DIAG=1 / LaunchOptions.diagnostics）才挂 diag.*，且内部仍按
    // 目标方法 allowlist 收窄（见 diagnostics.ts）。
    if (options.diagnostics === true) {
        registerDiagnosticActions(actions, ctx);
    }

    return actions;
}

/** 统一动作调用：查找动作表 → 执行 → 返回结果或错误（不抛，调用方转 result）。 */
export async function callIpcAction(
    actions: Map<string, IpcActionHandler>,
    action: string,
    params: Record<string, unknown> | undefined,
): Promise<
    { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } }
> {
    const handler = actions.get(action);
    if (handler === undefined) {
        return { ok: false, error: { code: "NOT_FOUND", message: `未知动作: ${action}` } };
    }
    try {
        const value = await handler(params ?? {});
        return { ok: true, value };
    } catch (err) {
        // 诊断（2026-08-09）：错误消息传回 koishi 会丢堆栈，先落 boot 日志
        // 便于定位真实错误位置（QQ 原生内部抛错时消息难以反查）。
        const message = getErrorMessage(err);
        const stack = err instanceof Error && err.stack !== undefined ? err.stack : "";
        log(`[ipc] action=${action} 失败: ${message}\n${stack}`);
        // 错误码：KernelError 有 string code 字段（统一用 getErrorCode 提取，空值归 UNKNOWN）
        const code = getErrorCode(err);
        return {
            ok: false,
            error: { code: code !== undefined && code !== "" ? code : "UNKNOWN", message },
        };
    }
}
