/**
 * ipc-actions.ts：IPC 动作表（koishi 动作 → kernel API）。
 *
 * 协议契约：动作名点分域（`msg.sendMessage` 等），params 宽松透传。
 * 本轮实现 koishi Bot 核心动作（发消息/撤回/历史/已读/列表/self）；
 * 其余动作随 koishi 插件 actions.ts 轮次按需扩充。
 *
 * ⚠️ 不自研 kernel 依赖（loader 运行时 file:// 动态 import kernel，编译期不建
 * workspace 依赖——见 types.ts 注释）。错误码提取用宽松结构判断。
 */
import { z } from "zod";
import { getErrorCode, isRecord } from "../type-guards.js";
import type { MsgApiLike } from "../types.js";
import { errorMessage, log } from "../util.js";
import { type IpcDiagnosticContext, registerDiagnosticActions } from "./ipc-diagnostics.js";

export { DIAGNOSTIC_ACTION_NAMES } from "./ipc-diagnostics.js";

/** 宽松 Peer 最小面（kernel Peer：chatType + peerUid）。 */
export interface IpcPeer {
    chatType: number;
    peerUid: string;
}

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
    /** 登录账号自身信息。 */
    self: { uin: string; nickname: string };
    /** uin → uid 转换（Peer 目标解析；注入 groupApi.uinToUid）。 */
    uinToUid?: (uins: string[]) => Promise<Map<string, string>>;
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

/**
 * 从宽松 params 构造 Peer（缺省 chatType=1 私聊）。
 * 优先 peerUid（uid 直通）；缺省时 peerUin 经 uinToUid 转换。
 *
 * ⚠️ 群聊（chatType=2）peerUid 直接用群号（kernel Peer 定义「群号 / 用户 uid」，
 * OB11 resolve-peer 同构），**不走 uinToUid**——getUidByUins 是「用户 uin → uid」
 * 转换，传群号属非法调用。
 *
 * ⚠️ 归因更正（2026-08-20）：2026-08-09 把 `Cannot read properties of undefined
 * (reading 'service')` 归因为「传群号给 getUidByUins」是**误判**。真因是
 * ipc-bootstrap 把类方法 `GroupApi.uinToUid` 摘成裸函数注入丢了 this（读
 * undefined 的 service）。当时群聊改直通恰好绕开了这条路径，于是「群聊修好了」，
 * 而私聊仍然必炸——直到 2026-08-20 才在 ipc-bootstrap 处 bind 根治。
 * 群聊直通的行为本身仍然正确（上面第一条），保留。
 */
async function toPeer(
    params: Record<string, unknown>,
    uinToUid: IpcApiContext["uinToUid"],
): Promise<IpcPeer> {
    const chatType = typeof params["chatType"] === "number" ? params["chatType"] : 1;
    const uidParam = params["peerUid"];
    if (typeof uidParam === "string" && uidParam !== "") {
        return { chatType, peerUid: uidParam };
    }
    const uinParam = params["peerUin"];
    if (typeof uinParam === "string" && uinParam !== "") {
        if (chatType === 2) {
            return { chatType, peerUid: uinParam };
        }
        if (uinToUid !== undefined) {
            const map = await uinToUid([uinParam]);
            const uid = map.get(uinParam);
            if (uid !== undefined && uid !== "") {
                return { chatType, peerUid: uid };
            }
            throw new Error(`uin 转 uid 失败: ${uinParam}`);
        }
        throw new Error("缺 peerUid（或 peerUin 且未注入 uinToUid）");
    }
    throw new Error("缺 peerUid（或 peerUin 且未注入 uinToUid）");
}

/** 宽松 canonical at 元素（协议无关中间层 at 形状）。 */
interface LooseAtElement {
    type: "at";
    target: string;
    display?: string;
}

/** at 元素判断（宽松结构；排除 @全体——target="all" 走 atType=1，无需转换）。 */
function isLooseAtElement(value: unknown): value is LooseAtElement {
    return (
        isRecord(value) &&
        value["type"] === "at" &&
        typeof value["target"] === "string" &&
        value["target"] !== "all"
    );
}

/** 收集元素中的 at（非 @全体）及其索引。 */
function collectAtItems(elements: unknown[]): Array<{ index: number; uin: string }> {
    const items: Array<{ index: number; uin: string }> = [];
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (isLooseAtElement(el)) {
            items.push({ index: i, uin: el.target });
        }
    }
    return items;
}

/** 群成员昵称 → display（可选依赖 groupCache.getMember；无昵称返回 undefined）。 */
async function memberDisplay(
    ctx: IpcApiContext,
    groupCode: string,
    uid: string,
): Promise<string | undefined> {
    if (ctx.groupCache.getMember === undefined) {
        return undefined;
    }
    const member = await ctx.groupCache.getMember(groupCode, uid);
    if (member === undefined || member.nick === undefined || member.nick === "") {
        return undefined;
    }
    return member.nick;
}

/**
 * 单个 at 元素归一化：target uin → uid（u_ 前缀直通）+ display 补全。
 * 返回 null 表示目标未解析（调用方保留原元素，保底发送）。
 */
async function normalizeAtElement(
    ctx: IpcApiContext,
    groupCode: string,
    prev: LooseAtElement,
    uidMap: Map<string, string>,
): Promise<LooseAtElement | null> {
    const uid = prev.target.startsWith("u_") ? prev.target : (uidMap.get(prev.target) ?? "");
    if (uid === "") {
        return null;
    }
    const next: LooseAtElement = { type: "at", target: uid };
    if (prev.display !== undefined && prev.display !== "") {
        next.display = prev.display;
        return next;
    }
    const nick = await memberDisplay(ctx, groupCode, uid);
    if (nick !== undefined) {
        next.display = nick;
    }
    return next;
}

/**
 * 发送前 at 目标归一化（P2-19 同构：OB11 协议层 at.qq uin → uid 后才进 kernel）。
 *
 * 背景（koishi-plugin-adapter-napuketto issue #1「无法 @ 指定群成员」）：
 * koishi 调用方给的 at.target 是 QQ 号（uin——session.userId 即 senderUin），
 * 而 NT 的 atUid 契约是 u_ 开头的 uid。不转则 QQ 解析 at 失败，只能回退显示
 * content 兜底 "@" → 表现为「@号后面为空」。群聊才有 at 语义，私聊/临时会话跳过。
 *
 * 归一化：uin 批量 uinToUid → uid（u_ 前缀直通不转）；有 groupCache.getMember
 * 时补 display（群成员昵称，kernel toSendElements 用它作 TEXT content，
 * 避免 @ 后无显示名）。转换失败/缺注入：保留原元素（不阻塞发送，保底）。
 */
async function resolveAtElements(
    chatType: number,
    peerUid: string,
    elements: unknown[],
    ctx: IpcApiContext,
): Promise<unknown[]> {
    if (chatType !== 2 || ctx.uinToUid === undefined) {
        return elements;
    }
    const atItems = collectAtItems(elements);
    if (atItems.length === 0) {
        return elements;
    }
    // 分离 uid（u_ 前缀直通）与 uin（需 getUidByUins 转换）
    const uins = atItems.filter((item) => !item.uin.startsWith("u_"));
    let uidMap = new Map<string, string>();
    if (uins.length > 0) {
        try {
            uidMap = await ctx.uinToUid(uins.map((item) => item.uin));
        } catch {
            uidMap = new Map(); // 转换失败：保留原 target 保底发送
        }
    }
    const out = [...elements];
    for (const item of atItems) {
        const prev = out[item.index];
        if (!isLooseAtElement(prev)) {
            continue;
        }
        const next = await normalizeAtElement(ctx, peerUid, prev, uidMap);
        if (next !== null) {
            out[item.index] = next;
        }
    }
    return out;
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
        // at 目标归一化（uin → uid + 昵称补全）后再交给 kernel，见 resolveAtElements
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

    // 诊断动作默认不注册：常规动作表只含业务动作，避免外部驱动触达原生反射面。
    // 显式调试（NAPUKETTO_DIAG=1 / LaunchOptions.diagnostics）才挂 diag.*，且内部仍按
    // 目标方法 allowlist 收窄（见 ipc-diagnostics.ts）。
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
        const message = errorMessage(err);
        const stack = err instanceof Error && err.stack !== undefined ? err.stack : "";
        log(`[ipc] action=${action} 失败: ${message}\n${stack}`);
        return { ok: false, error: { code: errorCodeOf(err), message } };
    }
}

/** 宽松提取错误码（KernelError 有 string code 字段；其他错误 UNKNOWN）。 */
function errorCodeOf(err: unknown): string {
    const code = getErrorCode(err);
    return code !== undefined && code !== "" ? code : "UNKNOWN";
}
