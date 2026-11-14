/**
 * shared/raw-message.test.ts：RawMessage 规范化 + msgTime 归一单测（跨协议共用）。
 *
 * 锁定：数组/单对象/null/非对象项的规范化语义；subscribeRawMessages
 * 订阅包装与退订。
 */

import type { MsgEventChannel } from "@napuketto/kernel";
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { forEachRawMessage, subscribeRawMessages, toUnixSeconds } from "../raw-message.js";
import { stub } from "./stub.js";

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
        const garbage: unknown = [null, undefined, 42, "str", makeMsg("ok")];
        forEachRawMessage(garbage, (msg) => {
            seen.push(msg.msgId);
        });
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
        const channel = stub<MsgEventChannel>({
            on: vi.fn((_event: string, cb: (msgs: unknown) => void) => {
                callback = cb;
                return () => undefined;
            }),
        });
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
        const channel = stub<MsgEventChannel>({
            on: vi.fn(() => unsub),
        });
        const result = subscribeRawMessages(channel, () => undefined);
        result();
        expect(unsub).toHaveBeenCalledTimes(1);
    });
});

describe("toUnixSeconds（msgTime 单位归一）", () => {
    it("毫秒字符串 → 秒（Windows QQNT 形态）", () => {
        expect(toUnixSeconds("1700000000000")).toBe(1_700_000_000);
        expect(toUnixSeconds("1700000000123")).toBe(1_700_000_000);
    });

    it("秒字符串 → 原样（Linux 3.2.x 原生 wrapper 形态）", () => {
        expect(toUnixSeconds("1794307394")).toBe(1_794_307_394);
    });

    it("数字输入同样按量级归一", () => {
        expect(toUnixSeconds(1_700_000_000_123)).toBe(1_700_000_000);
        expect(toUnixSeconds(1_794_307_394)).toBe(1_794_307_394);
    });

    it("空 / 非法 / 非正 → 0（调用方决定兜底）", () => {
        expect(toUnixSeconds(undefined)).toBe(0);
        expect(toUnixSeconds("")).toBe(0);
        expect(toUnixSeconds("abc")).toBe(0);
        expect(toUnixSeconds("0")).toBe(0);
        expect(toUnixSeconds(-1)).toBe(0);
    });
});
