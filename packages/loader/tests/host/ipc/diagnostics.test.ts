/**
 * diagnostics.test.ts：IPC 诊断模块（`registerDiagnosticActions`）的独立单测。
 *
 * 直接对注册出的 handler 断言（不经 `createIpcActions`）；动作表注册启停与
 * toPeer / 消息动作边界见 actions-branches.test.ts。覆盖：
 *  - 目标未注入 / 服务 getter 缺失或返回 null 的可读错误；
 *  - 各目标 allowlist（外拒、内通、缺方法）、`__methods` 枚举（own + 原型去重、
 *    方法名 128 上限、列表 256 上限）；
 *  - method / args 参数边界与方法抛错的结构化结果；
 *  - `diag.richMediaTmpPaths` 只读枚举（成功 / 抛错 / 缺失三分支，不触发 setter）。
 */
import { describe, expect, it, vi } from "vitest";
import {
    DIAGNOSTIC_ACTION_NAMES,
    type DiagnosticActionHandler,
    type IpcDiagnosticContext,
    registerDiagnosticActions,
} from "../../../src/host/ipc/diagnostics.js";
import { isRecord } from "../../../src/shared/type-guards.js";

type DiagnosticActionName = (typeof DIAGNOSTIC_ACTION_NAMES)[number];

/** `enumerateTmpPaths` 固定枚举的 6 个 0 参方法（与 diagnostics.ts 对表）。 */
const TMP_PATH_METHODS = [
    "getPicTmpPath",
    "getRichMeidaTmpPath",
    "getPttTmpPath",
    "getVideoTmpPath",
    "getFileTmpPath",
    "getTransferingTmpPath",
];

/** 注册诊断动作并返回动作表（被测入口就是 registerDiagnosticActions）。 */
function diagActionsOf(ctx: IpcDiagnosticContext): Map<string, DiagnosticActionHandler> {
    const actions = new Map<string, DiagnosticActionHandler>();
    registerDiagnosticActions(actions, ctx);
    return actions;
}

/** 取已注册的诊断 handler；缺失直接抛错，避免断言在 undefined 上空转。 */
function handlerOf(
    actions: Map<string, DiagnosticActionHandler>,
    name: DiagnosticActionName,
): DiagnosticActionHandler {
    const handler = actions.get(name);
    if (handler === undefined) {
        throw new Error(`未注册诊断动作: ${name}`);
    }
    return handler;
}

/** 直接调用诊断 handler（等价于 IPC 层把 params 交给 handler）。 */
function callDiag(
    actions: Map<string, DiagnosticActionHandler>,
    name: DiagnosticActionName,
    params: Record<string, unknown> = {},
): Promise<unknown> {
    return handlerOf(actions, name)(params);
}

/** 断言值为普通对象并返回（测试内不再散落 as 强转）。 */
function expectRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`期望对象结果，实际: ${String(value)}`);
    }
    return value;
}

/** 取 `__methods` 枚举结果（断言形状为 string[]）。 */
function methodsOf(value: unknown): string[] {
    const raw = expectRecord(value)["methods"];
    if (!Array.isArray(raw)) {
        throw new Error(`期望 methods 数组，实际: ${String(raw)}`);
    }
    return raw.map((item) => {
        if (typeof item !== "string") {
            throw new Error(`期望方法名为字符串，实际: ${String(item)}`);
        }
        return item;
    });
}

/** 构造反射目标（null 原型，避免 Object.prototype 的名字混进 __methods 枚举）。 */
function reflectiveTarget(methods: Record<string, unknown>): object {
    return Object.assign(Object.create(null), methods);
}

describe("诊断动作注册表", () => {
    it("注册 7 个动作，与 DIAGNOSTIC_ACTION_NAMES 一一对应", () => {
        const actions = diagActionsOf({});
        expect(DIAGNOSTIC_ACTION_NAMES).toHaveLength(7);
        // 名字表自身不得有重复，否则注册表与公开常量对不上
        expect(new Set(DIAGNOSTIC_ACTION_NAMES).size).toBe(DIAGNOSTIC_ACTION_NAMES.length);
        expect([...actions.keys()].sort()).toEqual([...DIAGNOSTIC_ACTION_NAMES].sort());
    });
});

describe("目标未注入 / 服务缺失", () => {
    it("session 未注入：各诊断动作返回可读错误", async () => {
        const actions = diagActionsOf({});
        expect(await callDiag(actions, "diag.richMediaTmpPaths")).toEqual({
            error: "session 未注入（IPC 上下文缺 session）",
        });
        for (const name of [
            "diag.flashCall",
            "diag.sessionCall",
            "diag.richMediaCall",
            "diag.msgServiceCall",
        ] as const) {
            expect(await callDiag(actions, name, { method: "__methods" })).toEqual({
                error: "session 未注入",
            });
        }
    });

    it("engine 未注入：engineCall 返回可读错误（不进入反射）", async () => {
        const actions = diagActionsOf({});
        expect(await callDiag(actions, "diag.engineCall", { method: "initLog" })).toEqual({
            error: "engine 未注入",
        });
    });

    it("util 未注入 / util 实例为 null：utilCall 返回可读错误", async () => {
        expect(await callDiag(diagActionsOf({}), "diag.utilCall", { method: "copyFile" })).toEqual({
            error: "util 未注入",
        });
        expect(
            await callDiag(diagActionsOf({ util: null }), "diag.utilCall", { method: "copyFile" }),
        ).toEqual({ error: "util 未注入" });
        const viaNull = diagActionsOf({ util: { get: () => null } });
        expect(await callDiag(viaNull, "diag.utilCall", { method: "copyFile" })).toEqual({
            error: "util 实例为 null",
        });
        const viaUndefined = diagActionsOf({ util: { get: () => undefined } });
        expect(await callDiag(viaUndefined, "diag.utilCall", { method: "copyFile" })).toEqual({
            error: "util 实例为 null",
        });
    });

    it("服务 getter 缺失 / 返回 null：flash、richMedia、msgService 返回可读错误", async () => {
        // 现状：getter 本身缺失时 serviceOf 统一报「session 未注入」（见报告可疑点）
        const missingGetter = diagActionsOf({ session: {} });
        for (const name of [
            "diag.flashCall",
            "diag.richMediaCall",
            "diag.msgServiceCall",
        ] as const) {
            expect(await callDiag(missingGetter, name, { method: "__methods" })).toEqual({
                error: "session 未注入",
            });
        }

        const nullServices = diagActionsOf({
            session: {
                getFlashTransferService: () => null,
                getRichMediaService: () => null,
                getMsgService: () => null,
            },
        });
        expect(await callDiag(nullServices, "diag.flashCall", { method: "__methods" })).toEqual({
            error: "flash 服务为 null",
        });
        expect(await callDiag(nullServices, "diag.richMediaCall", { method: "__methods" })).toEqual(
            { error: "richMedia 服务为 null" },
        );
        expect(
            await callDiag(nullServices, "diag.msgServiceCall", { method: "__methods" }),
        ).toEqual({ error: "msgService 服务为 null" });
    });

    it("sessionCall 目标为 null：落到 validate 兜底（结构化错误，不抛）", async () => {
        const actions = diagActionsOf({ session: null });
        expect(await callDiag(actions, "diag.sessionCall", { method: "__methods" })).toEqual({
            error: "target object is not a record",
        });
    });
});

describe("allowlist 与方法面", () => {
    it("allowlist 外方法一律拒绝（含 session 上的服务 getter）", async () => {
        const flash = reflectiveTarget({
            getFileSetIdByCode: vi.fn(() => "ok"),
            setFlashTransferDir: vi.fn(() => "ran"),
        });
        const msgSvc = reflectiveTarget({
            getMsgs: vi.fn(() => []),
            deleteMsg: vi.fn(() => "ran"),
        });
        const richSvc = reflectiveTarget({
            uploadRMFileWithoutMsg: vi.fn(() => "uploaded"),
            setUploadDir: vi.fn(() => "ran"),
        });
        const util = reflectiveTarget({
            copyFile: vi.fn(() => "copied"),
            deleteFile: vi.fn(() => "ran"),
        });
        const session = reflectiveTarget({
            getFlashTransferService: () => flash,
            getMsgService: () => msgSvc,
            getRichMediaService: () => richSvc,
            doWork: vi.fn(() => "ran"),
            onLine: vi.fn(() => "ran"),
        });
        const actions = diagActionsOf({ session, util });
        for (const [name, method] of [
            ["diag.sessionCall", "doWork"],
            ["diag.sessionCall", "onLine"],
            // session 上的服务 getter 也不在诊断 allowlist 内（防止借道扩张反射面）
            ["diag.sessionCall", "getMsgService"],
            ["diag.flashCall", "setFlashTransferDir"],
            ["diag.msgServiceCall", "deleteMsg"],
            ["diag.richMediaCall", "setUploadDir"],
            ["diag.utilCall", "deleteFile"],
        ] as const) {
            expect(await callDiag(actions, name, { method })).toEqual({
                ok: false,
                error: `诊断方法不在允许列表: ${method}`,
            });
        }
    });

    it("allowlist 内方法成功调用：返回 { ok: true, ret }", async () => {
        const engine = reflectiveTarget({
            initLog: vi.fn((level: unknown) => `log:${String(level)}`),
        });
        const flash = reflectiveTarget({
            getFileSetIdByCode: vi.fn((code: unknown) => `code:${String(code)}`),
        });
        const msgSvc = reflectiveTarget({
            getRichMediaFilePathForGuild: vi.fn(() => "path"),
        });
        const richSvc = reflectiveTarget({
            uploadRMFileWithoutMsg: vi.fn(() => "uploaded"),
        });
        const util = reflectiveTarget({
            copyFile: vi.fn((src: unknown) => `copied:${String(src)}`),
        });
        const actions = diagActionsOf({
            session: reflectiveTarget({
                getFlashTransferService: () => flash,
                getMsgService: () => msgSvc,
                getRichMediaService: () => richSvc,
            }),
            engine,
            util,
        });
        expect(
            await callDiag(actions, "diag.engineCall", { method: "initLog", args: ["debug"] }),
        ).toEqual({ ok: true, ret: "log:debug" });
        expect(
            await callDiag(actions, "diag.flashCall", {
                method: "getFileSetIdByCode",
                args: ["abc"],
            }),
        ).toEqual({ ok: true, ret: "code:abc" });
        expect(
            await callDiag(actions, "diag.msgServiceCall", {
                method: "getRichMediaFilePathForGuild",
            }),
        ).toEqual({ ok: true, ret: "path" });
        expect(
            await callDiag(actions, "diag.richMediaCall", { method: "uploadRMFileWithoutMsg" }),
        ).toEqual({ ok: true, ret: "uploaded" });
        expect(
            await callDiag(actions, "diag.utilCall", { method: "copyFile", args: ["a"] }),
        ).toEqual({ ok: true, ret: "copied:a" });
    });

    it("allowlist 内但对象缺方法 → { error: 方法不存在 }（不抛）", async () => {
        const actions = diagActionsOf({
            session: reflectiveTarget({
                getFlashTransferService: () => reflectiveTarget({}),
                getMsgService: () => reflectiveTarget({}),
            }),
            engine: reflectiveTarget({}),
        });
        expect(await callDiag(actions, "diag.engineCall", { method: "initLog" })).toEqual({
            error: "方法不存在: initLog",
        });
        expect(await callDiag(actions, "diag.msgServiceCall", { method: "getMsgs" })).toEqual({
            error: "方法不存在: getMsgs",
        });
        expect(await callDiag(actions, "diag.flashCall", { method: "getFileSetIdByCode" })).toEqual(
            { error: "方法不存在: getFileSetIdByCode" },
        );
    });

    it("msgServiceCall / richMediaCall：允许方法透传，未列出方法拒绝", async () => {
        const msgSvc = reflectiveTarget({
            getRichMediaFilePathForGuild: vi.fn(() => "path"),
            deleteMsg: vi.fn(() => "ran"),
        });
        const richSvc = reflectiveTarget({
            uploadRMFileWithoutMsg: vi.fn(() => "uploaded"),
            setUploadDir: vi.fn(() => "ran"),
        });
        const actions = diagActionsOf({
            session: reflectiveTarget({
                getMsgService: () => msgSvc,
                getRichMediaService: () => richSvc,
            }),
        });
        expect(
            await callDiag(actions, "diag.msgServiceCall", {
                method: "getRichMediaFilePathForGuild",
            }),
        ).toEqual({ ok: true, ret: "path" });
        expect(await callDiag(actions, "diag.msgServiceCall", { method: "deleteMsg" })).toEqual({
            ok: false,
            error: "诊断方法不在允许列表: deleteMsg",
        });
        expect(
            await callDiag(actions, "diag.richMediaCall", { method: "uploadRMFileWithoutMsg" }),
        ).toEqual({ ok: true, ret: "uploaded" });
        expect(await callDiag(actions, "diag.richMediaCall", { method: "setUploadDir" })).toEqual({
            ok: false,
            error: "诊断方法不在允许列表: setUploadDir",
        });
    });

    it("utilCall：util.get() 返回实例时调实例方法；无 get 时直接用 util 本体", async () => {
        const instance = reflectiveTarget({
            copyFile: vi.fn((src: unknown) => `copied:${String(src)}`),
        });
        expect(
            await callDiag(diagActionsOf({ util: { get: () => instance } }), "diag.utilCall", {
                method: "copyFile",
                args: ["a"],
            }),
        ).toEqual({ ok: true, ret: "copied:a" });
        expect(
            await callDiag(diagActionsOf({ util: instance }), "diag.utilCall", {
                method: "copyFile",
                args: ["b"],
            }),
        ).toEqual({ ok: true, ret: "copied:b" });
    });
});

describe("__methods 枚举", () => {
    it("own + 原型去重，且不实际调用方法", async () => {
        const sharedOwn = vi.fn(() => "own");
        const sharedProto = vi.fn(() => "proto");
        const ownOnly = vi.fn(() => "own-only");
        const protoOnly = vi.fn(() => "proto-only");
        const proto = Object.assign(Object.create(null), {
            shared: sharedProto,
            protoOnly,
        });
        const session = Object.assign(Object.create(proto), { shared: sharedOwn, ownOnly });
        const actions = diagActionsOf({ session });
        const methods = methodsOf(
            await callDiag(actions, "diag.sessionCall", { method: "__methods" }),
        );
        expect(methods.sort()).toEqual(["ownOnly", "protoOnly", "shared"]);
        for (const spy of [sharedOwn, sharedProto, ownOnly, protoOnly]) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it("方法名为空或超过 128 字符时被过滤（恰好 128 保留）", async () => {
        const target: Record<string, unknown> = Object.create(null);
        target[""] = () => 0;
        target["short"] = () => 1;
        target["a".repeat(128)] = () => 2;
        target["b".repeat(129)] = () => 3;
        const actions = diagActionsOf({ session: target });
        expect(
            methodsOf(await callDiag(actions, "diag.sessionCall", { method: "__methods" })).sort(),
        ).toEqual(["a".repeat(128), "short"]);
    });

    it("列表上限 256：超出部分截断", async () => {
        const target: Record<string, unknown> = Object.create(null);
        for (let i = 0; i < 300; i++) {
            target[`m${i}`] = () => i;
        }
        const actions = diagActionsOf({ session: target });
        const methods = methodsOf(
            await callDiag(actions, "diag.sessionCall", { method: "__methods" }),
        );
        const expected: string[] = [];
        for (let i = 0; i < 256; i++) {
            expected.push(`m${i}`);
        }
        expect(methods).toEqual(expected);
    });
});

describe("参数边界与错误结构化", () => {
    it("method 缺失 / 空串 / 非字符串 / 超长 → 结构化错误", async () => {
        const actions = diagActionsOf({
            engine: reflectiveTarget({ initLog: vi.fn(() => "ok") }),
        });
        expect(await callDiag(actions, "diag.engineCall")).toEqual({ error: "缺 method" });
        expect(await callDiag(actions, "diag.engineCall", { method: "" })).toEqual({
            error: "缺 method",
        });
        expect(await callDiag(actions, "diag.engineCall", { method: 42 })).toEqual({
            error: "缺 method",
        });
        expect(await callDiag(actions, "diag.engineCall", { method: "x".repeat(129) })).toEqual({
            error: "method 过长（上限 128）",
        });
    });

    it("method 长度恰好 128 → 不触发长度错误，按 allowlist 拒绝", async () => {
        const actions = diagActionsOf({
            engine: reflectiveTarget({ initLog: vi.fn(() => "ok") }),
        });
        const method = "x".repeat(128);
        expect(await callDiag(actions, "diag.engineCall", { method })).toEqual({
            ok: false,
            error: `诊断方法不在允许列表: ${method}`,
        });
    });

    it("args 超过 8 个拒绝；恰好 8 个放行；非数组按空数组处理", async () => {
        const initLog = vi.fn((...args: unknown[]) => args.length);
        const actions = diagActionsOf({ engine: reflectiveTarget({ initLog }) });
        expect(
            await callDiag(actions, "diag.engineCall", {
                method: "initLog",
                args: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            }),
        ).toEqual({ error: "args 数量超限（上限 8）" });
        expect(
            await callDiag(actions, "diag.engineCall", {
                method: "initLog",
                args: [1, 2, 3, 4, 5, 6, 7, 8],
            }),
        ).toEqual({ ok: true, ret: 8 });
        expect(
            await callDiag(actions, "diag.engineCall", { method: "initLog", args: "bad" }),
        ).toEqual({ ok: true, ret: 0 });
    });

    it("方法抛错 → { ok: false, err }（Error 与非 Error 均结构化，不冒泡）", async () => {
        const errorTarget = diagActionsOf({
            engine: reflectiveTarget({
                initLog: vi.fn(() => {
                    throw new Error("原生断言");
                }),
            }),
        });
        expect(await callDiag(errorTarget, "diag.engineCall", { method: "initLog" })).toEqual({
            ok: false,
            err: "原生断言",
        });
        const nonErrorTarget = diagActionsOf({
            engine: reflectiveTarget({
                initLog: vi.fn(() => {
                    throw "拒绝访问";
                }),
            }),
        });
        expect(await callDiag(nonErrorTarget, "diag.engineCall", { method: "initLog" })).toEqual({
            ok: false,
            err: "拒绝访问",
        });
    });
});

describe("diag.richMediaTmpPaths 只读枚举", () => {
    it("session 为 null → 与 undefined 同样的可读错误", async () => {
        expect(await callDiag(diagActionsOf({ session: null }), "diag.richMediaTmpPaths")).toEqual({
            error: "session 未注入（IPC 上下文缺 session）",
        });
    });

    it("服务 getter 缺失 / 返回 null → 占位，不抛", async () => {
        expect(await callDiag(diagActionsOf({ session: {} }), "diag.richMediaTmpPaths")).toEqual({
            richMediaService: "null",
            flashService: "null",
        });
        const nullServices = diagActionsOf({
            session: {
                getRichMediaService: () => null,
                getFlashTransferService: () => null,
            },
        });
        expect(await callDiag(nullServices, "diag.richMediaTmpPaths")).toEqual({
            richMediaService: "null",
            flashService: "null",
        });
    });

    it("成功 / 抛错 / 方法缺失三分支，且不触发 setter", async () => {
        const setter = vi.fn(() => "should-not-run");
        const svc = reflectiveTarget({
            getPicTmpPath: vi.fn(() => "C:/tmp/pic"),
            getPttTmpPath: vi.fn(() => {
                throw new Error("权限不足");
            }),
            setFlashTransferDir: setter,
        });
        const flash = reflectiveTarget({ setFlashTransferDir: setter });
        const actions = diagActionsOf({
            session: { getRichMediaService: () => svc, getFlashTransferService: () => flash },
        });
        const value = expectRecord(await callDiag(actions, "diag.richMediaTmpPaths"));
        expect(Object.keys(value).sort()).toEqual([
            "flashMethods",
            "richMediaMethods",
            "richMediaTmpPaths",
        ]);
        const tmp = expectRecord(value["richMediaTmpPaths"]);
        // 固定 6 个 0 参方法都要有结果占位（缺失也要显式标记）
        expect(Object.keys(tmp).sort()).toEqual([...TMP_PATH_METHODS].sort());
        expect(tmp["getPicTmpPath"]).toBe("C:/tmp/pic");
        expect(tmp["getPttTmpPath"]).toBe("调用失败: 权限不足");
        expect(tmp["getVideoTmpPath"]).toBe("方法缺失");
        // 只读：setter 只出现在方法名枚举里，绝不被调用
        expect(value["richMediaMethods"]).toEqual([
            "getPicTmpPath",
            "getPttTmpPath",
            "setFlashTransferDir",
        ]);
        expect(value["flashMethods"]).toEqual(["setFlashTransferDir"]);
        expect(setter).not.toHaveBeenCalled();
    });
});
