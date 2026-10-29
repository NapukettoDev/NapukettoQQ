/**
 * BuddyReq 防御收窄（OB11 / Milky 共用，P1 2026-10-30 从 onebot11 收敛）
 *
 * onBuddyReqChange 回调参数形状未经真实事件校准（wrapper 字符串证据仅有方法名），
 * 仅接受字段形状可用的对象；未知形状返回 null 由调用方打 raw 日志积累校准数据。
 */
import type { BuddyReq } from "@napuketto/kernel";

/** BuddyReq 防御性收窄：仅接受字段形状可用的对象。 */
export function isBuddyReqLike(value: unknown): value is BuddyReq {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v["reqTime"] === "string" && typeof v["friendUid"] === "string";
}

/**
 * onBuddyReqChange 回调参数 → BuddyReq 列表（防御性收窄）。
 * 已知候选形状：BuddyReq[] / { buddyReqs: BuddyReq[] }；其余返回 null。
 */
export function narrowBuddyReqs(arg: unknown): BuddyReq[] | null {
    if (Array.isArray(arg)) {
        return arg.every(isBuddyReqLike) ? (arg as BuddyReq[]) : null;
    }
    if (typeof arg === "object" && arg !== null) {
        const reqs = (arg as Record<string, unknown>)["buddyReqs"];
        if (Array.isArray(reqs) && reqs.every(isBuddyReqLike)) {
            return reqs as BuddyReq[];
        }
    }
    return null;
}
