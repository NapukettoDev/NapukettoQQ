/**
 * wrapper exports 探测（从 probe.ts 拆分，2026-08-08 FTA 优化）
 *
 * - probeExportCtors：关键 export 构造器方法面
 * - probeEngineCalls：engine 关键调用
 * - probeLoginService：LoginService 实例（QQ 已登录凭据入口）
 */

import { getOwnProp, hasCallableProp } from "../../infra/type-guards.js";
import type { WrapperContext } from "../wrapper/lifecycle.js";
import { serialize, tryShape } from "./probe-serialize.js";
import { listMethods, tryCall } from "./probe-utils.js";

/** 探测关键 export 构造器方法（get/create/getNTWrapperSession 等）。 */
export function probeExportCtors(ctx: WrapperContext): Record<string, unknown> {
    const keys = [
        "NodeIQQNTWrapperSession",
        "NodeIQQNTStartupSessionWrapper",
        "NodeQQNTWrapperUtil",
        "NodeIKernelLoginService",
        "NodeIQQNTWrapperEngine",
    ] as const;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        const ctor = getOwnProp(ctx.exports, key);
        if (ctor !== null && ctor !== undefined) {
            out[key] = { methods: listMethods(ctor), ownKeys: Object.getOwnPropertyNames(ctor) };
        }
    }
    return out;
}

/** 探测 engine 关键调用（getDeviceInfo / getECDHService / getThirdPartySigService）。 */
export function probeEngineCalls(ctx: WrapperContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of ENGINE_CALL_PROBES) {
        out[m] = probeEngineCall(ctx, m);
    }
    return out;
}

/** 探测单个 engine 方法调用（成功记录方法面/形状，失败记录错误）。 */
function probeEngineCall(ctx: WrapperContext, m: string): unknown {
    const call = tryCall(ctx.engine, m);
    return call.ok
        ? { value: serialize(call.value), methods: call.value ? listMethods(call.value) : [] }
        : { error: call.error ?? "null/undefined" };
}

/** engine 关键调用候选。 */
const ENGINE_CALL_PROBES = [
    "getDeviceInfo",
    "getECDHService",
    "getThirdPartySigService",
    "readyToShow",
] as const;

/** 探测 LoginService 实例（QQ 已登录凭据入口）。 */
export function probeLoginService(ctx: WrapperContext): Record<string, unknown> | null {
    const ctor = ctx.exports.NodeIKernelLoginService;
    if (!hasCallableProp(ctor, "get")) {
        return null;
    }
    const inst = tryCall(ctor, "get");
    if (!(inst.ok && inst.value)) {
        return { get: inst.error ?? "null/undefined" };
    }
    return {
        methods: listMethods(inst.value),
        ownKeys: Object.getOwnPropertyNames(inst.value).slice(0, 30),
        ...probeLoginGetters(inst.value),
    };
}

/** 尝试关键登录信息 getter（无参调用，探测形状）。 */
function probeLoginGetters(inst: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of LOGIN_GETTER_PROBES) {
        if (hasCallableProp(inst, m)) {
            out[m] = tryShape(inst, m);
        }
    }
    return out;
}

/** 登录信息 getter 候选（无参调用，探测形状）。 */
const LOGIN_GETTER_PROBES = [
    "getAccountInfo",
    "getLoginInfo",
    "getA2",
    "getTicket",
    "getUin",
    "getUid",
    "getSelfUin",
] as const;
