/**
 * ipc-actions-diag.test.ts：IPC 诊断动作面（默认关闭 + 显式启用后 allowlist）+ 边界分支单测。
 *
 * 安全回归（H-01）：
 *  - 常规 `createIpcActions(ctx)` 不含任何 `diag.*`，调用得到 NOT_FOUND；
 *  - `diagnostics: true` 才注册 7 个诊断动作；
 *  - 反射调用只接受目标 allowlist，未知/危险方法、超长 method、超量 args 直接拒绝；
 *  - `diag.richMediaTmpPaths` 只读枚举，不再触发 setters 等副作用。
 */
import { describe, expect, it, vi } from "vitest";
import {
    callIpcAction,
    createIpcActions,
    DIAGNOSTIC_ACTION_NAMES,
    type IpcApiContext,
} from "../ipc-actions.js";
import { mockIpcCtx } from "./test-support.js";

/** 构造带 session/engine/util 的上下文（诊断动作消费面）。 */
function ctxWith(overrides: Partial<IpcApiContext>): IpcApiContext {
    return { ...mockIpcCtx(), ...overrides };
}

/** 构造含指定方法的对象（ownKeys 可枚举——诊断 __methods 走 getOwnPropertyNames）。 */
function serviceOf(methods: Record<string, unknown>): object {
    return Object.assign(Object.create(Object.create(null)), methods);
}

/** 显式启用诊断的动作表。 */
function diagActions(ctx: IpcApiContext) {
    return createIpcActions(ctx, { diagnostics: true });
}

describe("诊断动作注册启停", () => {
    it("默认动作表不含 diag.*（调用方得到 NOT_FOUND）", async () => {
        const actions = createIpcActions(ctxWith({ session: {} }));
        for (const name of DIAGNOSTIC_ACTION_NAMES) {
            expect(actions.has(name)).toBe(false);
        }
        expect(await callIpcAction(actions, "diag.sessionCall", { method: "__methods" })).toEqual({
            ok: false,
            error: { code: "NOT_FOUND", message: "未知动作: diag.sessionCall" },
        });
    });

    it("diagnostics: true → 7 个诊断动作全部注册；业务动作仍在", () => {
        const actions = diagActions(ctxWith({ session: {}, engine: {}, util: {} }));
        for (const name of DIAGNOSTIC_ACTION_NAMES) {
            expect(actions.has(name)).toBe(true);
        }
        expect(actions.has("msg.sendMessage")).toBe(true);
        expect(actions.has("login.getSelf")).toBe(true);
    });
});

describe("diag 诊断动作：session/服务缺失分支", () => {
    it("diag.richMediaTmpPaths：session 未注入 → error", async () => {
        const actions = diagActions(ctxWith({ session: undefined }));
        const result = await callIpcAction(actions, "diag.richMediaTmpPaths", {});
        expect(result).toEqual({
            ok: true,
            value: { error: "session 未注入（IPC 上下文缺 session）" },
        });
    });

    it("diag.richMediaTmpPaths：richMedia/flash 服务均 null → 占位", async () => {
        const session = {
            getRichMediaService: () => null,
            getFlashTransferService: () => null,
        };
        const actions = diagActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.richMediaTmpPaths", {});
        expect(result).toEqual({
            ok: true,
            value: { richMediaService: "null", flashService: "null" },
        });
    });

    it("diag.flashCall：session 未注入 → error；flash 服务 null → error", async () => {
        const actions = diagActions(ctxWith({ session: undefined }));
        expect(await callIpcAction(actions, "diag.flashCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        const actions2 = diagActions(ctxWith({ session: { getFlashTransferService: () => null } }));
        expect(await callIpcAction(actions2, "diag.flashCall", {})).toEqual({
            ok: true,
            value: { error: "flash 服务为 null" },
        });
    });

    it("diag.sessionCall/engineCall：目标未注入 → error", async () => {
        const actions = diagActions(ctxWith({ session: undefined, engine: undefined }));
        expect(await callIpcAction(actions, "diag.sessionCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        expect(await callIpcAction(actions, "diag.engineCall", {})).toEqual({
            ok: true,
            value: { error: "engine 未注入" },
        });
    });

    it("diag.richMediaCall/msgServiceCall：服务 getter 缺失或返回 null → error", async () => {
        const actions = diagActions(ctxWith({ session: undefined }));
        expect(await callIpcAction(actions, "diag.richMediaCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        expect(await callIpcAction(actions, "diag.msgServiceCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        const actions2 = diagActions(
            ctxWith({ session: { getRichMediaService: () => null, getMsgService: () => null } }),
        );
        expect(await callIpcAction(actions2, "diag.richMediaCall", {})).toEqual({
            ok: true,
            value: { error: "richMedia 服务为 null" },
        });
        expect(await callIpcAction(actions2, "diag.msgServiceCall", {})).toEqual({
            ok: true,
            value: { error: "msgService 服务为 null" },
        });
    });

    it("diag.utilCall：util 未注入 / 实例 null → error", async () => {
        const actions = diagActions(ctxWith({ util: undefined }));
        expect(await callIpcAction(actions, "diag.utilCall", {})).toEqual({
            ok: true,
            value: { error: "util 未注入" },
        });
        const actions2 = diagActions(ctxWith({ util: { get: () => null } }));
        expect(await callIpcAction(actions2, "diag.utilCall", {})).toEqual({
            ok: true,
            value: { error: "util 实例为 null" },
        });
    });
});

describe("diag 诊断动作：方法面枚举与 allowlist", () => {
    it("diag.richMediaTmpPaths：只读枚举 0 参方法（成功/抛错/缺失三分支）且不触发 setter", async () => {
        const setter = vi.fn(() => "should-not-run");
        const svc = serviceOf({
            getPicTmpPath: () => "C:/tmp/pic",
            getPttTmpPath: () => {
                throw new Error("权限不足");
            },
            setFlashTransferDir: setter,
        });
        const flash = serviceOf({ setFlashTransferDir: setter });
        const session = { getRichMediaService: () => svc, getFlashTransferService: () => flash };
        const actions = diagActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.richMediaTmpPaths", {});
        const value = result.ok === true ? (result.value as Record<string, unknown>) : {};
        const tmp = value["richMediaTmpPaths"] as Record<string, unknown>;
        expect(tmp["getPicTmpPath"]).toBe("C:/tmp/pic");
        expect(tmp["getPttTmpPath"]).toBe("调用失败: 权限不足");
        expect(tmp["getVideoTmpPath"]).toBe("方法缺失");
        expect(Array.isArray(value["richMediaMethods"])).toBe(true);
        expect(Array.isArray(value["flashMethods"])).toBe(true);
        expect(value["flashSideEffects"]).toBeUndefined();
        expect(setter).not.toHaveBeenCalled();
    });

    it("diag.sessionCall：__methods 枚举 ownKeys + 原型，有数量上限", async () => {
        const proto = { protoMethod: () => 1 };
        const session = Object.assign(Object.create(proto), { ownMethod: () => 2 });
        const actions = diagActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.sessionCall", { method: "__methods" });
        const methods = (
            result.ok === true ? (result.value as { methods: string[] }) : { methods: [] }
        ).methods.sort();
        expect(methods).toEqual(["ownMethod", "protoMethod"]);
    });

    it("sessionCall / flashCall / utilCall：allowlist 外方法直接拒绝（不再任意反射）", async () => {
        const session = { doWork: () => "ran", onLine: () => "ran" };
        const flash = { getFileSetIdByCode: () => "ok", setFlashTransferDir: () => "ran" };
        const util = { copyFile: () => "copied", deleteFile: () => "ran" };
        const actions = diagActions(
            ctxWith({ session: { ...session, getFlashTransferService: () => flash }, util }),
        );
        for (const [action, method] of [
            ["diag.sessionCall", "doWork"],
            ["diag.sessionCall", "onLine"],
            ["diag.flashCall", "setFlashTransferDir"],
            ["diag.utilCall", "deleteFile"],
        ] as const) {
            expect(await callIpcAction(actions, action, { method })).toEqual({
                ok: true,
                value: { ok: false, error: `诊断方法不在允许列表: ${method}` },
            });
        }
    });

    it("allowlist 内方法正常调用：engine.initLog / flash.getFileSetIdByCode / util.copyFile", async () => {
        const engine = { initLog: (level: string) => `log:${level}` };
        const flash = { getFileSetIdByCode: (code: string) => `code:${code}` };
        const util = { copyFile: (src: string) => `copied:${src}` };
        const actions = diagActions(
            ctxWith({
                session: { getFlashTransferService: () => flash },
                engine,
                util,
            }),
        );
        expect(
            await callIpcAction(actions, "diag.engineCall", { method: "initLog", args: ["debug"] }),
        ).toEqual({ ok: true, value: { ok: true, ret: "log:debug" } });
        expect(
            await callIpcAction(actions, "diag.flashCall", {
                method: "getFileSetIdByCode",
                args: ["abc"],
            }),
        ).toEqual({ ok: true, value: { ok: true, ret: "code:abc" } });
        expect(
            await callIpcAction(actions, "diag.utilCall", { method: "copyFile", args: ["a"] }),
        ).toEqual({ ok: true, value: { ok: true, ret: "copied:a" } });
    });

    it("参数边界：method 缺失/过长、args 超量、方法抛错均返回结构化错误", async () => {
        const engine = {
            initLog: () => {
                throw new Error("原生断言");
            },
        };
        const actions = diagActions(ctxWith({ engine }));
        expect(await callIpcAction(actions, "diag.engineCall", {})).toEqual({
            ok: true,
            value: { error: "缺 method" },
        });
        expect(
            await callIpcAction(actions, "diag.engineCall", { method: "x".repeat(129) }),
        ).toEqual({ ok: true, value: { error: "method 过长（上限 128）" } });
        expect(
            await callIpcAction(actions, "diag.engineCall", {
                method: "initLog",
                args: Array.from({ length: 9 }, () => 0),
            }),
        ).toEqual({ ok: true, value: { error: "args 数量超限（上限 8）" } });
        expect(await callIpcAction(actions, "diag.engineCall", { method: "initLog" })).toEqual({
            ok: true,
            value: { ok: false, err: "原生断言" },
        });
    });

    it("allowlist 内但对象缺方法 → 方法不存在（不抛）", async () => {
        const engine = {};
        const actions = diagActions(ctxWith({ engine }));
        expect(await callIpcAction(actions, "diag.engineCall", { method: "initLog" })).toEqual({
            ok: true,
            value: { error: "方法不存在: initLog" },
        });
    });

    it("msgServiceCall / richMediaCall：允许方法透传，未列出方法拒绝", async () => {
        const msgSvc = {
            getRichMediaFilePathForGuild: () => "path",
            deleteMsg: () => "ran",
        };
        const richSvc = {
            uploadRMFileWithoutMsg: () => "uploaded",
            setUploadDir: () => "ran",
        };
        const session = { getMsgService: () => msgSvc, getRichMediaService: () => richSvc };
        const actions = diagActions(ctxWith({ session }));
        expect(
            await callIpcAction(actions, "diag.msgServiceCall", {
                method: "getRichMediaFilePathForGuild",
            }),
        ).toEqual({ ok: true, value: { ok: true, ret: "path" } });
        expect(
            await callIpcAction(actions, "diag.msgServiceCall", { method: "deleteMsg" }),
        ).toEqual({
            ok: true,
            value: { ok: false, error: "诊断方法不在允许列表: deleteMsg" },
        });
        expect(
            await callIpcAction(actions, "diag.richMediaCall", {
                method: "uploadRMFileWithoutMsg",
            }),
        ).toEqual({ ok: true, value: { ok: true, ret: "uploaded" } });
        expect(
            await callIpcAction(actions, "diag.richMediaCall", { method: "setUploadDir" }),
        ).toEqual({
            ok: true,
            value: { ok: false, error: "诊断方法不在允许列表: setUploadDir" },
        });
    });

    it("diag.utilCall：util.get() 实例调用；无 get 时直接用 util 本体", async () => {
        const instance = { copyFile: (src: string) => `copied:${src}` };
        const actions = diagActions(ctxWith({ util: { get: () => instance } }));
        expect(
            await callIpcAction(actions, "diag.utilCall", { method: "copyFile", args: ["a"] }),
        ).toEqual({ ok: true, value: { ok: true, ret: "copied:a" } });
        const actions2 = diagActions(ctxWith({ util: instance }));
        expect(
            await callIpcAction(actions2, "diag.utilCall", { method: "copyFile", args: ["b"] }),
        ).toEqual({ ok: true, value: { ok: true, ret: "copied:b" } });
    });
});

describe("toPeer / 动作边界分支", () => {
    it("peerUid 直通（chatType 缺省 1 私聊）", async () => {
        const ctx = mockIpcCtx();
        const actions = createIpcActions(ctx);
        await callIpcAction(actions, "msg.markRead", { peerUid: "u_abc" });
        expect(ctx.msgApi.markRead).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_abc" });
        expect(ctx.uinToUid).not.toHaveBeenCalled();
    });

    it("私聊 peerUin 但未注入 uinToUid → 错误（提示注入）", async () => {
        const ctx = mockIpcCtx();
        delete (ctx as { uinToUid?: unknown }).uinToUid;
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            peerUin: "12345",
            elements: [],
        });
        expect(result).toEqual({
            ok: false,
            error: { code: "UNKNOWN", message: "缺 peerUid（或 peerUin 且未注入 uinToUid）" },
        });
    });

    it("私聊 peerUin 但 uinToUid 映射缺失 → 错误（uin 转 uid 失败）", async () => {
        const ctx = mockIpcCtx();
        ctx.uinToUid = vi.fn(async () => new Map());
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            peerUin: "12345",
            elements: [],
        });
        expect(result).toEqual({
            ok: false,
            error: { code: "UNKNOWN", message: "uin 转 uid 失败: 12345" },
        });
    });

    it("msg.sendMessage：elements 非数组按空数组处理", async () => {
        const ctx = mockIpcCtx();
        const actions = createIpcActions(ctx);
        await callIpcAction(actions, "msg.sendMessage", {
            peerUid: "u_1",
            elements: "不是数组",
        });
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_1" }, []);
    });

    it("msg.fetchMessages：count + msgId 同时透传", async () => {
        const ctx = mockIpcCtx();
        const actions = createIpcActions(ctx);
        await callIpcAction(actions, "msg.fetchMessages", {
            peerUid: "u_1",
            count: 5,
            msgId: "m_100",
        });
        expect(ctx.msgApi.fetchMessages).toHaveBeenCalledWith(
            { chatType: 1, peerUid: "u_1" },
            { count: 5, msgId: "m_100" },
        );
    });

    it("msg.recallMessage：msgIds 非数组按空数组处理（kernel 抛 INVALID_PARAM）", async () => {
        const ctx = mockIpcCtx();
        const actions = createIpcActions(ctx);
        await callIpcAction(actions, "msg.recallMessage", { peerUid: "u_1", msgIds: "bad" });
        expect(ctx.msgApi.recallMessage).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_1" }, []);
    });

    it("friend.getFriendList：透传 friendApi.getFriendList", async () => {
        const ctx = mockIpcCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "friend.getFriendList", {});
        expect(result).toEqual({ ok: true, value: [{ uid: "u1" }] });
        expect(ctx.friendApi.getFriendList).toHaveBeenCalledOnce();
    });

    it("callIpcAction：params 缺省 → handler 收到空对象", async () => {
        const ctx = mockIpcCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "group.getGroupList", undefined);
        expect(result).toEqual({
            ok: true,
            value: [{ groupCode: "10001", groupName: "测试群" }],
        });
        expect(ctx.groupCache.listGroupsRefreshed).toHaveBeenCalledOnce();
    });

    it("callIpcAction：抛出带空 code 的错误 → 回退 UNKNOWN；非 Error 抛出值字符串化", async () => {
        const ctx = mockIpcCtx();
        ctx.msgApi.sendMessage = vi.fn(async () => {
            const err = new Error("无码错误") as Error & { code: string };
            err.code = "";
            throw err;
        });
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            peerUid: "u_1",
            elements: [],
        });
        expect(result).toEqual({ ok: false, error: { code: "UNKNOWN", message: "无码错误" } });

        ctx.msgApi.sendMessage = vi.fn(async () => {
            throw 42;
        });
        const result2 = await callIpcAction(actions, "msg.sendMessage", {
            peerUid: "u_1",
            elements: [],
        });
        expect(result2).toEqual({ ok: false, error: { code: "UNKNOWN", message: "42" } });
    });
});
