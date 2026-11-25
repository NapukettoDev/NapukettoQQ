/**
 * session 解析（2026-08-05，wrapper 机制实测确认后）
 *
 * - getMainSession：startup.create → getSessionIdList → getNTWrapperSession(nt_x)
 *   （实测这些返回的 session 是空壳——核心 service 未 init，仅作参考）
 * - 真正可用的 session 是 `new wrapper.NodeIQQNTWrapperSession()` + init（见 lifecycle.ts）
 *
 * Step 2：所有 exports / 实例均经 wrapper-guards 运行时守卫收窄，零 `as` 断言。
 */

import { hasCallableProp } from "../../infra/type-guards.js";
import type { NodeIQQNTWrapperSession } from "../../types/index.js";
import type { WrapperContext } from "./lifecycle.js";
import { isWrapperSession } from "./wrapper-guards.js";

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
    created: unknown,
    getNTWrapperSession: (id: string) => unknown,
): NodeIQQNTWrapperSession | null {
    if (hasCallableProp(created, "start")) {
        created.start();
    }
    const ids = hasCallableProp(created, "getSessionIdList") ? created.getSessionIdList() : null;
    if (!(ids instanceof Map)) {
        return null;
    }
    const mainId = findMainSessionId(ids);
    if (mainId === null) {
        return null;
    }
    const maybe = getNTWrapperSession(mainId);
    return isWrapperSession(maybe) ? maybe : null;
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
        const sessionCtor = ctx.exports.NodeIQQNTWrapperSession;
        if (!hasCallableProp(sessionCtor, "get")) {
            return null;
        }
        const got = sessionCtor.get();
        return isWrapperSession(got) ? got : null;
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
        return resolveMainFromStartup(ctx);
    } catch {
        return null; // 复用失败，回退 create
    }
}

/** startup.create → start → getSessionIdList → getNTWrapperSession 链路。 */
function resolveMainFromStartup(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    const startupCtor = ctx.exports.NodeIQQNTStartupSessionWrapper;
    const sessionCtor = ctx.exports.NodeIQQNTWrapperSession;
    if (
        !hasCallableProp(startupCtor, "create") ||
        !hasCallableProp(sessionCtor, "getNTWrapperSession")
    ) {
        return null;
    }
    const created = startupCtor.create();
    if (created === null || created === undefined) {
        return null;
    }
    // 纯查询语义：不把空壳主 session 写回 ctx.session（避免毒化调用方装配状态）。
    return resolveMainSession(created, (id) => sessionCtor.getNTWrapperSession(id));
}
