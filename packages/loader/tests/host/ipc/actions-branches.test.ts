/**
 * actions-branches.test.ts：IPC 动作表（createIpcActions）的动作表层分支单测。
 *
 * 覆盖：
 *  - 诊断动作注册启停：默认不注册（调用得 NOT_FOUND）、`diagnostics: true` 注册 7 个；
 *  - toPeer / 消息动作边界：peer 直通与 uin→uid 失败、elements 非数组、
 *    fetchMessages 参数、recallMessage 清洗、friend.getFriendList；
 *  - callIpcAction 的 NOT_FOUND / 空 code 回退 UNKNOWN / 非 Error 抛出。
 *
 * 诊断模块内部（allowlist / `__methods` / 参数边界 / 只读枚举）见 diagnostics.test.ts。
 */
import { describe, expect, it, vi } from "vitest";
import {
    callIpcAction,
    createIpcActions,
    DIAGNOSTIC_ACTION_NAMES,
    type IpcApiContext,
} from "../../../src/host/ipc/actions.js";
import { mockIpcCtx } from "./test-support.js";

/** 构造带诊断字段的上下文（注册启停用例）。 */
function ctxWith(overrides: Partial<IpcApiContext>): IpcApiContext {
    return { ...mockIpcCtx(), ...overrides };
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
        expect(result).toEqual({
            ok: true,
            value: [{ uid: "u1", uin: null, nickname: "好友昵称", remark: "备注" }],
        });
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
