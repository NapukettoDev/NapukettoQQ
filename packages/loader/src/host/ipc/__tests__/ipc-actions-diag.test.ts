/**
 * ipc-actions-diag.test.ts：IPC 诊断动作面 + toPeer/callIpcAction 边界分支单测。
 *
 * 既有 ipc-actions.test.ts 覆盖消息主链路；本文件补：
 *  - 诊断动作（diag.richMediaTmpPaths / flashCall / sessionCall / engineCall /
 *    richMediaCall / msgServiceCall / utilCall）：session/服务缺失、方法面枚举、
 *    方法调用成功/抛错/缺失各分支（不依赖真实 wrapper，全部注入普通 JS 对象）
 *  - toPeer：peerUid 直通、chatType 缺省、uinToUid 缺失/空映射错误
 *  - callIpcAction：params 缺省透传 {}、非 Error 抛出值、空 code 回退 UNKNOWN
 */
import { describe, expect, it, vi } from "vitest";
import { callIpcAction, createIpcActions, type IpcApiContext } from "../ipc-actions.js";
import { mockIpcCtx } from "./test-support.js";

/** 构造带 session/engine/util 的上下文（诊断动作消费面）。 */
function ctxWith(overrides: Partial<IpcApiContext>): IpcApiContext {
    return { ...mockIpcCtx(), ...overrides };
}

/** 构造含指定方法的对象（ownKeys 可枚举——诊断 __methods 走 getOwnPropertyNames）。 */
function serviceOf(methods: Record<string, unknown>): object {
    return Object.assign(Object.create(Object.create(null)), methods);
}

describe("diag 诊断动作：session/服务缺失分支", () => {
    it("diag.richMediaTmpPaths：session 未注入 → error", async () => {
        const actions = createIpcActions(ctxWith({ session: undefined }));
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
        const actions = createIpcActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.richMediaTmpPaths", {});
        expect(result).toEqual({
            ok: true,
            value: { richMediaService: "null", flashService: "null" },
        });
    });

    it("diag.flashCall：session 未注入 → error；flash 服务 null → error", async () => {
        const actions = createIpcActions(ctxWith({ session: undefined }));
        expect(await callIpcAction(actions, "diag.flashCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        const actions2 = createIpcActions(
            ctxWith({ session: { getFlashTransferService: () => null } }),
        );
        expect(await callIpcAction(actions2, "diag.flashCall", {})).toEqual({
            ok: true,
            value: { error: "flash 服务为 null" },
        });
    });

    it("diag.sessionCall/engineCall：目标未注入 → error", async () => {
        const actions = createIpcActions(ctxWith({ session: undefined, engine: undefined }));
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
        const actions = createIpcActions(ctxWith({ session: undefined }));
        expect(await callIpcAction(actions, "diag.richMediaCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        expect(await callIpcAction(actions, "diag.msgServiceCall", {})).toEqual({
            ok: true,
            value: { error: "session 未注入" },
        });
        const actions2 = createIpcActions(
            ctxWith({ session: { getRichMediaService: () => null, getMsgService: () => null } }),
        );
        expect(await callIpcAction(actions2, "diag.richMediaCall", {})).toEqual({
            ok: true,
            value: { error: "richMedia 服务为 null" },
        });
        expect(await callIpcAction(actions2, "diag.msgServiceCall", {})).toEqual({
            ok: true,
            value: { error: "msgService 为 null" },
        });
    });

    it("diag.utilCall：util 未注入 / 实例 null → error", async () => {
        const actions = createIpcActions(ctxWith({ util: undefined }));
        expect(await callIpcAction(actions, "diag.utilCall", {})).toEqual({
            ok: true,
            value: { error: "util 未注入" },
        });
        const actions2 = createIpcActions(ctxWith({ util: { get: () => null } }));
        expect(await callIpcAction(actions2, "diag.utilCall", {})).toEqual({
            ok: true,
            value: { error: "util 实例为 null" },
        });
    });
});

describe("diag 诊断动作：方法面枚举与调用", () => {
    it("diag.richMediaTmpPaths：枚举 0 参方法（成功/抛错/缺失三分支）", async () => {
        const svc = serviceOf({
            getPicTmpPath: () => "C:/tmp/pic",
            getPttTmpPath: () => {
                throw new Error("权限不足");
            },
        });
        const session = { getRichMediaService: () => svc, getFlashTransferService: () => null };
        const actions = createIpcActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.richMediaTmpPaths", {});
        const value = result.ok === true ? (result.value as Record<string, unknown>) : {};
        const tmp = value["richMediaTmpPaths"] as Record<string, unknown>;
        expect(tmp["getPicTmpPath"]).toBe("C:/tmp/pic");
        expect(tmp["getPttTmpPath"]).toBe("调用失败: 权限不足");
        expect(tmp["getVideoTmpPath"]).toBe("方法缺失");
        // 方法面来自服务原型（Object.getOwnPropertyNames(getPrototypeOf(svc))——
        // serviceOf 用两层 null 原型，原型方法面为空数组）
        expect(value["richMediaMethods"]).toEqual([]);
    });

    it("diag.flashCall：按方法名调用闪传服务任意方法", async () => {
        const flash = {
            getFileSetIdByCode: (code: string) => `code:${code}`,
        };
        const session = { getFlashTransferService: () => flash };
        const actions = createIpcActions(ctxWith({ session }));
        expect(
            await callIpcAction(actions, "diag.flashCall", {
                method: "getFileSetIdByCode",
                args: ["abc"],
            }),
        ).toEqual({ ok: true, value: { ok: true, ret: "code:abc" } });
    });

    it("diag.richMediaTmpPaths：flash 候选 side-effect 触发（函数 ok / 抛错 / 缺失）", async () => {
        // 空原型链（getPrototypeOf → 空对象 → flashMethods []，与 NAPI 服务实例同构）
        const flash = Object.assign(Object.create({}), {
            addFileSetSimpleStatusListener: () => "listening",
            setFlashTransferDir: () => {
                throw new Error("目录无效");
            },
        });
        const session = { getRichMediaService: () => null, getFlashTransferService: () => flash };
        const actions = createIpcActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.richMediaTmpPaths", {});
        expect(result).toEqual({
            ok: true,
            value: {
                richMediaService: "null",
                flashMethods: [],
                flashSideEffects: {
                    addFileSetSimpleStatusListener: { ok: true, ret: "listening" },
                    setFlashTransferDir: { ok: false, err: "目录无效" },
                    setFileSetDownloadDir: { missing: true },
                    getFileSetIdByCode: { missing: true },
                },
            },
        });
    });

    it("diag.sessionCall：__methods 枚举 ownKeys + 原型", async () => {
        const proto = { protoMethod: () => 1 };
        const session = Object.assign(Object.create(proto), { ownMethod: () => 2 });
        const actions = createIpcActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.sessionCall", { method: "__methods" });
        const methods = (
            result.ok === true ? (result.value as { methods: string[] }) : { methods: [] }
        ).methods.sort();
        expect(methods).toEqual(["ownMethod", "protoMethod"]);
    });

    it("diag.sessionCall：方法调用成功返回 ret；参数数组透传", async () => {
        const session = { onLine: (a: unknown, b: unknown) => `${String(a)}-${String(b)}` };
        const actions = createIpcActions(ctxWith({ session }));
        const result = await callIpcAction(actions, "diag.sessionCall", {
            method: "onLine",
            args: ["x", 1],
        });
        expect(result).toEqual({ ok: true, value: { ok: true, ret: "x-1" } });
    });

    it("diag.sessionCall：方法抛错 → ok:false + err（Error message / 非 Error 字符串化）", async () => {
        const session = {
            boom: () => {
                throw new Error("原生断言");
            },
            boom2: () => {
                throw "裸字符串";
            },
        };
        const actions = createIpcActions(ctxWith({ session }));
        expect(await callIpcAction(actions, "diag.sessionCall", { method: "boom" })).toEqual({
            ok: true,
            value: { ok: false, err: "原生断言" },
        });
        expect(await callIpcAction(actions, "diag.sessionCall", { method: "boom2" })).toEqual({
            ok: true,
            value: { ok: false, err: "裸字符串" },
        });
    });

    it("diag.sessionCall：方法不存在 → error；method 缺省按空串处理", async () => {
        const session = { real: () => 1 };
        const actions = createIpcActions(ctxWith({ session }));
        expect(await callIpcAction(actions, "diag.sessionCall", { method: "nope" })).toEqual({
            ok: true,
            value: { error: "方法不存在: nope" },
        });
        expect(await callIpcAction(actions, "diag.sessionCall", {})).toEqual({
            ok: true,
            value: { error: "方法不存在: " },
        });
    });

    it("diag.engineCall / diag.msgServiceCall / diag.richMediaCall：方法调用透传", async () => {
        const engine = { initLog: (level: string) => `log:${level}` };
        const msgSvc = { getRichMediaFilePathForGuild: () => "path" };
        const richSvc = { uploadRMFileWithoutMsg: () => "uploaded" };
        const session = { getMsgService: () => msgSvc, getRichMediaService: () => richSvc };
        const actions = createIpcActions(ctxWith({ session, engine }));
        expect(
            await callIpcAction(actions, "diag.engineCall", { method: "initLog", args: ["debug"] }),
        ).toEqual({ ok: true, value: { ok: true, ret: "log:debug" } });
        expect(
            await callIpcAction(actions, "diag.msgServiceCall", {
                method: "getRichMediaFilePathForGuild",
            }),
        ).toEqual({ ok: true, value: { ok: true, ret: "path" } });
        expect(
            await callIpcAction(actions, "diag.richMediaCall", {
                method: "uploadRMFileWithoutMsg",
            }),
        ).toEqual({ ok: true, value: { ok: true, ret: "uploaded" } });
    });

    it("diag.utilCall：util.get() 实例调用；无 get 时直接用 util 本体", async () => {
        const instance = { copyFile: (src: string) => `copied:${src}` };
        const actions = createIpcActions(ctxWith({ util: { get: () => instance } }));
        expect(
            await callIpcAction(actions, "diag.utilCall", { method: "copyFile", args: ["a"] }),
        ).toEqual({ ok: true, value: { ok: true, ret: "copied:a" } });
        const actions2 = createIpcActions(ctxWith({ util: instance }));
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
