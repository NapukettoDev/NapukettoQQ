/**
 * session 解析（2026-08-05，wrapper 机制实测确认后）
 *
 * - getMainSession：startup.create → getSessionIdList → getNTWrapperSession(nt_x)
 *   （实测这些返回的 session 是空壳——核心 service 未 init，仅作参考）
 * - 真正可用的 session 是 `new wrapper.NodeIQQNTWrapperSession()` + init（见 lifecycle.ts）
 */

import type { NodeIQQNTWrapperSession } from "../types/index.js";
import type { WrapperContext } from "./wrapper-loader.js";

/** 从 getSessionIdList 的 Map 提取主 sessionId（nt_ 前缀优先）。 */
function findMainSessionId(ids: Map<unknown, unknown>): string | null {
    return firstStringId(ids, (s) => s.startsWith("nt_")) ?? firstStringId(ids, () => true);
}

/** 遍历 Map 找第一个满足谓词的字符串 id（值优先，其次键）。 */
function firstStringId(ids: Map<unknown, unknown>, pred: (s: string) => boolean): string | null {
    for (const [k, v] of ids) {
        if (typeof v === "string" && pred(v)) {
            return v;
        }
        if (typeof k === "string" && pred(k)) {
            return k;
        }
    }
    return null;
}

/** 通过 getNTWrapperSession 拿主 session（内部辅助）。 */
function resolveMainSession(
    created: { start?: () => void; getSessionIdList?: () => unknown },
    getNTWrapperSession: (id: string) => NodeIQQNTWrapperSession,
): NodeIQQNTWrapperSession | null {
    created.start?.();
    const ids = typeof created.getSessionIdList === "function" ? created.getSessionIdList() : null;
    if (!(ids instanceof Map)) {
        return null;
    }
    const mainId = findMainSessionId(ids);
    if (mainId === null) {
        return null;
    }
    const maybe = getNTWrapperSession(mainId) as NodeIQQNTWrapperSession | null | undefined;
    return maybe !== null && maybe !== undefined && typeof maybe.getMsgService === "function"
        ? maybe
        : null;
}

/**
 * 复用 QQ 已有 session（P1-4：QQ 已登录，直接拿单例避免重复 init）。
 * 优先 `NodeIQQNTWrapperSession.get()`；返回 null 时回退 createSession。
 *
 * @internal 仅供 probe 诊断参考，请勿在业务装配中直接调用（会写回 ctx.session）。
 */
export function getExistingSession(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    const got = trySessionGet(ctx);
    if (got !== null) {
        ctx.session = got;
        return got;
    }
    return null;
}

/** NodeIQQNTWrapperSession.get() 单例（无效/异常返回 null）。 */
function trySessionGet(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    try {
        const S = ctx.exports.NodeIQQNTWrapperSession as unknown as {
            get?: () => NodeIQQNTWrapperSession;
        };
        if (typeof S.get !== "function") {
            return null;
        }
        const got = S.get();
        return got && typeof got.getMsgService === "function" ? got : null;
    } catch {
        return null; // 复用失败，回退 create
    }
}

/**
 * 复用 QQ 主 session（P1-4 实测链路）：
 * `NodeIQQNTStartupSessionWrapper.create()` → `start()` → `getSessionIdList()`（Map
 * {nt:"nt_3", gpro:"gpro_3"}）→ `NodeIQQNTWrapperSession.getNTWrapperSession("nt_3")`。
 * 注：实测这些 session 是空壳（核心 service null），真正可用的是 new + init（lifecycle.ts）。
 *
 * @internal 仅供 probe 诊断参考，请勿在业务装配中直接调用（纯查询语义，不改写 ctx.session）。
 */
export function getMainSession(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    try {
        return resolveMainFromStartup(ctx) ?? null;
    } catch {
        return null; // 复用失败，回退 create
    }
}

/** startup.create → start → getSessionIdList → getNTWrapperSession 链路。 */
function resolveMainFromStartup(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    const startupRaw = ctx.exports.NodeIQQNTStartupSessionWrapper as unknown as {
        create?: () => { start?: () => void; getSessionIdList?: () => unknown } | null;
    };
    const sessionCtor = ctx.exports.NodeIQQNTWrapperSession as unknown as {
        getNTWrapperSession?: (id: string) => NodeIQQNTWrapperSession;
    };
    if (
        typeof startupRaw.create !== "function" ||
        typeof sessionCtor.getNTWrapperSession !== "function"
    ) {
        return null;
    }
    const created = startupRaw.create();
    if (!created) {
        return null;
    }
    const getSession = (id: string): NodeIQQNTWrapperSession =>
        (sessionCtor.getNTWrapperSession as (name: string) => NodeIQQNTWrapperSession)(id);
    // 纯查询语义：不把空壳主 session 写回 ctx.session（避免毒化调用方装配状态）。
    return resolveMainSession(created, getSession);
}
