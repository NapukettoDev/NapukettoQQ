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
import { getErrorCode, getOwnProp, hasCallableProp, isCallable, isRecord } from "../type-guards.js";
import { errorMessage, log } from "../util.js";

/** 宽松 Peer 最小面（kernel Peer：chatType + peerUid）。 */
export interface IpcPeer {
    chatType: number;
    peerUid: string;
}

/** kernel apis 最小面（仅本表用到的成员；真实实例由引导装配提供）。 */
export interface IpcApiContext {
    msgApi: {
        sendMessage(target: IpcPeer, elements: unknown[]): Promise<{ msgId: string }>;
        recallMessage(target: IpcPeer, msgIds: string[]): Promise<void>;
        fetchMessages(target: IpcPeer, opts: { count: number; msgId?: string }): Promise<unknown[]>;
        markRead(target: IpcPeer): Promise<void>;
    };
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
    /** wrapper session（诊断用：枚举/触发原生服务方法面，验证初始化链路）。 */
    session?: unknown;
    /** wrapper engine（诊断用：initLog 等初始化方法验证）。 */
    engine?: unknown;
    /** NodeQQNTWrapperUtil（诊断用：原生 copyFile 验证富媒体文件放置）。 */
    util?: unknown;
}

/** 动作处理函数：params 宽松透传，返回值原样序列化（JSON 可序列化）。 */
export type IpcActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

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

/** 构造动作表（map 顺序即注册顺序，重复动作名后注册覆盖）。 */
export function createIpcActions(ctx: IpcApiContext): Map<string, IpcActionHandler> {
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

    // ── 诊断动作（2026-08-11 重建：调查 rich media transfer failed）──
    // 枚举富媒体/闪传服务方法面 + 调用候选 side-effect 方法，
    // 观察 wrapper 日志是否出现 FlashTransferUploadManager Init / AllocDedicatedThread sucess。
    actions.set("diag.richMediaTmpPaths", async () => runRichMediaDiag(ctx.session));

    // 诊断：按方法名 + 参数数组调用 flash 服务任意方法（2 参数组合实验用）。
    actions.set("diag.flashCall", async (params) => {
        const sess = ctx.session;
        if (!hasCallableProp(sess, "getFlashTransferService")) {
            return { error: "session 未注入" };
        }
        const flash = sess.getFlashTransferService();
        if (flash === null || flash === undefined) {
            return { error: "flash 服务为 null" };
        }
        return callDiagnosticMethod(flash, params);
    });

    // 诊断：调用 session 任意方法（上线信号验证：onLine 可能触发模块初始化）。
    actions.set("diag.sessionCall", async (params) => {
        const method = typeof params["method"] === "string" ? params["method"] : "";
        // 安全拦截：onLine 会导致进程后续丢失全部入站消息；wifiphoto 相关方法非业务面。
        if (method === "onLine" || method.toLowerCase().includes("wifiphoto")) {
            return { ok: false, error: `method ${method} is blocked for safety` };
        }
        if (ctx.session === undefined) {
            return { error: "session 未注入" };
        }
        return callDiagnosticMethod(ctx.session, params);
    });

    // 诊断：调用 engine 任意方法 + 枚举方法面（initLog 等初始化方法验证）。
    actions.set("diag.engineCall", async (params) => {
        if (ctx.engine === undefined) {
            return { error: "engine 未注入" };
        }
        return callDiagnosticMethod(ctx.engine, params);
    });

    // 诊断：调用 richMediaService 任意方法（uploadRMFileWithoutMsg 等替代上传路径）。
    actions.set("diag.richMediaCall", async (params) => {
        const sess = ctx.session;
        if (!hasCallableProp(sess, "getRichMediaService")) {
            return { error: "session 未注入" };
        }
        const svc = sess.getRichMediaService();
        if (svc === null || svc === undefined) {
            return { error: "richMedia 服务为 null" };
        }
        return callDiagnosticMethod(svc, params);
    });

    // 诊断：调用 msgService 任意方法（getRichMediaFilePathForGuild 等富媒体路径计算）。
    actions.set("diag.msgServiceCall", async (params) => {
        const sess = ctx.session;
        if (!hasCallableProp(sess, "getMsgService")) {
            return { error: "session 未注入" };
        }
        const svc = sess.getMsgService();
        if (svc === null || svc === undefined) {
            return { error: "msgService 为 null" };
        }
        return callDiagnosticMethod(svc, params);
    });

    // 诊断：调用 NodeQQNTWrapperUtil 任意方法（原生 copyFile 等）。
    actions.set("diag.utilCall", async (params) => {
        const util = ctx.util;
        if (util === undefined || util === null) {
            return { error: "util 未注入" };
        }
        const instance = hasCallableProp(util, "get") ? util.get() : util;
        if (instance === null || instance === undefined) {
            return { error: "util 实例为 null" };
        }
        return callDiagnosticMethod(instance, params);
    });

    return actions;
}

/** 诊断：按方法名 + 参数数组调用对象任意方法（返回结构化结果，不抛）。
 * ⚠️ NAPI 对象方法挂在实例自身（非原型），__methods 须枚举实例 ownKeys。 */
async function callDiagnosticMethod(
    obj: unknown,
    params: Record<string, unknown>,
): Promise<unknown> {
    const method = typeof params["method"] === "string" ? params["method"] : "";
    const args = Array.isArray(params["args"]) ? params["args"] : [];
    if ((typeof obj !== "object" && typeof obj !== "function") || obj === null) {
        return { error: "target object is not a record" };
    }
    if (method === "__methods") {
        const own = Object.getOwnPropertyNames(obj);
        const proto: unknown = Object.getPrototypeOf(obj);
        const protoKeys = isRecord(proto) ? Object.getOwnPropertyNames(proto) : [];
        return { methods: [...new Set([...own, ...protoKeys])] };
    }
    const fn = getOwnProp(obj, method);
    if (!isCallable(fn)) {
        return { error: `方法不存在: ${method}` };
    }
    try {
        const r = await fn.apply(obj, args);
        return { ok: true, ret: r };
    } catch (e) {
        return { ok: false, err: errorMessage(e) };
    }
}

/** 诊断：枚举富媒体临时路径（getPicTmpPath 等 0 参方法）。 */
async function enumerateTmpPaths(svc: unknown): Promise<Record<string, unknown>> {
    const tmp: Record<string, unknown> = {};
    for (const name of [
        "getPicTmpPath",
        "getRichMeidaTmpPath",
        "getPttTmpPath",
        "getVideoTmpPath",
        "getFileTmpPath",
        "getTransferingTmpPath",
    ]) {
        const fn = getOwnProp(svc, name);
        if (isCallable(fn)) {
            try {
                tmp[name] = await fn.call(svc);
            } catch (e) {
                tmp[name] = `调用失败: ${errorMessage(e)}`;
            }
        } else {
            tmp[name] = "方法缺失";
        }
    }
    return tmp;
}

/** 诊断：闪传服务候选 side-effect 触发（§5.3 候选动作 1，参数宽松猜测）。 */
async function probeFlashSideEffects(flash: unknown): Promise<Record<string, unknown>> {
    const sideEffects: Record<string, unknown> = {};
    const candidates: [string, unknown[]][] = [
        ["addFileSetSimpleStatusListener", [() => undefined]],
        ["setFlashTransferDir", [""]],
        ["setFileSetDownloadDir", [""]],
        ["getFileSetIdByCode", [""]],
    ];
    for (const [name, args] of candidates) {
        const fn = getOwnProp(flash, name);
        if (isCallable(fn)) {
            try {
                const r = await fn.apply(flash, args);
                sideEffects[name] = { ok: true, ret: r };
            } catch (e) {
                sideEffects[name] = {
                    ok: false,
                    err: errorMessage(e),
                };
            }
        } else {
            sideEffects[name] = { missing: true };
        }
    }
    return sideEffects;
}

/** 诊断主流程：session → 富媒体服务 + 闪传服务的方法面与触发结果。 */
async function runRichMediaDiag(session: unknown): Promise<Record<string, unknown>> {
    if (session === undefined || session === null) {
        return { error: "session 未注入（IPC 上下文缺 session）" };
    }
    const out: Record<string, unknown> = {};
    const svc = hasCallableProp(session, "getRichMediaService")
        ? session.getRichMediaService()
        : null;
    if (svc !== null && svc !== undefined) {
        out["richMediaTmpPaths"] = await enumerateTmpPaths(svc);
        out["richMediaMethods"] = Object.getOwnPropertyNames(Object.getPrototypeOf(svc));
    } else {
        out["richMediaService"] = "null";
    }
    const flash = hasCallableProp(session, "getFlashTransferService")
        ? session.getFlashTransferService()
        : null;
    if (flash !== null && flash !== undefined) {
        out["flashMethods"] = Object.getOwnPropertyNames(Object.getPrototypeOf(flash));
        out["flashSideEffects"] = await probeFlashSideEffects(flash);
    } else {
        out["flashService"] = "null";
    }
    return out;
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
