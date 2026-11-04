/**
 * core/shared/raw-message.test.ts：RawMessage 数组规范化单测（OB11 / Satori 共用）。
 *
 * 锁定：数组/单对象/null/非对象项的规范化语义；subscribeRawMessages
 * 订阅包装与退订。
 */

import type { MsgEventChannel } from "@napuketto/kernel";
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { forEachRawMessage, subscribeRawMessages } from "../shared/raw-message.js";

/** 构造最小合法 RawMessage。 */
function makeMsg(msgId: string): RawMessage {
    return {
        msgId,
        msgSeq: "1",
        msgTime: "0",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "g1",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "1",
        peerName: "群",
        sendNickName: "",
        elements: [],
    };
}

describe("forEachRawMessage", () => {
    it("数组入参：逐条回调", () => {
        const seen: string[] = [];
        forEachRawMessage([makeMsg("a"), makeMsg("b")], (msg) => {
            seen.push(msg.msgId);
        });
        expect(seen).toEqual(["a", "b"]);
    });

    it("单对象入参：规范化为单元素数组", () => {
        const seen: string[] = [];
        forEachRawMessage(makeMsg("solo"), (msg) => {
            seen.push(msg.msgId);
        });
        expect(seen).toEqual(["solo"]);
    });

    it("null / undefined / 非对象项：过滤掉不回调", () => {
        const seen: string[] = [];
        forEachRawMessage(
            [null, undefined, 42, "str", makeMsg("ok")] as unknown as unknown,
            (msg) => {
                seen.push(msg.msgId);
            },
        );
        expect(seen).toEqual(["ok"]);
    });

    it("纯 null 入参：不回调、不抛错", () => {
        const seen: string[] = [];
        forEachRawMessage(null, (msg) => {
            seen.push(msg.msgId);
        });
        expect(seen).toEqual([]);
    });
});

describe("subscribeRawMessages", () => {
    it("包装 channel.on：回调参数逐条规范化后交给 handler", () => {
        let callback: ((msgs: unknown) => void) | undefined;
        const channel = {
            on: vi.fn((_event: string, cb: (msgs: unknown) => void) => {
                callback = cb;
                return () => undefined;
            }),
        } as unknown as MsgEventChannel;
        const handler = vi.fn();
        subscribeRawMessages(channel, handler);
        expect(channel.on).toHaveBeenCalledWith("Msg/onRecvMsg", expect.any(Function));
        callback?.(makeMsg("x"));
        callback?.([makeMsg("y"), "垃圾", null]);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler.mock.calls.map((c) => (c[0] as RawMessage).msgId)).toEqual(["x", "y"]);
    });

    it("返回退订函数：直接透传 channel.on 的返回值", () => {
        const unsub = vi.fn(() => undefined);
        const channel = {
            on: vi.fn(() => unsub),
        } as unknown as MsgEventChannel;
        const result = subscribeRawMessages(channel, () => undefined);
        result();
        expect(unsub).toHaveBeenCalledTimes(1);
    });
});
