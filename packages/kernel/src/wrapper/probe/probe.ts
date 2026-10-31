/**
 * 运行时反射探测（ADR-006 落地，P1-4）
 *
 * 注入链路打通后（2026-08-05），wrapper exports 是 QQ 已注册的单例。
 * 本模块在 **QQ 主进程内**反射枚举 session / service 的真实方法名与返回形状，
 * 产出 JSON 到 NAPUTO_CFG_DIR/napuketto-probe.json，作为 types/services/ 的权威来源。
 *
 * 用法：boot.cjs 在 NAPUTO_PROBE=1 时于 startNapuketto 后调用 probeRuntime(ctx)。
 * 产物是研究工具数据，类型层据此补全（自研描述，非移植）。
 *
 * 工具拆分（2026-08-08 FTA 优化）：方法枚举/安全调用 → probe-utils.ts；
 * 序列化/形状探测 → probe-serialize.ts；exports/service 探测 → probe-services.ts；
 * 本文件只留 session 探测编排（probeStartup/probeSession/probeRuntime）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { getMainSession } from "../session-resolver.js";
import type { WrapperContext } from "../wrapper-loader.js";
import { serialize } from "./probe-serialize.js";
import { probeEngineCalls, probeExportCtors, probeLoginService } from "./probe-services.js";
import { isServiceGetter, listMethods, tryCall } from "./probe-utils.js";

/** 枚举候选 sessionId（nt_0..nt_9 / gpro_0..gpro_9）找 QQ 已 init 的 session。 */
function enumerateSessionIds(ctx: WrapperContext): Record<string, unknown> {
    const S = ctx.exports.NodeIQQNTWrapperSession;
    const enumFn = getNTWrapperSessionFn(ctx);
    if (enumFn === null) {
        return {};
    }
    const out: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) {
        probeSessionId(enumFn, S, `nt_${i}`, out);
        probeSessionId(enumFn, S, `gpro_${i}`, out);
    }
    return out;
}

/** 探测单个 sessionId（getter 存在性 + getMsgService 调用结果）。 */
function probeSessionId(
    enumFn: (...args: unknown[]) => unknown,
    thisCtx: unknown,
    id: string,
    out: Record<string, unknown>,
): void {
    try {
        const value = enumFn.call(thisCtx, id);
        if (!value) {
            return;
        }
        out[id] = probeSessionRecord(value);
    } catch {
        // 忽略单次失败
    }
}

/** 探测单个 session 记录（getter 存在性 + msgService 调用结果 + 方法面）。 */
function probeSessionRecord(value: unknown): Record<string, unknown> {
    const rec = value as Record<string, unknown>;
    const msg = tryMsgService(rec, value);
    return {
        hasMsgServiceGetter: typeof rec["getMsgService"] === "function",
        msgServiceOk: msg.service !== null,
        msgServiceMethods: msg.service ? listMethods(msg.service).length : 0,
        msgError: msg.error,
        methods: listMethods(value),
    };
}

/** 尝试调用 getMsgService（失败记录错误，成功返回实例）。 */
function tryMsgService(
    rec: Record<string, unknown>,
    thisCtx: unknown,
): { service: unknown; error: string | null } {
    try {
        const svc = (rec["getMsgService"] as () => unknown).call(thisCtx);
        return { service: svc ?? null, error: null };
    } catch (e) {
        return { service: null, error: e instanceof Error ? e.message : String(e) };
    }
}

/** 取 NodeIQQNTWrapperSession.getNTWrapperSession 函数（无则 null）。 */
function getNTWrapperSessionFn(ctx: WrapperContext): ((...args: unknown[]) => unknown) | null {
    const fn = (ctx.exports.NodeIQQNTWrapperSession as unknown as Record<string, unknown>)[
        "getNTWrapperSession"
    ];
    return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown) : null;
}

/** 探测 startup 实例：start() + getSessionIdList()，提取 sessionIds（Map 值或键）。 */
function probeStartupChain(created: unknown): {
    start: Record<string, unknown>;
    createdGetSessionIdList: Record<string, unknown>;
    sessionIds: string[];
} {
    const started = tryCall(created, "start");
    const ids = tryCall(created, "getSessionIdList");
    return {
        start: started.ok ? { ok: true } : { error: started.error },
        createdGetSessionIdList: ids.ok ? { value: serialize(ids.value) } : { error: ids.error },
        sessionIds: extractSessionIds(ids),
    };
}

/** 从 getSessionIdList 结果提取 sessionIds（Map 值或键优先）。 */
function extractSessionIds(ids: { ok: boolean; value?: unknown }): string[] {
    if (!(ids.ok && ids.value instanceof Map)) {
        return [];
    }
    return [...ids.value].map(([k, v]) => sessionIdOfEntry(k, v));
}

/** 单条 sessionIds 项（Map 值是字符串直接用，否则退化键名）。 */
function sessionIdOfEntry(k: unknown, v: unknown): string {
    return typeof v === "string" ? v : String(k);
}

/** session 实例方法面（空值记 null）。 */
function sessionFace(session: unknown): Record<string, unknown> | null {
    return session !== null && session !== undefined
        ? {
              methods: listMethods(session),
              ownKeys: Object.getOwnPropertyNames(session),
          }
        : null;
}

/** 未知异常 → 错误消息字符串。 */
function errMsgString(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** try getNTWrapperSession(id) → session 方法面（fn 缺失记 null，失败记 error）。 */
function trySessionFace(ctx: WrapperContext, id: string): unknown {
    const fn = getNTWrapperSessionFn(ctx);
    if (fn === null) {
        return null;
    }
    try {
        return sessionFace(fn.call(ctx.exports.NodeIQQNTWrapperSession, id));
    } catch (e) {
        return { error: errMsgString(e) };
    }
}

/** 用真实 sessionId 取主 session（getNTWrapperSession(nt_x)）并记录方法面。 */
function probeSessionById(ctx: WrapperContext, id: string): unknown {
    return trySessionFace(ctx, id);
}

/** 兜底：候选名字 getNTWrapperSession（无 Map 数据时）。 */
function probeByNameFallback(ctx: WrapperContext): Record<string, unknown> {
    const candidates = ["main", "primary", "session1", "default", ""];
    const getResults: Record<string, unknown> = {};
    for (const name of candidates) {
        getResults[name === "" ? "<empty>" : name] = probeSessionByName(ctx, name);
    }
    return getResults;
}

/** 探测单个候选名（getNTWrapperSession(name)，记录方法面或错误）。 */
function probeSessionByName(ctx: WrapperContext, name: string): unknown {
    return trySessionFace(ctx, name);
}

/** StartupSessionWrapper 可用性判定（缺 create 方法视为不可用）。 */
function startupWrapper(ctx: WrapperContext): { create?: () => unknown } | null {
    const startup = ctx.exports.NodeIQQNTStartupSessionWrapper as unknown as {
        create?: () => unknown;
    } | null;
    return startup === null || typeof startup.create !== "function" ? null : startup;
}

/** create() 调用结果面（成功记实例方法面 + 序列化值，失败记 error）。 */
function createFace(created: {
    ok: boolean;
    value?: unknown;
    error?: string;
}): Record<string, unknown> {
    return created.ok
        ? {
              methods: created.value ? listMethods(created.value) : [],
              value: serialize(created.value),
          }
        : { error: created.error };
}

/** create 成功时并入实例链探测结果。 */
function assignCreatedChain(
    out: Record<string, unknown>,
    ctx: WrapperContext,
    created: { ok: boolean; value?: unknown },
): void {
    if (created.ok && created.value) {
        Object.assign(out, probeCreatedChain(ctx, created.value));
    }
}

/** 无 Map 数据时并入候选名兜底结果。 */
function assignNameFallback(out: Record<string, unknown>, ctx: WrapperContext): void {
    if (out["sessionIds"] !== undefined) {
        return;
    }
    out["getNTWrapperSession"] = probeByNameFallback(ctx);
}

/** 探测 startup session 链路：create() → start() → getSessionIdList → getNTWrapperSession。 */
function probeStartup(ctx: WrapperContext): Record<string, unknown> | null {
    const startup = startupWrapper(ctx);
    if (startup === null) {
        return null;
    }
    const out: Record<string, unknown> = { staticMethods: listMethods(startup) };
    const created = tryCall(startup, "create");
    out["create"] = createFace(created);
    assignCreatedChain(out, ctx, created);
    out["enumSessionIds"] = enumerateSessionIds(ctx);
    // 无 Map 数据时兜底：候选名字
    assignNameFallback(out, ctx);
    return out;
}

/** 探测 create 后的实例链：start / getSessionIdList / 主 session。 */
function probeCreatedChain(ctx: WrapperContext, created: unknown): Record<string, unknown> {
    const chain = probeStartupChain(created);
    const out: Record<string, unknown> = {
        start: chain.start,
        createdGetSessionIdList: chain.createdGetSessionIdList,
        sessionIds: chain.sessionIds,
    };
    const mainId = findMainProbeId(chain.sessionIds);
    if (mainId !== undefined) {
        out["mainSessionId"] = mainId;
        out["mainSession"] = probeSessionById(ctx, mainId);
    }
    return out;
}

/** 选主 sessionId（nt_ 前缀优先，否则第一个）。 */
function findMainProbeId(sessionIds: string[]): string | undefined {
    return sessionIds.find((id) => id.startsWith("nt_")) ?? sessionIds[0];
}

/** 探测 session 与 service 方法名面。
 *  主目标 = ctx.session 快照（kernel 自建就绪 session），缺省回退 QQ 主 session；
 *  自建宿主下主 session 未被 init（get*Service 恒 null，2026-10-31 实测）。
 *  ⚠️ 先快照 ctx.session 再枚举主 session——getMainSession 有 P1-4 遗留副作用
 *  （resolveMainFromStartup 把空壳主 session 写回 ctx.session，session-resolver.ts）。
 *  ⚠️ names-only：不对服务实例做无参 shape 调用——活 session 上无参调原生方法
 *  = 访问违例 0xC0000005（2026-10-31 实测崩溃，tryShape 捕不住原生段错误）。 */
/** 非空判定（null / undefined 均视为缺省）。 */
function hasValue(value: unknown): boolean {
    return value !== null && value !== undefined;
}

function probeSession(ctx: WrapperContext, persist?: () => void): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const own = ctx.session;
    const main = tryMainSession(ctx);
    const primary = hasValue(own) ? own : main;
    out["sessionSource"] = hasValue(own) ? "own-create" : "mainSession";
    out["session"] = sessionFace(primary);
    assignServices(out, primary, persist);
    assignAlternates(out, own, main);
    return out;
}

/** 并入主目标的服务方法名面（主目标缺省时跳过）。 */
function assignServices(
    out: Record<string, unknown>,
    primary: unknown,
    persist?: () => void,
): void {
    if (!hasValue(primary)) {
        return;
    }
    out["services"] = collectServiceGetters(primary, persist);
}

/** 并入落选候选概要（仅主目标为自建 session 时记录主 session 方法数，诊断用）。 */
function assignAlternates(out: Record<string, unknown>, own: unknown, main: unknown): void {
    if (!hasValue(own) || !hasValue(main)) {
        return;
    }
    out["sessionAlternates"] = [
        {
            source: "mainSession(getNTWrapperSession)",
            methodCount: listMethods(main).length,
        },
    ];
}

/** QQ 主 session（getMainSession 有写回 ctx.session 的副作用——调用前须已快照）。 */
function tryMainSession(ctx: WrapperContext): unknown {
    try {
        return getMainSession(ctx);
    } catch {
        return null; // 主 session 枚举失败：只剩 own-create 候选
    }
}

/** 收集 session 的 get*Service 方法名面（names-only，不做 shape 无参调用）。
 *  每个服务完成即 persist 一次——活 session 上个别 getter 若触发原生崩溃，
 *  文件里留下最后一个成功项，精确定位肇事 getter。 */
function collectServiceGetters(session: unknown, persist?: () => void): Record<string, unknown> {
    const services: Record<string, unknown> = {};
    for (const getter of listMethods(session).filter(isServiceGetter)) {
        services[getter] = probeServiceGetter(session, getter);
        persist?.();
    }
    return services;
}

/** 探测单个 getter：成功记录方法名面（不调用服务方法），失败记录错误。 */
function probeServiceGetter(session: unknown, getter: string): unknown {
    const call = tryCall(session, getter);
    if (!(call.ok && call.value)) {
        return { error: call.error ?? "null/undefined", ok: call.ok };
    }
    return {
        methods: listMethods(call.value),
        ownKeys: Object.getOwnPropertyNames(call.value).slice(0, 20),
    };
}

/**
 * 探测 wrapper 运行时：dump session 方法与各 service 方法名到 JSON。
 * 返回探测结果对象；同时写文件（NAPUTO_CFG_DIR/<file>，默认 napuketto-probe.json）。
 * 服务枚举逐项增量落盘（persist）——活 session 上原生崩溃时文件保留断点。
 */
export function probeRuntime(
    ctx: WrapperContext,
    file = "napuketto-probe.json",
): Record<string, unknown> {
    const result: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        exports: listMethods(ctx.exports),
        engineMethods: listMethods(ctx.engine),
        exportCtors: probeExportCtors(ctx),
        engineCalls: probeEngineCalls(ctx),
        loginService: probeLoginService(ctx),
        startup: probeStartup(ctx),
    };
    const persist = (): void => writeProbeFile(result, file);
    Object.assign(result, probeSession(ctx, persist));
    writeProbeFile(result, file);
    return result;
}

/** 探测结果落盘（增量与最终共用；最终写入后记 probeFile 路径）。 */
function writeProbeFile(result: Record<string, unknown>, file: string): void {
    try {
        const dir = process.env["NAPUTO_CFG_DIR"] ?? process.cwd();
        mkdirSync(dir, { recursive: true });
        const full = join(dir, file);
        writeFileSync(full, JSON.stringify(result, null, 2), "utf8");
        result["probeFile"] = full;
    } catch (e) {
        result["probeFileError"] = errMsgString(e);
    }
}
