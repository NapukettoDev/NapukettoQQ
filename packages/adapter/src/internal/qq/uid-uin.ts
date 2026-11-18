/**
 * uid → uin 解析（OB11 / Milky 请求与通知翻译共用， 收敛；
 * Satori 事件翻译的 string 口径也归此模块）
 *
 * uidToUin 批量映射由调用方取得后传入；映射缺省退化为 uid 数值（wrapper 部分回调
 * 直接给 uin），非数字返回 0（调用方按 0 兜底展示）。
 *
 * request 事件翻译上下文与毫秒换算常量随本模块共享（OB11 / Milky request 同构）。
 *
 * 异步的批量转换 + 资料详情兜底（`resolveUidToUinWithFallback`）也收在此处：翻译函数
 * 仍是纯函数，查询在 enrichment 内完成（ADR-008）。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { errorMessage } from "@napuketto/kernel";
import type { AdapterLoggerLike } from "../infra/log.js";

/** 毫秒 → 秒（Unix 时间戳换算）。 */
export const MS_TO_SEC = 1000;

/** request 事件翻译上下文（uid→uin 映射，调用方批量转换）。 */
export interface RequestTranslateContext {
    selfUin: string;
    uidToUin: Map<string, string>;
}

/** uid → uin（映射命中取 uin，未命中退化 uid 数值，非数字返回 0）。 */
export function resolveUin(uid: string | undefined, uidToUin: ReadonlyMap<string, string>): number {
    if (uid === undefined || uid === "") {
        return 0;
    }
    const uin = uidToUin.get(uid);
    if (uin !== undefined) {
        return Number(uin);
    }
    const n = Number(uid);
    return Number.isFinite(n) ? n : 0;
}

/**
 * uid → uin（number 口径；ctx 只要求携带 uidToUin 映射——OB11 / Milky 的
 * request + notice 翻译通用，自各协议本地 toUin 收拢）。
 */
export function toUin(
    uid: string | undefined,
    ctx: { uidToUin: ReadonlyMap<string, string> },
): number {
    return resolveUin(uid, ctx.uidToUin);
}

/**
 * uid → uin（string 口径：Satori 资源对象 user.id 保留协议串；映射缺省退化
 * uid 原文，自 satori/event/translate.ts 收拢）。
 */
export function toUinString(uid: string, uidToUin: ReadonlyMap<string, string>): string {
    return uidToUin.get(uid) ?? uid;
}

/** 数字串判别（uin / 群号 / faceId 等协议数字标识）。 */
export const NUMERIC_RE = /^\d+$/;

/**
 * 数字串 uin → number（缺失/非法 → null，调用方按口径省略或跳过；
 * 自 onebot11 adapter.ts 收拢，essence 载荷 operator/sender 用）。
 */
export function numericUin(value: string | null): number | null {
    return value !== null && NUMERIC_RE.test(value) ? Number(value) : null;
}

/**
 * 收集群系统通知涉及的 uid（user1/user2 双方，空 uid 跳过）。
 * OB11 request 边界与 Milky helper 的 `collectNotifyUids` 同源口径。
 */
export function collectGroupNotifyUids(notifies: readonly GroupNotify[]): string[] {
    const uids: string[] = [];
    for (const notify of notifies) {
        for (const user of [notify.user1, notify.user2]) {
            if (user !== undefined && user.uid !== "") {
                uids.push(user.uid);
            }
        }
    }
    return uids;
}

/** 资料详情兜底的单批上限（好友申请批通常只有个位数，超限多为历史积压）。 */
export const MAX_PROFILE_LOOKUPS = 10;

/**
 * uid→uin 批量转换 + 资料详情兜底的装配依赖（OB11 / Milky enrichment 共用）。
 *
 * `profileFallback` 为 true 时才逐条兜底（好友申请等弱身份场景）：群成员口径
 * （`getUinByUids`）解析不到不在任何群里的申请人，不回退会让 `user_id` 恒 0。
 * grayTip 一类高频路径不做兜底——群口径整体失败时逐 uid 打 IPC 会把收链路拖垮。
 */
export interface UidToUinFallbackDeps {
    uidToUin: (uids: string[]) => Promise<Map<string, string>>;
    /** 单条资料详情兜底（缺省 / `profileFallback` 未开时不调用）。 */
    getUinByUid?: ((uid: string) => Promise<string | null>) | undefined;
    logger?: AdapterLoggerLike | undefined;
    /** 日志前缀口径（`ob11` / `milky`）。 */
    scope: "ob11" | "milky";
    /** 批量转换失败时的 warn 文案（各协议口径自带前缀）。 */
    batchWarnMsg: string;
    /** 群口径未命中时用资料详情兜底（好友申请等弱身份场景；issue #122）。 */
    profileFallback?: boolean | undefined;
}

/**
 * 批量 uid→uin：去重 + 空串过滤 → 批量转换 → 可选资料兜底（原地回填 map）。
 *
 * fail-soft：批量失败打 `warn` 退空 Map（翻译层退化 uid 数值）；单条资料兜底失败与
 * 待兜底条数超 `MAX_PROFILE_LOOKUPS` 打 `debug`（不阻塞请求 / 事件上报）。
 */
export async function resolveUidToUinWithFallback(
    uids: readonly string[],
    deps: UidToUinFallbackDeps,
): Promise<Map<string, string>> {
    const unique = [...new Set(uids.filter((uid) => uid !== ""))];
    if (unique.length === 0) {
        return new Map();
    }
    let map: Map<string, string>;
    try {
        map = await deps.uidToUin(unique);
    } catch (err) {
        deps.logger?.warn({ count: unique.length, error: errorMessage(err) }, deps.batchWarnMsg);
        map = new Map();
    }
    const getUinByUid = deps.getUinByUid;
    if (deps.profileFallback !== true || getUinByUid === undefined) {
        return map;
    }
    const missing = unique.filter((uid) => !map.has(uid));
    for (const uid of missing.slice(0, MAX_PROFILE_LOOKUPS)) {
        try {
            const uin = await getUinByUid(uid);
            if (uin !== null) {
                map.set(uid, uin);
            }
        } catch (err) {
            deps.logger?.debug(
                { error: errorMessage(err) },
                `${deps.scope}: uid→uin 资料兜底失败（该 uid 退 0）`,
            );
        }
    }
    if (missing.length > MAX_PROFILE_LOOKUPS) {
        deps.logger?.debug(
            { missing: missing.length, limit: MAX_PROFILE_LOOKUPS },
            `${deps.scope}: 待兜底 uid 超上限，其余保持未命中`,
        );
    }
    return map;
}
