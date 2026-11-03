/**
 * segment.ts 基线测试（fallow refactoring target #3，untested risk）
 * 锁定 canonicalToSegment / segmentToCanonical / cqCodeToSegment /
 * segmentsToCqMessage 现有行为，重构后回归。
 */
import { describe, expect, it } from "vitest";
import {
    canonicalToSegment,
    cqCodeToSegment,
    segmentsToCqMessage,
    segmentToCanonical,
} from "../segment.js";

describe("canonicalToSegment", () => {
    it("text → text 段", () => {
        expect(canonicalToSegment({ type: "text", text: "你好" })).toEqual({
            type: "text",
            data: { text: "你好" },
        });
    });

    it("at → at 段（display 可选）", () => {
        expect(canonicalToSegment({ type: "at", target: "u_abc" })).toEqual({
            type: "at",
            data: { qq: "u_abc" },
        });
        expect(canonicalToSegment({ type: "at", target: "u_abc", display: "小明" })).toEqual({
            type: "at",
            data: { qq: "u_abc", name: "小明" },
        });
    });

    it("image/voice/video → 媒体段（url 可选）", () => {
        expect(canonicalToSegment({ type: "image", path: "/a.png" })).toEqual({
            type: "image",
            data: { file: "/a.png" },
        });
        expect(
            canonicalToSegment({ type: "image", path: "/a.png", url: "http://x/a.png" }),
        ).toEqual({
            type: "image",
            data: { file: "/a.png", url: "http://x/a.png" },
        });
        expect(canonicalToSegment({ type: "voice", path: "/a.silk" })).toEqual({
            type: "record",
            data: { file: "/a.silk" },
        });
        expect(canonicalToSegment({ type: "video", path: "/a.mp4" })).toEqual({
            type: "video",
            data: { file: "/a.mp4" },
        });
    });

    it("face/reply/forward → 对应段", () => {
        expect(canonicalToSegment({ type: "face", id: "1" })).toEqual({
            type: "face",
            data: { id: "1" },
        });
        expect(canonicalToSegment({ type: "reply", messageId: "m1" })).toEqual({
            type: "reply",
            data: { id: "m1" },
        });
        expect(canonicalToSegment({ type: "forward", messageIds: ["f1"] })).toEqual({
            type: "forward",
            data: { id: "f1" },
        });
        expect(canonicalToSegment({ type: "forward", messageIds: [] })).toEqual({
            type: "forward",
            data: { id: "" },
        });
    });

    it("json/xml raw 对象序列化为字符串", () => {
        expect(canonicalToSegment({ type: "json", raw: { app: "x" } })).toEqual({
            type: "json",
            data: { data: '{"app":"x"}' },
        });
        expect(canonicalToSegment({ type: "xml", raw: "<msg/>" })).toEqual({
            type: "xml",
            data: { data: "<msg/>" },
        });
    });

    it("file → file 段（name 优先，缺省 path；B4 透出）", () => {
        expect(canonicalToSegment({ type: "file", path: "/a.bin", name: "a.bin" })).toEqual({
            type: "file",
            data: { file: "a.bin" },
        });
        expect(canonicalToSegment({ type: "file", path: "/cache/a.bin" })).toEqual({
            type: "file",
            data: { file: "/cache/a.bin" },
        });
    });

    it("未知类型 → null（OB11 无法表达跳过）", () => {
        expect(canonicalToSegment({ type: "unknown" } as never)).toBeNull();
    });
});

describe("segmentToCanonical", () => {
    it("text/string → text 元素", () => {
        expect(segmentToCanonical({ type: "text", data: { text: "你好" } })).toEqual({
            type: "text",
            text: "你好",
        });
        expect(segmentToCanonical({ type: "string", data: { text: "s" } })).toEqual({
            type: "text",
            text: "s",
        });
    });

    it("at → at 元素（name 可选）", () => {
        expect(segmentToCanonical({ type: "at", data: { qq: "123" } })).toEqual({
            type: "at",
            target: "123",
        });
        expect(segmentToCanonical({ type: "at", data: { qq: "123", name: "小明" } })).toEqual({
            type: "at",
            target: "123",
            display: "小明",
        });
    });

    it("face/image/record/video → canonical", () => {
        expect(segmentToCanonical({ type: "face", data: { id: "1" } })).toEqual({
            type: "face",
            id: "1",
        });
        expect(segmentToCanonical({ type: "image", data: { file: "/a.png" } })).toEqual({
            type: "image",
            path: "/a.png",
        });
        expect(
            segmentToCanonical({ type: "image", data: { file: "/a.png", url: "http://x" } }),
        ).toEqual({
            type: "image",
            path: "/a.png",
            url: "http://x",
        });
        expect(segmentToCanonical({ type: "record", data: { file: "/a.silk" } })).toEqual({
            type: "voice",
            path: "/a.silk",
        });
        expect(segmentToCanonical({ type: "video", data: { file: "/a.mp4" } })).toEqual({
            type: "video",
            path: "/a.mp4",
        });
    });

    it("reply/forward/json/xml → canonical", () => {
        expect(segmentToCanonical({ type: "reply", data: { id: "m1" } })).toEqual({
            type: "reply",
            messageId: "m1",
        });
        expect(segmentToCanonical({ type: "forward", data: { id: "f1" } })).toEqual({
            type: "forward",
            messageIds: ["f1"],
        });
        expect(segmentToCanonical({ type: "json", data: { data: '{"app":"x"}' } })).toEqual({
            type: "json",
            raw: '{"app":"x"}',
        });
        expect(segmentToCanonical({ type: "xml", data: { data: "<msg/>" } })).toEqual({
            type: "xml",
            raw: "<msg/>",
        });
    });
});

describe("cqCodeToSegment", () => {
    it("已知 CQ 类型 → segment", () => {
        expect(cqCodeToSegment({ type: "text", params: { text: "hi" } })).toEqual({
            type: "text",
            data: { text: "hi" },
        });
        expect(cqCodeToSegment({ type: "at", params: { qq: "123" } })).toEqual({
            type: "at",
            data: { qq: "123" },
        });
        expect(cqCodeToSegment({ type: "face", params: { id: "1" } })).toEqual({
            type: "face",
            data: { id: "1" },
        });
        expect(cqCodeToSegment({ type: "image", params: { file: "/a.png" } })).toEqual({
            type: "image",
            data: { file: "/a.png" },
        });
        expect(cqCodeToSegment({ type: "reply", params: { id: "m1" } })).toEqual({
            type: "reply",
            data: { id: "m1" },
        });
    });

    it("未知 CQ 类型 → text 段保留原文", () => {
        expect(cqCodeToSegment({ type: "rps", params: { type: "1" } })).toEqual({
            type: "text",
            data: { text: "[CQ:rps,type=1]" },
        });
    });
});

describe("segmentsToCqMessage", () => {
    it("text 转义（& [ ]）+ 特殊段编码（< > 不转义）", () => {
        expect(
            segmentsToCqMessage([
                { type: "text", data: { text: "a&b<c>" } },
                { type: "face", data: { id: "1" } },
            ]),
        ).toBe("a&amp;b<c>[CQ:face,id=1]");
        expect(segmentsToCqMessage([{ type: "text", data: { text: "[x]" } }])).toBe("&#91;x&#93;");
    });

    it("空数组 → 空串", () => {
        expect(segmentsToCqMessage([])).toBe("");
    });
});
