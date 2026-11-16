/**
 * session.ts：session 选择与就绪探测（2026-08-07 阶段 1 从 boot-bootstrap.js 拆分，
 * 阶段 2 TS 化，零语义改动）。
 *
 * 职责：候选 session 收集（QQ 主 session → vehicle 激活 session → get() → qqSession）、
 * 最佳 session 选择（READY 优先）、session 有效性判断、就绪探测（5s 间隔定时器）。
 * 由 bootstrap.ts import（纯函数，无状态）。
 */

import type { CoreContextLike, KernelLike } from "../types.js";
import { errMsg, log, type SharedState } from "../util.js";

/** 候选 session 项。 */
export interface SessionCandidate {
    s: unknown;
    tag: string;
}

/** NodeIQQNTWrapperSession 的最小面（单例表 / 会话工厂，NAPI 反射实证）。 */
export interface WrapperSessionStaticLike {
    get?(): unknown;
    getNTWrapperSession?(key: string): unknown;
    create?(): unknown;
}

/** 对象有效性判断：getMsgService() 调用不抛断言（cpp_impl 已激活）。
 * 与 isSessionUsable 的区别：这里允许返回 null（未 init 但对象有效）。 */
function isSessionObjectValid(s: unknown): boolean {
    if (!s) return false;
    try {
        (s as { getMsgService(): unknown }).getMsgService();
        return true;
    } catch {
        return false;
    }
}

/** session 可用性判断：getMsgService() 可调且非 null（核心 service 已挂载）。 */
export function isSessionUsable(s: unknown): boolean {
    if (!s) return false;
    try {
        const svc = (s as { getMsgService(): unknown }).getMsgService();
        return svc !== null && svc !== undefined;
    } catch {
        return false;
    }
}

/** 描述单个 session 对象（探测日志用；无效对象返回带断言信息的占位）。 */
function describeSession(s: unknown): string {
    if (!s) {
        return "null";
    }
    try {
        const sess = s as { getSessionId?(): unknown; getMsgService?(): unknown };
        const id = typeof sess.getSessionId === "function" ? String(sess.getSessionId()) : "?";
        const svc = typeof sess.getMsgService === "function" ? sess.getMsgService() : null;
        return `id=${id} msgSvc=${svc !== null && svc !== undefined ? "READY" : "null"}`;
    } catch (e) {
        return `id=? msgSvc=断言(${errMsg(e).slice(0, 60)})`;
    }
}

/** 非空候选才追加探测描述。 */
function pushProbe(out: string[], label: string, candidate: unknown): void {
    if (candidate) {
        out.push(`${label}[${describeSession(candidate)}]`);
    }
}

/** session 就绪探测（5s 间隔，60s 上限）——观察 qqSession / get() 状态。 */
export function startSessionProbe(
    state: SharedState,
    _ctx: CoreContextLike,
    durationMs = 60000,
): NodeJS.Timeout {
    const sessionProbe = setInterval(() => {
        try {
            const S2 = state.wrapperExports?.["NodeIQQNTWrapperSession"] as
                | WrapperSessionStaticLike
                | undefined;
            const out: string[] = [];
            const qqSession = state.qqSession as { getMsgService?: unknown } | null | undefined;
            if (qqSession && typeof qqSession.getMsgService === "function") {
                pushProbe(out, "qqSession", qqSession);
            }
            if (S2 && typeof S2.get === "function") {
                pushProbe(out, "get()", S2.get());
            }
            if (S2 && typeof S2.getNTWrapperSession === "function") {
                pushProbe(out, 'getNT("Session")', S2.getNTWrapperSession("Session"));
            }
            log(`BOOT: session 探测: ${out.join(" | ")}`);
        } catch (e) {
            log(`BOOT: session 探测失败: ${errMsg(e)}`);
        }
    }, 5000);
    // 探测定时器不阻塞进程自然退出
    sessionProbe.unref?.();
    const cleanupTimer = setTimeout(() => clearInterval(sessionProbe), durationMs);
    cleanupTimer.unref?.();
    return sessionProbe;
}

/** 探测 session 方法面（NAPI 反射，验证 startNT/init 等关键方法）。 */
export function probeSessionMethods(ctx: CoreContextLike): void {
    try {
        const s = ctx.session as Record<string, unknown> | null | undefined;
        if (s) {
            const names = [
                ...Object.getOwnPropertyNames(Object.getPrototypeOf(s) ?? {}),
                ...Object.keys(s),
            ];
            log(`bootstrap: session methods(${names.length}): ${[...new Set(names)].join(", ")}`);
            log(
                `bootstrap: session.init=${typeof s["init"]} startNT=${typeof s["startNT"]} getMsgService=${typeof s["getMsgService"]}`,
            );
        }
    } catch (e) {
        log(`bootstrap: session 探测失败: ${errMsg(e)}`);
    }
}

/** 收集候选 session（按优先级：QQ 主 session → vehicle 激活 session → get() → qqSession）。 */
export function collectCandidateSessions(
    state: SharedState,
    kernel: KernelLike,
    ctx: CoreContextLike,
): SessionCandidate[] {
    const candidates: SessionCandidate[] = [];
    const S2 = state.wrapperExports?.["NodeIQQNTWrapperSession"] as
        | WrapperSessionStaticLike
        | undefined;
    // A: QQ 主 session（startup 链路 getSessionIdList → getNTWrapperSession(nt_x)），
    //    渲染进程已 init → 大概率 READY（kernel session-resolver.ts 实测链路）。
    try {
        if (typeof kernel.getMainSession === "function") {
            const ms = kernel.getMainSession(ctx);
            if (ms) candidates.push({ s: ms, tag: "getMainSession(nt_x)" });
        }
    } catch (e) {
        log(`bootstrap: getMainSession 失败: ${errMsg(e)}`);
    }
    // B: vehicle 激活的 session（注册 key="Session"，对象有效但未 init）
    try {
        if (S2 && typeof S2.getNTWrapperSession === "function") {
            const got = S2.getNTWrapperSession("Session");
            if (got) candidates.push({ s: got, tag: "getNT(Session)" });
        }
    } catch (e) {
        log(`bootstrap: getNTWrapperSession 失败: ${errMsg(e)}`);
    }
    // C: get()（单例表默认项）
    try {
        if (S2 && typeof S2.get === "function") {
            const got = S2.get();
            if (got) candidates.push({ s: got, tag: "get()" });
        }
    } catch (e) {
        log(`bootstrap: get() 失败: ${errMsg(e)}`);
    }
    // D: Proxy 捕获的 QQ session（V1 兼容）
    if (state.qqSession) candidates.push({ s: state.qqSession, tag: "qqSession" });
    return candidates;
}

/** 从候选里选最佳 session：优先有效对象，且 READY（msgSvc 非 null）优先。 */
export function pickBestSession(candidates: SessionCandidate[]): SessionCandidate | null {
    let bestValid: SessionCandidate | null = null;
    for (const c of candidates) {
        const ready = isSessionUsable(c.s);
        const valid = isSessionObjectValid(c.s);
        log(`bootstrap: 候选 ${c.tag}: valid=${valid} msgSvc=${ready ? "READY" : "null/断言"}`);
        if (valid && bestValid === null) bestValid = c;
        if (ready) return c; // READY 直接用
    }
    return bestValid;
}
