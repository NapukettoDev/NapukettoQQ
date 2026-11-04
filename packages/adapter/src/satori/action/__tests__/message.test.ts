/**
 * satori/action/message.test.ts：message.create / get / list / delete 单测。
 *
 * 锁定参数映射与返回值映射：
 *  - message.create → resolvePeer → setChannelType 回填 → parseContentToCanonical
 *    → sendMessage → 返回 [Message]（content 回显原始输入）
 *  - message.get → fetchMsgsByMsgId 单查；无消息抛错（500）
 *  - message.list → around 抛错；asc/desc 排序；next 分页令牌（raw ≥ count）
 *  - message.delete → recallMessage
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { makeRawMsg } from "../../__tests__/test-support.js";
import { SatoriActionError } from "../base-action.js";
import type { MessageActionDeps } from "../message.js";
import {
    MessageCreateAction,
    MessageDeleteAction,
    MessageGetAction,
    MessageListAction,
} from "../message.js";
import { type StubSatoriApi, stubSatoriApi } from "./test-support.js";

/** 从桩 api 构造 MessageActionDeps。 */
function makeDeps(api: StubSatoriApi): MessageActionDeps {
    return {
        msgApi: api.msgApi,
        selfUin: api.selfUin,
        uidToUin: api.uidToUin,
        resolvePeer: api.resolvePeer,
        setChannelType: api.setChannelType,
        toCanonicalDeps: api.toCanonicalDeps,
    } as unknown as MessageActionDeps;
}

describe("MessageCreateAction", () => {
    it("群聊频道：resolvePeer → setChannelType(true) → sendMessage → 返回单元素数组", async () => {
        const api = stubSatoriApi();
        api.resolvePeer.mockResolvedValueOnce({
            chatType: ChatType.GROUP,
            peerUid: "10001",
        } as never);
        const action = new MessageCreateAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", content: '<at id="9"/>你好' }),
        ).resolves.toEqual([
            {
                id: "sent-msg-1",
                channel: { id: "10001", type: 0 },
                content: '<at id="9"/>你好',
            },
        ]);
        expect(api.setChannelType).toHaveBeenCalledWith("10001", true);
        const [peer, elements] = api.msgApi.sendMessage.mock.calls[0] as unknown as [
            { chatType: number; peerUid: string },
            Array<{ type: string }>,
        ];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "10001" });
        // at 已转 canonical（uid 化）
        expect(elements).toEqual([
            { type: "at", target: "uid_9" },
            { type: "text", text: "你好" },
        ]);
    });

    it("私聊频道：channel type=1，setChannelType(false)", async () => {
        const api = stubSatoriApi();
        api.resolvePeer.mockResolvedValueOnce({
            chatType: ChatType.C2C,
            peerUid: "uid_90001",
        } as never);
        const action = new MessageCreateAction(makeDeps(api));
        const messages = await action.run({ channel_id: "90001", content: "hi" });
        expect(messages[0]?.channel).toEqual({ id: "90001", type: 1 });
        expect(api.setChannelType).toHaveBeenCalledWith("90001", false);
    });

    it("referrer 透传但不参与发送（schema 接受）", async () => {
        const api = stubSatoriApi();
        const action = new MessageCreateAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", content: "x", referrer: { a: 1 } }),
        ).resolves.toHaveLength(1);
    });

    it("缺 content → SatoriActionError(400)", async () => {
        const action = new MessageCreateAction(makeDeps(stubSatoriApi()));
        await expect(action.run({ channel_id: "10001" })).rejects.toMatchObject({
            status: 400,
            message: "参数校验失败",
        });
    });
});

describe("MessageGetAction", () => {
    it("fetchMsgsByMsgId → toSatoriMessage 翻译（guild/channel/user 提升）", async () => {
        const api = stubSatoriApi();
        api.msgApi.fetchMsgsByMsgId.mockResolvedValueOnce([makeRawMsg()] as never);
        const action = new MessageGetAction(makeDeps(api));
        const message = await action.run({ channel_id: "10001", message_id: "m1" });
        expect(message.id).toBe("m1");
        expect(message.guild).toEqual({ id: "10001", name: "测试群" });
        expect(message.channel).toEqual({ id: "10001", type: 0, name: "测试群" });
        expect(api.setChannelType).toHaveBeenCalledWith("10001", true);
        expect(api.msgApi.fetchMsgsByMsgId).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            ["m1"],
        );
    });

    it("消息不存在（空列表）：抛「消息不存在」（500）", async () => {
        const api = stubSatoriApi();
        const action = new MessageGetAction(makeDeps(api));
        await expect(action.run({ channel_id: "10001", message_id: "gone" })).rejects.toMatchObject(
            { status: 500, message: "消息不存在" },
        );
    });
});

describe("MessageListAction", () => {
    it("缺省（asc）：QQ 时间倒序结果反转；next = 输出末条 id（实现现状，锁注释与代码的差异）", async () => {
        const api = stubSatoriApi();
        const older = makeRawMsg({ msgId: "older", msgTime: "1700000000" });
        const newer = makeRawMsg({ msgId: "newer", msgTime: "1700000001" });
        // 原生返回新→旧
        api.msgApi.fetchMessages.mockResolvedValueOnce([newer, older] as never);
        const action = new MessageListAction(makeDeps(api));
        // limit=2 与 raw 数量相等 → 触发 next 令牌
        const result = await action.run({ channel_id: "10001", limit: 2 });
        expect(result.data.map((m) => m.id)).toEqual(["older", "newer"]);
        expect(result.next).toBe("newer");
    });

    it("order=desc：保持原生新→旧顺序，next = 末条（更早）id", async () => {
        const api = stubSatoriApi();
        const older = makeRawMsg({ msgId: "older" });
        const newer = makeRawMsg({ msgId: "newer" });
        api.msgApi.fetchMessages.mockResolvedValueOnce([newer, older] as never);
        const action = new MessageListAction(makeDeps(api));
        const result = await action.run({ channel_id: "10001", order: "desc", limit: 2 });
        expect(result.data.map((m) => m.id)).toEqual(["newer", "older"]);
        expect(result.next).toBe("older");
    });

    it("next 透传为游标 msgId；limit 透传", async () => {
        const api = stubSatoriApi();
        api.msgApi.fetchMessages.mockResolvedValueOnce([makeRawMsg({ msgId: "a" })] as never);
        const action = new MessageListAction(makeDeps(api));
        await action.run({ channel_id: "10001", next: "cursor-1", limit: 10 });
        expect(api.msgApi.fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { count: 10, msgId: "cursor-1" },
        );
    });

    it("raw 数量 < count：不写 next（已是最后一页）", async () => {
        const api = stubSatoriApi();
        api.msgApi.fetchMessages.mockResolvedValueOnce([makeRawMsg({ msgId: "only" })] as never);
        const action = new MessageListAction(makeDeps(api));
        const result = await action.run({ channel_id: "10001", limit: 50 });
        expect(result.next).toBeUndefined();
    });

    it("direction=around：抛「暂不支持 around 方向」（500）", async () => {
        const api = stubSatoriApi();
        const action = new MessageListAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", direction: "around" }),
        ).rejects.toMatchObject({ status: 500, message: "暂不支持 around 方向" });
    });

    it("direction=before：合法方向", async () => {
        const api = stubSatoriApi();
        api.msgApi.fetchMessages.mockResolvedValueOnce([makeRawMsg()] as never);
        const action = new MessageListAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", direction: "before" }),
        ).resolves.toHaveProperty("data");
    });

    it("limit 非整数 → SatoriActionError(400)", async () => {
        const api = stubSatoriApi();
        const action = new MessageListAction(makeDeps(api));
        await expect(action.run({ channel_id: "10001", limit: 1.5 })).rejects.toBeInstanceOf(
            SatoriActionError,
        );
    });
});

describe("MessageDeleteAction", () => {
    it("resolvePeer → recallMessage(peer, [message_id])", async () => {
        const api = stubSatoriApi();
        const action = new MessageDeleteAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", message_id: "m1" }),
        ).resolves.toBeUndefined();
        expect(api.msgApi.recallMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            ["m1"],
        );
    });

    it("kernel 发送失败（KernelError）→ SatoriActionError 透传状态码", async () => {
        const api = stubSatoriApi();
        const { kernelError } = await import("@napuketto/kernel");
        api.msgApi.recallMessage.mockRejectedValueOnce(
            kernelError("无权限撤回", "PERMISSION_DENIED"),
        );
        const action = new MessageDeleteAction(makeDeps(api));
        await expect(action.run({ channel_id: "10001", message_id: "m1" })).rejects.toMatchObject({
            status: 403,
            message: "无权限撤回",
        });
    });
});

describe("消息动作错误映射", () => {
    it("非 KernelError 的意外错误 → 500 包装", async () => {
        const api = stubSatoriApi();
        api.msgApi.sendMessage.mockRejectedValueOnce(new Error("boom"));
        const action = new MessageCreateAction(makeDeps(api));
        await expect(action.run({ channel_id: "10001", content: "x" })).rejects.toMatchObject({
            status: 500,
            message: "boom",
        });
    });

    it("resolvePeer 抛 KernelError NOT_FOUND → 404", async () => {
        const api = stubSatoriApi();
        const { kernelError } = await import("@napuketto/kernel");
        api.resolvePeer.mockRejectedValueOnce(kernelError("频道不存在", "NOT_FOUND"));
        const action = new MessageCreateAction(makeDeps(api));
        await expect(action.run({ channel_id: "404", content: "x" })).rejects.toMatchObject({
            status: 404,
        });
    });
});

describe("消息翻译依赖注入（uidToUin 箭头透传）", () => {
    it("message.get：含 at 的消息触发 uidToUin 转换（at 显示 uin）", async () => {
        const api = stubSatoriApi();
        api.uidToUin.mockResolvedValueOnce(new Map([["sender-uid-1", "90001"]]));
        api.msgApi.fetchMsgsByMsgId.mockResolvedValueOnce([
            makeRawMsg({
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "", atType: 2, atUid: "sender-uid-1" },
                    },
                ],
            }),
        ] as never);
        const action = new MessageGetAction(makeDeps(api));
        const message = await action.run({ channel_id: "10001", message_id: "m1" });
        expect(api.uidToUin).toHaveBeenCalledWith(["sender-uid-1"]);
        // at 元素渲染为 <at id="90001"/>
        expect(message.content).toBe('<at id="90001"/>');
    });

    it("message.list：含 at 的消息同样触发批量转换", async () => {
        const api = stubSatoriApi();
        api.uidToUin.mockResolvedValueOnce(new Map([["sender-uid-1", "90001"]]));
        api.msgApi.fetchMessages.mockResolvedValueOnce([
            makeRawMsg({
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "", atType: 2, atUid: "sender-uid-1" },
                    },
                ],
            }),
        ] as never);
        const action = new MessageListAction(makeDeps(api));
        const result = await action.run({ channel_id: "10001" });
        expect(api.uidToUin).toHaveBeenCalledWith(["sender-uid-1"]);
        expect(result.data[0]?.content).toBe('<at id="90001"/>');
    });
});
