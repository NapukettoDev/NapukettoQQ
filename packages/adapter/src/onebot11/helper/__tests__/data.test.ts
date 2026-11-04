/**
 * helper/data 翻译层测试：canonical ↔ OB11 segment 批量转换、接收/发送方向
 * ID 空间转换上下文（collect/applyReceive、applySend）、CQ 码 ↔ canonical。
 *
 * 锁定行为：无法表达的元素静默跳过、at-all 不参与转换、转换失败原样保留、
 * 空上下文短路返回原数组、reply 非 NaN 数字才走反查。
 */

import type { CanonicalElement } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import {
    applyReceiveContext,
    applySendContext,
    canonicalToCqMessage,
    canonicalToSegments,
    collectReceiveNeeds,
    cqMessageToCanonical,
    cqMessageToSegments,
    segmentsToCanonical,
} from "../data.js";

describe("canonicalToSegments / segmentsToCanonical（批量）", () => {
    it("text/at/reply 互转", () => {
        const canonical: CanonicalElement[] = [
            { type: "text", text: "你好" },
            { type: "at", target: "u1", display: "甲" },
            { type: "reply", messageId: "nt-9" },
        ];
        const segments = canonicalToSegments(canonical);
        expect(segments).toEqual([
            { type: "text", data: { text: "你好" } },
            { type: "at", data: { qq: "u1", name: "甲" } },
            { type: "reply", data: { id: "nt-9" } },
        ]);
        const roundTrip = segmentsToCanonical(segments);
        expect(roundTrip).toEqual([
            { type: "text", text: "你好" },
            // at 段 name → canonical display（往返保留显示名）
            { type: "at", target: "u1", display: "甲" },
            { type: "reply", messageId: "nt-9" },
        ]);
    });

    it("无法表达的 canonical（unknown）静默跳过；未知 segment 兜底按 xml 处理", () => {
        expect(canonicalToSegments([{ type: "unknown", raw: { x: 1 } }])).toEqual([]);
        expect(segmentsToCanonical([{ type: "bogus", data: {} } as never])).toEqual([
            { type: "xml", raw: undefined },
        ]);
    });
});

describe("collectReceiveNeeds / applyReceiveContext（接收方向）", () => {
    it("收集 at uid（去重、排除 all）与 reply msgId", () => {
        const elements: CanonicalElement[] = [
            { type: "at", target: "u1" },
            { type: "at", target: "u1" },
            { type: "at", target: "all" },
            { type: "reply", messageId: "nt-1" },
        ];
        const { atUids, replyMsgIds } = collectReceiveNeeds(elements);
        expect(atUids).toEqual(["u1"]);
        expect(replyMsgIds).toEqual(["nt-1"]);
    });

    it("applyReceiveContext：at uid→uin、reply NT msgId→OB11 id；未命中原样", () => {
        const elements: CanonicalElement[] = [
            { type: "at", target: "u1" },
            { type: "at", target: "u-miss" },
            { type: "at", target: "all" },
            { type: "reply", messageId: "nt-1" },
            { type: "reply", messageId: "nt-miss" },
            { type: "text", text: "正文" },
        ];
        const out = applyReceiveContext(elements, {
            uidToUin: new Map([["u1", "10001"]]),
            msgIdToOb11Id: (msgId) => (msgId === "nt-1" ? 42 : undefined),
        });
        expect(out).toEqual([
            { type: "at", target: "10001" },
            { type: "at", target: "u-miss" },
            { type: "at", target: "all" },
            { type: "reply", messageId: "42" },
            { type: "reply", messageId: "nt-miss" },
            { type: "text", text: "正文" },
        ]);
    });

    it("空上下文 → 短路返回原数组引用", () => {
        const elements: CanonicalElement[] = [{ type: "text", text: "x" }];
        expect(applyReceiveContext(elements, {})).toBe(elements);
    });
});

describe("applySendContext（发送方向）", () => {
    it("at uin→uid、reply OB11 id→NT msgId；未命中原样透传", () => {
        const elements: CanonicalElement[] = [
            { type: "at", target: "90001" },
            { type: "at", target: "all" },
            { type: "reply", messageId: "1" },
            { type: "reply", messageId: "999" },
        ];
        const out = applySendContext(elements, {
            uinToUid: new Map([["90001", "u90001"]]),
            ob11IdToMsgId: (id) => (id === 1 ? "nt-1" : undefined),
        });
        expect(out).toEqual([
            { type: "at", target: "u90001" },
            { type: "at", target: "all" },
            { type: "reply", messageId: "nt-1" },
            { type: "reply", messageId: "999" },
        ]);
    });

    it("reply messageId 非 NaN 数字才反查；非数字原样（兼容 NT msgId 直传）", () => {
        const translate = vi.fn(() => "nt-x");
        const out = applySendContext([{ type: "reply", messageId: "not-a-number" }], {
            ob11IdToMsgId: translate,
        });
        expect(out).toEqual([{ type: "reply", messageId: "not-a-number" }]);
        expect(translate).not.toHaveBeenCalled();
    });

    it("空上下文 → 短路返回原数组引用", () => {
        const elements: CanonicalElement[] = [{ type: "at", target: "1" }];
        expect(applySendContext(elements, {})).toBe(elements);
    });
});

describe("CQ 码 ↔ canonical", () => {
    it("cqMessageToSegments：文本 + CQ 码混合、未知 CQ 类型保留为 text 原文", () => {
        expect(cqMessageToSegments("a[CQ:at,qq=1]b")).toEqual([
            { type: "text", data: { text: "a" } },
            { type: "at", data: { qq: "1" } },
            { type: "text", data: { text: "b" } },
        ]);
        // 相邻 CQ 码之间的空文本段跳过（parseCqMessage 产出空串 part）
        expect(cqMessageToSegments("[CQ:at,qq=1][CQ:at,qq=2]")).toEqual([
            { type: "at", data: { qq: "1" } },
            { type: "at", data: { qq: "2" } },
        ]);
        expect(cqMessageToSegments("[CQ:unknowntype,k=1]")).toEqual([
            { type: "text", data: { text: "[CQ:unknowntype,k=1]" } },
        ]);
    });

    it("cqMessageToCanonical / canonicalToCqMessage 往返（text+at）", () => {
        const canonical = cqMessageToCanonical("hi[CQ:at,qq=90001]");
        expect(canonical).toEqual([
            { type: "text", text: "hi" },
            { type: "at", target: "90001" },
        ]);
        expect(canonicalToCqMessage(canonical)).toBe("hi[CQ:at,qq=90001]");
    });

    it("CQ 全类型构造器映射（video/file/reply/forward/json/xml）", () => {
        const segments = cqMessageToSegments(
            "[CQ:record,file=v.silk]" +
                "[CQ:video,file=v.mp4]" +
                "[CQ:file,file=a.zip]" +
                "[CQ:reply,id=42]" +
                "[CQ:forward,id=fwd-1]" +
                '[CQ:json,data={"x":1}]' +
                "[CQ:xml,data=<x/>]",
        );
        expect(segments).toEqual([
            { type: "record", data: { file: "v.silk" } },
            { type: "video", data: { file: "v.mp4" } },
            { type: "file", data: { file: "a.zip" } },
            { type: "reply", data: { id: "42" } },
            { type: "forward", data: { id: "fwd-1" } },
            { type: "json", data: { data: '{"x":1}' } },
            { type: "xml", data: { data: "<x/>" } },
        ]);
        // json/xml 段 → canonical（raw 透传）
        const canonical = segmentsToCanonical(segments);
        expect(canonical.slice(-2)).toEqual([
            { type: "json", raw: '{"x":1}' },
            { type: "xml", raw: "<x/>" },
        ]);
    });
});
