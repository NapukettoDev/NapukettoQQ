/**
 * at-resolver.ts：IPC 动作入参 → Peer / at 元素归一化（2026-11-25 从 actions.ts 拆出）。
 *
 * 两件事：
 *  1. `toPeer`：宽松 params → kernel Peer（chatType + peerUid）；缺 peerUid 时用
 *     peerUin 经 uin→uid 转换；群聊 peerUid 直接用群号（不走用户 uinToUid）。
 *  2. `resolveAtElements`：发送前把 at.target 的 QQ 号（uin）归一化成 uid，并按群成员
 *     缓存补 display（否则 QQ 侧解析 at 失败，表现为「@号后面为空」）。
 *
 * 拆分原因：这两段是 actions 里唯一与「动作表注册」无关的纯逻辑，独立后
 * 动作表只剩动作定义，且 at 归一化可单独做单测（不构造整张动作表）。
 */
import { isRecord } from "../../shared/type-guards.js";

/** 宽松 Peer 最小面（kernel Peer：chatType + peerUid）。 */
export interface IpcPeer {
    chatType: number;
    peerUid: string;
}

/** uin → uid 批量转换（kernel GroupApi.uinToUid；装配层已 bind，勿再摘裸方法）。 */
export type UinToUid = (uins: string[]) => Promise<Map<string, string>>;

/** at 归一化所需的最小上下文（动作表上下文的结构子集）。 */
export interface AtResolveContext {
    /** uin → uid 转换（未注入时保留原元素，保底发送）。 */
    uinToUid?: UinToUid;
    /** 群成员缓存（可选；有 getMember 时补 at display）。 */
    groupCache: {
        getMember?(
            groupCode: string,
            uid: string,
        ): Promise<{ uid: string; nick?: string } | undefined>;
    };
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
 * ipc/attach.ts 把类方法 `GroupApi.uinToUid` 摘成裸函数注入丢了 this（读
 * undefined 的 service）。当时群聊改直通恰好绕开了这条路径，于是「群聊修好了」，
 * 而私聊仍然必炸——直到 2026-08-20 才在 ipc/attach.ts 处 bind 根治。
 * 群聊直通的行为本身仍然正确（上面第一条），保留。
 */
export async function toPeer(
    params: Record<string, unknown>,
    uinToUid: UinToUid | undefined,
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
    ctx: AtResolveContext,
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
    ctx: AtResolveContext,
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
 * 而 NT 的 at 目标契约是 uid（写入 TEXT `atNtUid`；数字 uin 才进 `atUid`，非数字
 * 会被 wrapper 归零成 `"0"`，issue #192）。不转则 QQ 解析 at 失败，只能回退显示
 * content 兜底 "@" → 表现为「@号后面为空」。群聊才有 at 语义，私聊/临时会话跳过。
 *
 * 归一化：uin 批量 uinToUid → uid（u_ 前缀直通不转）；有 groupCache.getMember
 * 时补 display（群成员昵称，kernel toSendElements 用它作 TEXT content，
 * 避免 @ 后无显示名）。转换失败/缺注入：保留原元素（不阻塞发送，保底）。
 */
export async function resolveAtElements(
    chatType: number,
    peerUid: string,
    elements: unknown[],
    ctx: AtResolveContext,
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
