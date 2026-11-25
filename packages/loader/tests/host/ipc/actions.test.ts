/**
 * actions.test.ts：IPC 动作表单测（mock kernel apis，不依赖真实 wrapper）。
 */
import { describe, expect, it, vi } from "vitest";
import {
    callIpcAction,
    createIpcActions,
    type IpcActionHandler,
    type IpcApiContext,
    registerLoginRefreshAction,
} from "../../../src/host/ipc/actions.js";

describe("msg.addReaction", () => {
    const reaction = { msgId: "7451137051157323859", emojiId: "105" };

    it.each([
        [
            { chatType: 2, peerUid: "12345" },
            { chatType: 2, peerUid: "12345" },
        ],
        [
            { chatType: 2, peerUin: "12345" },
            { chatType: 2, peerUid: "12345" },
        ],
        [{ peerUin: "12345" }, { chatType: 1, peerUid: "u_12345" }],
        [
            { chatType: 100, peerUin: "12345" },
            { chatType: 100, peerUid: "u_12345" },
        ],
    ])("解析会话并添加表态（%j）", async (conversation, peer) => {
        const ctx = mockCtx();
        const setMsgEmojiLikeById = vi.fn(async () => undefined);
        ctx.msgApi.setMsgEmojiLikeById = setMsgEmojiLikeById;

        const result = await callIpcAction(createIpcActions(ctx), "msg.addReaction", {
            ...conversation,
            ...reaction,
        });

        expect(result).toEqual({ ok: true });
        expect(setMsgEmojiLikeById).toHaveBeenCalledExactlyOnceWith(peer, {
            ...reaction,
            like: true,
        });
    });

    it.each([
        reaction,
        { ...reaction, peerUid: "12345", msgId: 42 },
        { ...reaction, peerUid: "12345", emojiId: 105 },
        { ...reaction, peerUid: "12345", chatType: "2" },
    ])("无效 IPC 参数返回 INVALID_PARAM（%j）", async (params) => {
        const ctx = mockCtx();
        const setMsgEmojiLikeById = vi.fn(async () => undefined);
        ctx.msgApi.setMsgEmojiLikeById = setMsgEmojiLikeById;
        await expect(
            callIpcAction(createIpcActions(ctx), "msg.addReaction", params),
        ).resolves.toMatchObject({
            ok: false,
            error: { code: "INVALID_PARAM" },
        });
        expect(setMsgEmojiLikeById).not.toHaveBeenCalled();
    });

    it("保留 kernel 的权限错误", async () => {
        const ctx = mockCtx();
        ctx.msgApi.setMsgEmojiLikeById = vi.fn(async () => {
            throw Object.assign(new Error("无权限"), { code: "PERMISSION_DENIED" });
        });
        const result = await callIpcAction(createIpcActions(ctx), "msg.addReaction", {
            peerUid: "u_12345",
            ...reaction,
        });
        expect(result).toEqual({
            ok: false,
            error: { code: "PERMISSION_DENIED", message: "无权限" },
        });
    });

    it("旧版 kernel 返回 INVALID_STATE，其他动作仍可调用", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.addReaction", {
            peerUid: "u_12345",
            ...reaction,
        });
        expect(result).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
        expect(await callIpcAction(actions, "login.getSelf", undefined)).toEqual({
            ok: true,
            value: ctx.self,
        });
    });
});

/** mock kernel apis 上下文。 */
function mockCtx(): IpcApiContext {
    return {
        msgApi: {
            sendMessage: vi.fn(async () => ({ msgId: "42" })),
            recallMessage: vi.fn(async () => undefined),
            fetchMessages: vi.fn(async () => [{ msgId: "1" }]),
            markRead: vi.fn(async () => undefined),
        },
        groupApi: {
            getGroupList: vi.fn(async () => []),
        },
        groupCache: {
            listGroupsRefreshed: vi.fn(async () => [{ groupCode: "10001", groupName: "测试群" }]),
        },
        friendApi: {
            getFriendList: vi.fn(async () => [{ uid: "u1" }]),
        },
        self: { uin: "10001", nickname: "测试号" },
        uinToUid: vi.fn(async (uins: string[]) => {
            const map = new Map<string, string>();
            for (const uin of uins) {
                map.set(uin, `u_${uin}`);
            }
            return map;
        }),
    };
}

describe("createIpcActions", () => {
    it("login.getSelf 返回自身信息", async () => {
        const actions = createIpcActions(mockCtx());
        const result = await callIpcAction(actions, "login.getSelf", undefined);
        expect(result).toEqual({ ok: true, value: { uin: "10001", nickname: "测试号" } });
    });

    it("msg.sendMessage 群聊 peerUin 直通为 peerUid（不走 uinToUid）", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [{ type: "text", text: "你好" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "text", text: "你好" },
        ]);
        // 群聊不触发 uinToUid（getUidByUins 是用户转换，传群号属非法调用）
        expect(ctx.uinToUid).not.toHaveBeenCalled();
    });

    it("msg.sendMessage 私聊 peerUin 经 uinToUid 转 uid", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUin: "12345",
            elements: [{ type: "text", text: "你好" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_12345" }, [
            { type: "text", text: "你好" },
        ]);
        expect(ctx.uinToUid).toHaveBeenCalledWith(["12345"]);
    });

    it("msg.sendMessage 群聊 at 元素 uin → uid 转换（issue #1 @ 修复）", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [
                { type: "text", text: "你好 " },
                { type: "at", target: "67890" },
            ],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.uinToUid).toHaveBeenCalledWith(["67890"]);
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "text", text: "你好 " },
            { type: "at", target: "u_67890" },
        ]);
    });

    it("msg.sendMessage 群聊 at 补 display（groupCache.getMember 昵称）", async () => {
        const ctx = mockCtx();
        ctx.groupCache.getMember = vi.fn(async (_groupCode, uid) => ({ uid, nick: "小明" }));
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [{ type: "at", target: "67890" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.groupCache.getMember).toHaveBeenCalledWith("12345", "u_67890");
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "at", target: "u_67890", display: "小明" },
        ]);
    });

    it("msg.sendMessage 群聊 at 已带 display 则不覆盖", async () => {
        const ctx = mockCtx();
        ctx.groupCache.getMember = vi.fn(async (_groupCode, uid) => ({ uid, nick: "小明" }));
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [{ type: "at", target: "67890", display: "指定名" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.groupCache.getMember).not.toHaveBeenCalled();
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "at", target: "u_67890", display: "指定名" },
        ]);
    });

    it("msg.sendMessage 群聊 at 已为 uid（u_ 前缀）直通不转换", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [{ type: "at", target: "u_abc" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.uinToUid).not.toHaveBeenCalled();
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "at", target: "u_abc" },
        ]);
    });

    it("msg.sendMessage 群聊 at 转换失败保留原 target（保底发送）", async () => {
        const ctx = mockCtx();
        ctx.uinToUid = vi.fn(async () => new Map()); // 空映射 = 转换失败
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [{ type: "at", target: "67890" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "at", target: "67890" },
        ]);
    });

    it("msg.sendMessage @全体不转换（atType=1 由 kernel 处理）", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "12345",
            elements: [{ type: "at", target: "all" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(ctx.uinToUid).not.toHaveBeenCalled();
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 2, peerUid: "12345" }, [
            { type: "at", target: "all" },
        ]);
    });

    it("msg.sendMessage 私聊 at 不转换（QQ 私聊无 at 语义）", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUin: "67890",
            elements: [{ type: "at", target: "67890" }],
        });
        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        // peerUin → uid 是 toPeer 的 peer 转换；at 元素本身原样透传
        expect(ctx.msgApi.sendMessage).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_67890" }, [
            { type: "at", target: "67890" },
        ]);
    });

    it("msg.recallMessage 透传 msgIds", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.recallMessage", {
            chatType: 1,
            peerUin: "12345",
            msgIds: ["a", "b"],
        });
        expect(result).toEqual({ ok: true });
        expect(ctx.msgApi.recallMessage).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_12345" }, [
            "a",
            "b",
        ]);
    });

    it("msg.recallMessage 清洗 null/空字符串 msgId", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.recallMessage", {
            chatType: 1,
            peerUin: "12345",
            msgIds: ["a", "", null, "  "],
        });
        expect(result).toEqual({ ok: true });
        expect(ctx.msgApi.recallMessage).toHaveBeenCalledWith({ chatType: 1, peerUid: "u_12345" }, [
            "a",
        ]);
    });

    it("缺 peerUid/peerUin → 错误（提示可注入 uinToUid）", async () => {
        const actions = createIpcActions(mockCtx());
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUin: "",
            elements: [],
        });
        expect(result).toEqual({
            ok: false,
            error: { code: "UNKNOWN", message: "缺 peerUid（或 peerUin 且未注入 uinToUid）" },
        });
    });

    it("未知动作 → NOT_FOUND", async () => {
        const actions = createIpcActions(mockCtx());
        const result = await callIpcAction(actions, "nope.doSomething", {});
        expect(result).toEqual({
            ok: false,
            error: { code: "NOT_FOUND", message: "未知动作: nope.doSomething" },
        });
    });

    it("动作抛带 code 的错误 → code 透传（KernelError 契约）", async () => {
        const ctx = mockCtx();
        const { msgApi } = ctx;
        msgApi.sendMessage = vi.fn(async () => {
            const err = new Error("消息不存在") as Error & { code: string };
            err.code = "NOT_FOUND";
            throw err;
        });
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUid: "u_12345",
            elements: [],
        });
        expect(result).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "消息不存在" } });
    });

    it("动作抛普通 Error → UNKNOWN", async () => {
        const ctx = mockCtx();
        ctx.msgApi.sendMessage = vi.fn(async () => {
            throw new Error("boom");
        });
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUid: "u_12345",
            elements: [],
        });
        expect(result).toEqual({ ok: false, error: { code: "UNKNOWN", message: "boom" } });
    });

    it("msg.fetchMessages 缺省 count=20，msgId 可选", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "msg.fetchMessages", {
            chatType: 1,
            peerUid: "u_12345",
        });
        expect(result).toEqual({ ok: true, value: [{ msgId: "1" }] });
        expect(ctx.msgApi.fetchMessages).toHaveBeenCalledWith(
            { chatType: 1, peerUid: "u_12345" },
            { count: 20 },
        );
    });

    it("group.getGroupList 经 listGroupsRefreshed 取（空缓存自动刷新回填）", async () => {
        const ctx = mockCtx();
        const actions = createIpcActions(ctx);
        const result = await callIpcAction(actions, "group.getGroupList", {});
        expect(result).toEqual({
            ok: true,
            value: [{ groupCode: "10001", groupName: "测试群" }],
        });
        expect(ctx.groupCache.listGroupsRefreshed).toHaveBeenCalled();
    });
});

describe("registerLoginRefreshAction", () => {
    it("login.refreshQr 返回 refreshQr() 布尔结果", async () => {
        const actions = new Map<string, IpcActionHandler>();
        const refreshQr = vi.fn(() => true);
        registerLoginRefreshAction(actions, refreshQr);
        const result = await callIpcAction(actions, "login.refreshQr", undefined);
        expect(result).toEqual({ ok: true, value: true });
        expect(refreshQr).toHaveBeenCalledTimes(1);
    });

    it("refreshQr 返回 false 时透传 false（不在扫码态）", async () => {
        const actions = new Map<string, IpcActionHandler>();
        registerLoginRefreshAction(actions, () => false);
        const result = await callIpcAction(actions, "login.refreshQr", undefined);
        expect(result).toEqual({ ok: true, value: false });
    });
});
