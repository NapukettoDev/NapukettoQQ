/**
 * diagnostics.ts：显式启用的 IPC 诊断动作（默认不注册）。
 *
 * 安全边界（H-01）：
 *  - 常规动作表不含 `diag.*`；只有 `NAPUKETTO_DIAG=1` / `LaunchOptions.diagnostics`
 *    显式开启时才注册，避免外部驱动无意触达原生反射面。
 *  - 每个目标只接受固定方法 allowlist（`__methods` + 诊断必要的少量方法），参数数量有上限；
 *    未知、危险或不在列表的方法直接拒绝。
 *  - `diag.richMediaTmpPaths` 只读枚举，不再触发 setters 等副作用；更激进的实验应使用
 *    kernel 自己的探针原语，不扩大 IPC 面。
 */
import {
    getErrorMessage,
    getOwnProp,
    hasCallableProp,
    isCallable,
    isRecord,
} from "../../shared/type-guards.js";

/** 诊断上下文（由 IPC 装配注入；未注入的目标返回可读错误）。 */
export interface IpcDiagnosticContext {
    /** wrapper session（枚举/触发原生服务方法面）。 */
    session?: unknown;
    /** wrapper engine（initLog 等初始化方法验证）。 */
    engine?: unknown;
    /** NodeQQNTWrapperUtil（原生 copyFile 验证富媒体文件放置）。 */
    util?: unknown;
}

/** 诊断动作处理函数（与 IpcActionHandler 同构）。 */
export type DiagnosticActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** 单个反射调用的参数上限（IPC 行本身另有 16 MiB 物理行限制）。 */
const MAX_DIAGNOSTIC_ARGS = 8;
/** 方法名长度上限（防御异常长字符串进入日志/反射）。 */
const MAX_METHOD_NAME_LENGTH = 128;
/** `__methods` 返回的方法名上限（原生服务方法面通常远小于此值）。 */
const MAX_METHOD_LIST = 256;

/**
 * 每个诊断目标的允许方法。全部是诊断/读路径；setter 与登录信号类方法不在列表内。
 * `__methods` 单独处理（只枚举名字，不调用）。
 */
const ALLOWED_METHODS = {
    session: new Set(["__methods"]),
    engine: new Set(["initLog", "__methods"]),
    msgService: new Set([
        "downloadRichMedia",
        "getRichMediaElement",
        "getRichMediaFilePathForGuild",
        "getLatestDbMsgs",
        "getMsgsByMsgId",
        "getMsgs",
        "__methods",
    ]),
    richMediaService: new Set([
        "downloadRichMediaInVisit",
        "downloadFileForFileUuid",
        "downloadFileByUrl",
        "downloadFileForFileInfo",
        "downloadFile",
        "onlyDownloadFile",
        "uploadRMFileWithoutMsg",
        "__methods",
    ]),
    flashTransferService: new Set(["getFileSetIdByCode", "__methods"]),
    util: new Set(["copyFile", "__methods"]),
} as const;

/** 诊断动作名（测试与调用方对表用；不在默认动作表中）。 */
export const DIAGNOSTIC_ACTION_NAMES = [
    "diag.richMediaTmpPaths",
    "diag.flashCall",
    "diag.sessionCall",
    "diag.engineCall",
    "diag.richMediaCall",
    "diag.msgServiceCall",
    "diag.utilCall",
] as const;

/** 安全枚举方法名（own + 原型去重、去空、限长、限数量）。 */
function methodNamesOf(obj: unknown): string[] {
    if ((typeof obj !== "object" && typeof obj !== "function") || obj === null) {
        return [];
    }
    const own = Object.getOwnPropertyNames(obj);
    const proto: unknown = Object.getPrototypeOf(obj);
    const protoKeys = isRecord(proto) ? Object.getOwnPropertyNames(proto) : [];
    const out: string[] = [];
    for (const name of new Set([...own, ...protoKeys])) {
        if (name !== "" && name.length <= MAX_METHOD_NAME_LENGTH) {
            out.push(name);
        }
        if (out.length >= MAX_METHOD_LIST) {
            break;
        }
    }
    return out;
}

/** 诊断调用校验结果：ok=true 表示可执行，ok=false 直接返回 value。 */
type DiagnosticCall = { ok: true; method: string; args: unknown[] } | { ok: false; value: unknown };

/** 校验目标 / 方法名 / allowlist / 参数数量（不做实际调用）。 */
function validateDiagnosticCall(
    obj: unknown,
    params: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): DiagnosticCall {
    if ((typeof obj !== "object" && typeof obj !== "function") || obj === null) {
        return { ok: false, value: { error: "target object is not a record" } };
    }
    const method = typeof params["method"] === "string" ? params["method"] : "";
    if (method === "") {
        return { ok: false, value: { error: "缺 method" } };
    }
    if (method.length > MAX_METHOD_NAME_LENGTH) {
        return {
            ok: false,
            value: { error: `method 过长（上限 ${MAX_METHOD_NAME_LENGTH}）` },
        };
    }
    if (!allowed.has(method)) {
        return { ok: false, value: { ok: false, error: `诊断方法不在允许列表: ${method}` } };
    }
    if (method === "__methods") {
        return { ok: false, value: { methods: methodNamesOf(obj) } };
    }
    const args = Array.isArray(params["args"]) ? params["args"] : [];
    if (args.length > MAX_DIAGNOSTIC_ARGS) {
        return { ok: false, value: { error: `args 数量超限（上限 ${MAX_DIAGNOSTIC_ARGS}）` } };
    }
    return { ok: true, method, args };
}

/**
 * 按方法名 + 参数数组调用对象方法（返回结构化结果，不抛）。
 * @param allowed 目标允许的方法集合；未命中直接拒绝。
 */
async function callDiagnosticMethod(
    obj: unknown,
    params: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): Promise<unknown> {
    const call = validateDiagnosticCall(obj, params, allowed);
    if (!call.ok) {
        return call.value;
    }
    const fn = getOwnProp(obj, call.method);
    if (!isCallable(fn)) {
        return { error: `方法不存在: ${call.method}` };
    }
    try {
        const result = await fn.apply(obj, call.args);
        return { ok: true, ret: result };
    } catch (err) {
        return { ok: false, err: getErrorMessage(err) };
    }
}

/** 诊断：枚举富媒体临时路径（固定 0 参方法；只读，不触发 side effect）。 */
async function enumerateTmpPaths(svc: unknown): Promise<Record<string, unknown>> {
    const tmp: Record<string, unknown> = {};
    for (const name of [
        "getPicTmpPath",
        "getRichMeidaTmpPath",
        "getPttTmpPath",
        "getVideoTmpPath",
        "getFileTmpPath",
        "getTransferingTmpPath",
    ]) {
        const fn = getOwnProp(svc, name);
        if (isCallable(fn)) {
            try {
                tmp[name] = await fn.call(svc);
            } catch (err) {
                tmp[name] = `调用失败: ${getErrorMessage(err)}`;
            }
        } else {
            tmp[name] = "方法缺失";
        }
    }
    return tmp;
}

/** 诊断主流程：session → 富媒体服务 + 闪传服务的方法面与临时路径（只读）。 */
async function runRichMediaDiag(session: unknown): Promise<Record<string, unknown>> {
    if (session === undefined || session === null) {
        return { error: "session 未注入（IPC 上下文缺 session）" };
    }
    const out: Record<string, unknown> = {};
    const svc = hasCallableProp(session, "getRichMediaService")
        ? session.getRichMediaService()
        : null;
    if (svc !== null && svc !== undefined) {
        out["richMediaTmpPaths"] = await enumerateTmpPaths(svc);
        out["richMediaMethods"] = methodNamesOf(svc);
    } else {
        out["richMediaService"] = "null";
    }
    const flash = hasCallableProp(session, "getFlashTransferService")
        ? session.getFlashTransferService()
        : null;
    if (flash !== null && flash !== undefined) {
        out["flashMethods"] = methodNamesOf(flash);
    } else {
        out["flashService"] = "null";
    }
    return out;
}

/** 取 session 上的服务（getter 缺失 / 返回 null 时给出可读错误）。 */
function serviceOf(
    session: unknown,
    getter: "getRichMediaService" | "getMsgService" | "getFlashTransferService",
    label: string,
): { ok: true; target: unknown } | { ok: false; error: string } {
    if (!hasCallableProp(session, getter)) {
        return { ok: false, error: "session 未注入" };
    }
    const target = session[getter]();
    if (target === null || target === undefined) {
        return { ok: false, error: `${label} 服务为 null` };
    }
    return { ok: true, target };
}

/** 注册全部诊断动作（调用方负责仅在显式调试开关开启时调用）。 */
export function registerDiagnosticActions(
    actions: Map<string, DiagnosticActionHandler>,
    ctx: IpcDiagnosticContext,
): void {
    actions.set("diag.richMediaTmpPaths", async () => runRichMediaDiag(ctx.session));

    actions.set("diag.flashCall", async (params) => {
        const flash = serviceOf(ctx.session, "getFlashTransferService", "flash");
        if (!flash.ok) {
            return { error: flash.error };
        }
        return callDiagnosticMethod(flash.target, params, ALLOWED_METHODS.flashTransferService);
    });

    actions.set("diag.sessionCall", async (params) => {
        if (ctx.session === undefined) {
            return { error: "session 未注入" };
        }
        return callDiagnosticMethod(ctx.session, params, ALLOWED_METHODS.session);
    });

    actions.set("diag.engineCall", async (params) => {
        if (ctx.engine === undefined) {
            return { error: "engine 未注入" };
        }
        return callDiagnosticMethod(ctx.engine, params, ALLOWED_METHODS.engine);
    });

    actions.set("diag.richMediaCall", async (params) => {
        const svc = serviceOf(ctx.session, "getRichMediaService", "richMedia");
        if (!svc.ok) {
            return { error: svc.error };
        }
        return callDiagnosticMethod(svc.target, params, ALLOWED_METHODS.richMediaService);
    });

    actions.set("diag.msgServiceCall", async (params) => {
        const svc = serviceOf(ctx.session, "getMsgService", "msgService");
        if (!svc.ok) {
            return { error: svc.error };
        }
        return callDiagnosticMethod(svc.target, params, ALLOWED_METHODS.msgService);
    });

    actions.set("diag.utilCall", async (params) => {
        const util = ctx.util;
        if (util === undefined || util === null) {
            return { error: "util 未注入" };
        }
        const instance = hasCallableProp(util, "get") ? util.get() : util;
        if (instance === null || instance === undefined) {
            return { error: "util 实例为 null" };
        }
        return callDiagnosticMethod(instance, params, ALLOWED_METHODS.util);
    });
}
