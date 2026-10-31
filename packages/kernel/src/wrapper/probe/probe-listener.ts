/**
 * listener 录制器（批次三前置探测，docs/protocols/milky.md §0.8.1、本包 design.md §10）
 *
 * 动机：无源事件缺的不是方法名而是回调证据——现有 bridge 只注册已知回调名，
 * 原生 listener 回调面之外的派发行为从未被观测。原理：原生 listener 是普通
 * JS 对象 + NAPI 按名反射回调（MsgBridge 模式），用 Proxy get 陷阱构造万能
 * 监听器，原生调什么记什么，不需要预先知道回调名。
 *
 * 开关：NAPUTO_LISTENER_RECORD=1（loader bootstrap 挂起，位置与 runProbePhase 相邻）。
 * 产物：NAPUTO_CFG_DIR/napuketto-listener-record.jsonl（JSONL 追加，注册过程
 * 逐行落盘，原生崩溃保留断点定位肇事服务）。
 *
 * 安全边界：记录函数只序列化入参后回调 onEvent，绝不反向调用原生；录制器与
 * 业务 bridge 并存（addKernelXListener 多监听各自独立 id），不干扰协议链路。
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { WrapperContext } from "../wrapper-loader.js";
import { serialize } from "./probe-serialize.js";
import { listMethods } from "./probe-utils.js";

/** 录制事件（JSONL 一行）。 */
export interface ListenerRecordEvent {
    /** ISO 时间戳。 */
    ts: string;
    /** 服务简称（Msg / Group / …；LoginService 例外，来自 exports 单例）。 */
    service: string;
    /** 回调名；陷阱观测用合成事件 `<get>` / `<has>` / `<ownKeys>` / `<registered>`。 */
    event: string;
    /** 回调入参（截断序列化）或注册附加信息。 */
    args: unknown[];
}

/** 录制结果摘要（bootstrap 日志用）。 */
export interface ListenerRecordingResult {
    /** jsonl 产物绝对路径。 */
    file: string;
    /** 逐服务注册结果（ok=listenerId / error / null=服务 getter 返回空）。 */
    registered: Record<string, { ok: boolean; listenerId?: number; error?: string | null }>;
}

/** 默认仪器面：与 5 个无源事件 + sysmsg 样本采集相关的 listener 服务（design.md §10）。 */
const INSTRUMENTED_SERVICE_GETTERS = [
    "getMsgService",
    "getGroupService",
    "getRecentContactService",
    "getBdhUploadService",
    "getOnlineStatusService",
    "getLockService",
    "getFileAssistantService",
    "getBuddyService",
    "getProfileLikeService",
    "getNodeMiscService",
] as const;

/** 服务 getter 前缀 / 后缀（getMsgService → Msg）。 */
const GETTER_PREFIX_RE = /^get/;
const SERVICE_SUFFIX_RE = /Service$/;
/** listener 注册 / 注销方法名（addKernelMsgListener / 裸 addListener 同规则）。 */
const ADD_LISTENER_RE = /^add(Kernel)?\w*Listener$/;
const REMOVE_LISTENER_RE = /^remove(Kernel)?\w*Listener$/;

/** 服务简称（getMsgService → Msg；getBdhUploadService → BdhUpload）。 */
function serviceShortName(getter: string): string {
    return getter.replace(GETTER_PREFIX_RE, "").replace(SERVICE_SUFFIX_RE, "");
}

/** 从服务方法面选 listener 注册方法（addKernelMsgListener / 裸 addListener 同规则）。 */
function findAddMethod(service: unknown): string | null {
    const match = listMethods(service).find((m) => ADD_LISTENER_RE.test(m));
    return match ?? null;
}

/** 从服务方法面选 listener 注销方法（缺失允许——录制器不主动注销）。 */
function findRemoveMethod(service: unknown): string | null {
    const match = listMethods(service).find((m) => REMOVE_LISTENER_RE.test(m));
    return match ?? null;
}

/**
 * 构造万能监听器：Proxy get 陷阱对任意字符串属性返回记录函数（同时记录原生
 * 查过的名字，即使从未调用）；has / ownKeys 也记录（判定原生按名 Get 还是
 * 枚举发现回调）；非字符串键（Symbol，如 util.inspect 触发）放行默认行为。
 */
export function createRecordingListener(
    service: string,
    onEvent: (record: ListenerRecordEvent) => void,
): object {
    const record = (event: string, args: unknown[]): void => {
        onEvent({ ts: new Date().toISOString(), service, event, args });
    };
    // 空目标：所有属性访问走陷阱（ownKeys 为空是刻意的——若原生以枚举发现回调，
    // <ownKeys> 记录立即暴露该行为，fallback 预置已知回调名全集后重录）。
    return new Proxy({} as Record<string, unknown>, {
        get(target, prop, receiver): unknown {
            if (typeof prop !== "string") {
                return Reflect.get(target, prop, receiver);
            }
            record("<get>", [prop]);
            return (...args: unknown[]) => {
                record(
                    prop,
                    [...args].map((a) => serialize(a)),
                );
            };
        },
        has(_target, prop): boolean {
            if (typeof prop === "string") {
                record("<has>", [prop]);
            }
            return true;
        },
        ownKeys(): string[] {
            record("<ownKeys>", []);
            return [];
        },
    });
}

/**
 * 启动 listener 录制：session 十服务 + LoginService（exports 单例）逐服务注册
 * 万能监听器，JSONL 逐行追加。返回摘要；文件路径写入结果（bootstrap 日志用）。
 *
 * ⚠️ 调用时序约束：必须在任何探测（probeRuntime / getMainSession）之前调用——
 * resolveMainFromStartup 会把空壳主 session 写回 ctx.session（session-resolver.ts），
 * 空壳的 service getter 函数仍在但调用返回 null（late probe 61/63 null 的根因）。
 */
export function startListenerRecording(
    ctx: WrapperContext,
    file = "napuketto-listener-record.jsonl",
): ListenerRecordingResult {
    const dir = process.env["NAPUTO_CFG_DIR"] ?? process.cwd();
    mkdirSync(dir, { recursive: true });
    const full = join(dir, file);
    // JSONL 语义：本次录制起全新文件（截断），此后逐行 append（崩溃保留断点）
    writeFileSync(full, "", "utf8");
    const emit = (record: ListenerRecordEvent): void => {
        try {
            appendFileSync(full, `${JSON.stringify(record)}\n`, "utf8");
        } catch {
            // 落盘失败不中断录制（录制器是观测工具，不允许拖垮宿主）
        }
    };
    const registered: ListenerRecordingResult["registered"] = {};
    const session = ctx.session as Record<string, unknown> | null;
    if (session !== null && session !== undefined) {
        for (const getter of INSTRUMENTED_SERVICE_GETTERS) {
            registered[serviceShortName(getter)] = recordService(session, getter, emit);
        }
    }
    registered["Login"] = recordLoginService(ctx, emit);
    return { file: full, registered };
}

/** 对单个服务注册万能监听器（getter 失败/null/无 add 方法均记录原因）。 */
function recordService(
    session: Record<string, unknown>,
    getter: string,
    emit: (record: ListenerRecordEvent) => void,
): ListenerRecordingResult["registered"][string] {
    const name = serviceShortName(getter);
    try {
        const fn = session[getter];
        if (typeof fn !== "function") {
            return { ok: false, error: `getter 缺失（typeof=${typeof fn}）` };
        }
        const service = (fn as () => unknown).call(session);
        if (service === null || service === undefined) {
            return { ok: false, error: "null/undefined" };
        }
        return attachRecordingListener(name, service, emit);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/** LoginService 单例录制（NodeIKernelLoginService.get()，bot_offline 候选源）。 */
function recordLoginService(
    ctx: WrapperContext,
    emit: (record: ListenerRecordEvent) => void,
): ListenerRecordingResult["registered"][string] {
    const ctor = (ctx.exports as unknown as Record<string, unknown>)["NodeIKernelLoginService"] as
        | { get?: () => unknown }
        | null
        | undefined;
    try {
        if (ctor === null || ctor === undefined || typeof ctor.get !== "function") {
            return { ok: false, error: "NodeIKernelLoginService.get 缺失" };
        }
        const service = ctor.get();
        if (service === null || service === undefined) {
            return { ok: false, error: "null/undefined" };
        }
        return attachRecordingListener("Login", service, emit);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/** 在服务实例上挂万能监听器（add 方法自动选取；注册事件即行落盘）。 */
function attachRecordingListener(
    name: string,
    service: unknown,
    emit: (record: ListenerRecordEvent) => void,
): ListenerRecordingResult["registered"][string] {
    const addMethod = findAddMethod(service);
    if (addMethod === null) {
        return { ok: false, error: "无 add*Listener 方法" };
    }
    const add = (service as Record<string, unknown>)[addMethod];
    if (typeof add !== "function") {
        return { ok: false, error: `${addMethod} 非函数` };
    }
    const listener = createRecordingListener(name, emit);
    const listenerId = (add as (...args: unknown[]) => unknown).call(service, listener) as
        | number
        | null
        | undefined;
    emit({
        ts: new Date().toISOString(),
        service: name,
        event: "<registered>",
        args: [
            {
                addMethod,
                removeMethod: findRemoveMethod(service),
                listenerId: serialize(listenerId),
            },
        ],
    });
    return { ok: true, ...(typeof listenerId === "number" ? { listenerId } : {}) };
}
