/**
 * qq/raw-message.test.ts：RawMessage 规范化 + msgTime 归一 + 启动前历史消息
 * 拦截单测（跨协议共用）。
 *
 * 锁定：数组/单对象/null/非对象项的规范化语义；subscribeRawMessages
 * 订阅包装与退订；启动基准（订阅时刻 −5s 容差）内的实时消息放行、早于基准的
 * 历史积压丢弃、msgTime 缺失/非法放行（issue #122）。
 */

import type { MsgEventChannel } from "@napuketto/kernel";
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    forEachRawMessage,
    isLiveMessage,
    subscribeRawMessages,
    toUnixSeconds,
} from "../../../src/internal/qq/raw-message.js";
import { STARTUP_GRACE_SEC } from "../../../src/internal/qq/startup-cutoff.js";
import { stub } from "../stub.js";

/** 构造最小合法 RawMessage。 */
function makeMsg(msgId: string, msgTime = "0"): RawMessage {
    return {
        msgId,
        msgSeq: "1",
        msgTime,
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

    describe("启动前历史消息拦截（issue #122）", () => {
        /** 当前时刻（固定，便于构造基准附近的样本）。 */
        const NowSec = 1_794_307_394;

        /** 捕获订阅回调。 */
        function captureChannel(): {
            channel: MsgEventChannel;
            emit: (msgs: unknown) => void;
        } {
            let callback: ((msgs: unknown) => void) | undefined;
            const channel = stub<MsgEventChannel>({
                on: vi.fn((_event: string, cb: (msgs: unknown) => void) => {
                    callback = cb;
                    return () => undefined;
                }),
            });
            return {
                channel,
                emit: (msgs) => callback?.(msgs),
            };
        }

        afterEach(() => {
            vi.useRealTimers();
        });

        it("早于基准（含 QQNT 重连重放的历史消息）→ 丢弃，不交给 handler", () => {
            vi.useFakeTimers();
            vi.setSystemTime(NowSec * 1000);
            const { channel, emit } = captureChannel();
            const handler = vi.fn();
            subscribeRawMessages(channel, handler);
            // 几天前的离线消息 + 昨天的消息，均在容差外
            emit([
                makeMsg("old-1", String((NowSec - 86_400) * 1000)),
                makeMsg("old-2", String(NowSec - 3 * 86_400)),
            ]);
            expect(handler).not.toHaveBeenCalled();
        });

        it("基准时刻 / 容差内的消息 → 放行（握手期到达的实时消息不错杀）", () => {
            vi.useFakeTimers();
            vi.setSystemTime(NowSec * 1000);
            const { channel, emit } = captureChannel();
            const handler = vi.fn();
            subscribeRawMessages(channel, handler);
            emit([
                makeMsg("now-ms", String(NowSec * 1000)),
                makeMsg("grace", String(NowSec - STARTUP_GRACE_SEC)),
            ]);
            expect(handler.mock.calls.map((c) => (c[0] as RawMessage).msgId)).toEqual([
                "now-ms",
                "grace",
            ]);
        });

        it("msgTime 缺失 / 非法（归一为 0）→ 放行（宁可多报不错杀）", () => {
            vi.useFakeTimers();
            vi.setSystemTime(NowSec * 1000);
            const { channel, emit } = captureChannel();
            const handler = vi.fn();
            subscribeRawMessages(channel, handler);
            emit([makeMsg("zero", "0"), makeMsg("nan", "abc")]);
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it("同批混有历史与实时消息：只报实时那条", () => {
            vi.useFakeTimers();
            vi.setSystemTime(NowSec * 1000);
            const { channel, emit } = captureChannel();
            const handler = vi.fn();
            subscribeRawMessages(channel, handler);
            emit([
                makeMsg("old", String((NowSec - 3_600) * 1000)),
                makeMsg("live", String(NowSec * 1000)),
                makeMsg("old2", String((NowSec - 60) * 1000)),
            ]);
            expect(handler.mock.calls.map((c) => (c[0] as RawMessage).msgId)).toEqual(["live"]);
        });

        it("拦截条数按 debug 留痕（一次回调一条日志，不逐条刷屏）", () => {
            vi.useFakeTimers();
            vi.setSystemTime(NowSec * 1000);
            const { channel, emit } = captureChannel();
            const debug = vi.fn();
            subscribeRawMessages(channel, () => undefined, {
                logger: { warn: vi.fn(), info: vi.fn(), debug },
            });
            emit([makeMsg("o1", "1600000000"), makeMsg("o2", "1600000001")]);
            expect(debug).toHaveBeenCalledTimes(1);
            expect(debug).toHaveBeenCalledWith(
                { skipped: 2, minMsgTimeSec: NowSec - STARTUP_GRACE_SEC },
                expect.stringContaining("历史消息"),
            );
        });
    });

    describe("isLiveMessage", () => {
        it("0（缺失/非法）→ 放行；早于基准 → 丢；不早于基准 → 放行", () => {
            const baseline = 1_794_307_394;
            expect(isLiveMessage(makeMsg("a", "0"), baseline)).toBe(true);
            expect(isLiveMessage(makeMsg("b", "1794307393"), baseline)).toBe(false);
            expect(isLiveMessage(makeMsg("c", "1794307394"), baseline)).toBe(true);
        });
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
