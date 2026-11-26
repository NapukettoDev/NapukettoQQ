/**
 * 运行时反射探测（ADR-006）：在 **QQ 主进程内**反射枚举 session / service 的真实方法名与返回
 * 形状，产出 JSON 到 NAPUKETTO_CFG_DIR/napuketto-probe.json，作为 types/services/ 的权威来源。
 * boot.cjs 在 NAPUKETTO_PROBE=1 时于 startNapuketto 后调用 probeRuntime(ctx)；产物是研究数据。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { errorMessage } from "../../infra/index.js";
import { hasCallableProp } from "../../infra/type-guards.js";
import type { WrapperContext } from "../wrapper/lifecycle.js";
import { getMainSession } from "../wrapper/session-resolver.js";
import { serialize } from "./probe-serialize.js";
import { probeEngineCalls, probeExportCtors, probeLoginService } from "./probe-services.js";
import { isServiceGetter, listMethods, tryCall } from "./probe-utils.js";

/** 单个 sessionId 的探测记录。 */
interface SessionProbeRecord {
    hasMsgServiceGetter: boolean;
    msgServiceOk: boolean;
    msgServiceMethods: number;
    msgError: string | null;
    methods: string[];
}

/** session / service 实例的方法面。 */
interface SessionFace {
    methods: string[];
    ownKeys: string[];
}

/** session 方法面探测结果（fn 缺失 = null，调用失败 = error）。 */
type SessionFaceProbe = SessionFace | { error: string } | null;

/** 单个 get*Service getter 的探测记录（成功 = 方法面，失败 = 错误）。 */
type ServiceGetterProbe = SessionFace | { error: string; ok: boolean };

/** startup 链（start / getSessionIdList / sessionIds）探测结果。 */
interface StartupProbeResult {
    start: { ok: true } | { error: string | undefined };
    createdGetSessionIdList: { value: unknown } | { error: string | undefined };
    sessionIds: string[];
}

/** create() 后的实例链探测结果（主 session 仅在拿到 sessionIds 时补充）。 */
interface CreatedChainProbe {
    start: StartupProbeResult["start"];
    createdGetSessionIdList: StartupProbeResult["createdGetSessionIdList"];
    sessionIds: string[];
    mainSessionId?: string;
    mainSession?: SessionFaceProbe;
}

/** startup session 探测记录（create + 实例链 + 候选名兜底）。 */
interface StartupProbe {
    staticMethods: string[];
    create?: { methods: string[]; value: unknown } | { error: string | undefined };
    enumSessionIds?: Record<string, SessionProbeRecord>;
    start?: StartupProbeResult["start"];
    createdGetSessionIdList?: StartupProbeResult["createdGetSessionIdList"];
    sessionIds?: string[];
    mainSessionId?: string;
    mainSession?: SessionFaceProbe;
    getNTWrapperSession?: Record<string, SessionFaceProbe>;
}

/** probeSession 结果（session 方法面与各 service getter 名面）。 */
interface SessionProbeResult {
    sessionSource: "own-create" | "mainSession";
    session: SessionFace | null;
    services?: Record<string, ServiceGetterProbe>;
    sessionAlternates?: Array<{ source: string; methodCount: number }>;
}

/** probeRuntime 结果（按相位逐步补充字段后落盘）。 */
interface ProbeRuntimeResult extends Record<string, unknown> {
    timestamp: string;
    exports: string[];
    engineMethods: string[];
    exportCtors: Record<string, unknown>;
    engineCalls: Record<string, unknown>;
    loginService: Record<string, unknown> | null;
    startup: StartupProbe | null;
}

/** 枚举候选 sessionId（nt_0..nt_9 / gpro_0..gpro_9）找 QQ 已 init 的 session。 */
function enumerateSessionIds(ctx: WrapperContext): Record<string, SessionProbeRecord> {
    const S = ctx.exports.NodeIQQNTWrapperSession;
    const enumFn = getNTWrapperSessionFn(ctx);
    if (enumFn === null) {
        return {};
    }
    const out: Record<string, SessionProbeRecord> = {};
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
    out: Record<string, SessionProbeRecord>,
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
function probeSessionRecord(value: unknown): SessionProbeRecord {
    const msg = tryMsgService(value);
    return {
        hasMsgServiceGetter: hasCallableProp(value, "getMsgService"),
        msgServiceOk: msg.service !== null,
        msgServiceMethods: msg.service ? listMethods(msg.service).length : 0,
        msgError: msg.error,
        methods: listMethods(value),
    };
}

/** 尝试调用 getMsgService（失败记录错误，成功返回实例）。 */
function tryMsgService(thisCtx: unknown): { service: unknown; error: string | null } {
    try {
        if (!hasCallableProp(thisCtx, "getMsgService")) {
            return { service: null, error: "missing getMsgService" };
        }
        const svc = thisCtx.getMsgService.call(thisCtx);
        return { service: svc ?? null, error: null };
    } catch (e) {
        return { service: null, error: errorMessage(e) };
    }
}

/** 取 NodeIQQNTWrapperSession.getNTWrapperSession 函数（无则 null）。 */
function getNTWrapperSessionFn(ctx: WrapperContext): ((...args: unknown[]) => unknown) | null {
    const ctor = ctx.exports.NodeIQQNTWrapperSession;
    if (hasCallableProp(ctor, "getNTWrapperSession")) {
        return ctor.getNTWrapperSession;
    }
    return null;
}

/** 探测 startup 实例：start() + getSessionIdList()，提取 sessionIds（Map 值或键）。 */
function probeStartupChain(created: unknown): StartupProbeResult {
    const started = tryCall(created, "start");
    const ids = tryCall(created, "getSessionIdList");
    return {
        start: started.ok ? { ok: true } : { error: started.error },
        createdGetSessionIdList: ids.ok ? { value: serialize(ids.value) } : { error: ids.error },
        sessionIds:
            ids.ok && ids.value instanceof Map
                ? [...ids.value].map(([k, v]) => (typeof v === "string" ? v : String(k)))
                : [],
    };
}

/** session 实例方法面（空值记 null）。 */
function sessionFace(session: unknown): SessionFace | null {
    return session !== null && session !== undefined
        ? {
              methods: listMethods(session),
              ownKeys: Object.getOwnPropertyNames(session),
          }
        : null;
}

/** try getNTWrapperSession(id) → session 方法面（fn 缺失记 null，失败记 error）。 */
function trySessionFace(ctx: WrapperContext, id: string): SessionFaceProbe {
    const fn = getNTWrapperSessionFn(ctx);
    if (fn === null) {
        return null;
    }
    try {
        return sessionFace(fn.call(ctx.exports.NodeIQQNTWrapperSession, id));
    } catch (e) {
        return { error: errorMessage(e) };
    }
}

/** 兜底：候选名字 getNTWrapperSession（无 Map 数据时）。 */
function probeByNameFallback(ctx: WrapperContext): Record<string, SessionFaceProbe> {
    const candidates = ["main", "primary", "session1", "default", ""];
    const getResults: Record<string, SessionFaceProbe> = {};
    for (const name of candidates) {
        getResults[name === "" ? "<empty>" : name] = trySessionFace(ctx, name);
    }
    return getResults;
}

/** 探测 startup session 链路：create() → start() → getSessionIdList → getNTWrapperSession。 */
function probeStartup(ctx: WrapperContext): StartupProbe | null {
    const startup = ctx.exports.NodeIQQNTStartupSessionWrapper;
    if (!hasCallableProp(startup, "create")) {
        return null;
    }
    const out: StartupProbe = { staticMethods: listMethods(startup) };
    const created = tryCall(startup, "create");
    out.create = created.ok
        ? {
              methods: created.value ? listMethods(created.value) : [],
              value: serialize(created.value),
          }
        : { error: created.error };
    if (created.ok && created.value) {
        Object.assign(out, probeCreatedChain(ctx, created.value));
    }
    out.enumSessionIds = enumerateSessionIds(ctx);
    // 无 Map 数据时兜底：候选名字
    if (out.sessionIds === undefined) {
        out.getNTWrapperSession = probeByNameFallback(ctx);
    }
    return out;
}

/** 探测 create 后的实例链：start / getSessionIdList / 主 session。 */
function probeCreatedChain(ctx: WrapperContext, created: unknown): CreatedChainProbe {
    const chain = probeStartupChain(created);
    const out: CreatedChainProbe = {
        start: chain.start,
        createdGetSessionIdList: chain.createdGetSessionIdList,
        sessionIds: chain.sessionIds,
    };
    const mainId = chain.sessionIds.find((id) => id.startsWith("nt_")) ?? chain.sessionIds[0];
    if (mainId !== undefined) {
        out.mainSessionId = mainId;
        out.mainSession = trySessionFace(ctx, mainId);
    }
    return out;
}

/**
 * 探测 session 与 service 方法名面。
 *  主目标 = ctx.session 快照（kernel 自建就绪 session），缺省回退 QQ 主 session；
 *  自建宿主下主 session 未被 init（get*Service 恒 null，实测）。
 *  ⚠️ 先快照 ctx.session 再枚举主 session——getMainSession 有遗留副作用
 *  （resolveMainFromStartup 把空壳主 session 写回 ctx.session，session-resolver.ts）。
 *  ⚠️ names-only：不对服务实例做无参 shape 调用——活 session 上无参调原生方法
 *  = 访问违例 0xC0000005（实测崩溃，tryShape 捕不住原生段错误）。
 */
function probeSession(ctx: WrapperContext, persist?: () => void): SessionProbeResult {
    const own = ctx.session;
    const main = tryMainSession(ctx);
    const hasOwn = own !== null && own !== undefined;
    const primary = hasOwn ? own : main;
    return {
        sessionSource: hasOwn ? "own-create" : "mainSession",
        session: sessionFace(primary),
        ...(primary !== null && primary !== undefined
            ? { services: collectServiceGetters(primary, persist) }
            : {}),
        ...(hasOwn && main !== null && main !== undefined
            ? {
                  sessionAlternates: [
                      {
                          source: "mainSession(getNTWrapperSession)",
                          methodCount: listMethods(main).length,
                      },
                  ],
              }
            : {}),
    };
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
function collectServiceGetters(
    session: unknown,
    persist?: () => void,
): Record<string, ServiceGetterProbe> {
    const services: Record<string, ServiceGetterProbe> = {};
    for (const getter of listMethods(session).filter(isServiceGetter)) {
        services[getter] = probeServiceGetter(session, getter);
        persist?.();
    }
    return services;
}

/** 探测单个 getter：成功记录方法名面（不调用服务方法），失败记录错误。 */
function probeServiceGetter(session: unknown, getter: string): ServiceGetterProbe {
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
 * 返回探测结果对象；同时写文件（NAPUKETTO_CFG_DIR/<file>，默认 napuketto-probe.json）。
 * 服务枚举逐项增量落盘（persist）——活 session 上原生崩溃时文件保留断点。
 */
export function probeRuntime(
    ctx: WrapperContext,
    file = "napuketto-probe.json",
): ProbeRuntimeResult {
    const result: ProbeRuntimeResult = {
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
function writeProbeFile(result: ProbeRuntimeResult, file: string): void {
    try {
        const dir = process.env["NAPUKETTO_CFG_DIR"] ?? process.cwd();
        mkdirSync(dir, { recursive: true });
        const full = join(dir, file);
        writeFileSync(full, JSON.stringify(result, null, 2), "utf8");
        result["probeFile"] = full;
    } catch (e) {
        result["probeFileError"] = errorMessage(e);
    }
}
