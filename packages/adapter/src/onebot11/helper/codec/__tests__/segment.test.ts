/**
 * segment.ts 基线测试（fallow refactoring target #3，untested risk）
 * 锁定 canonicalToSegment / segmentToCanonical / cqCodeToSegment /
 * segmentsToCqMessage 现有行为，重构后回归。
 */
import { describe, expect, it } from "vitest";
import type { OB11MessageSegment } from "../../../types/index.js";
import {
    canonicalToSegment,
    cqCodeToSegment,
    parseOB11MessageSegments,
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

    it("file → file 段（name 优先，缺省 path；透出）", () => {
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

describe("parseOB11MessageSegments（入站段守卫）", () => {
    /** 捕获抛错的 code（断言协议边界错误语义）。 */
    function codeOf(fn: () => unknown): string {
        try {
            fn();
        } catch (err) {
            return (err as { code: string }).code;
        }
        return "no-throw";
    }

    it("合法段数组原样返回", () => {
        const segs = [
            { type: "text", data: { text: "hi" } },
            { type: "image", data: { file: "/a.png" } },
            { type: "at", data: { qq: "123" } },
        ];
        expect(parseOB11MessageSegments(segs)).toEqual(segs);
        expect(parseOB11MessageSegments([])).toEqual([]);
    });

    it("[null] / 缺 data / 未知 type → INVALID_PARAM（不整数组强转）", () => {
        expect(codeOf(() => parseOB11MessageSegments([null]))).toBe("INVALID_PARAM");
        expect(codeOf(() => parseOB11MessageSegments([{ type: "text" }]))).toBe("INVALID_PARAM");
        expect(codeOf(() => parseOB11MessageSegments([{ type: "poke", data: {} }]))).toBe(
            "INVALID_PARAM",
        );
        expect(codeOf(() => parseOB11MessageSegments([{ type: "text", data: { text: 1 } }]))).toBe(
            "INVALID_PARAM",
        );
    });

    it("已知段缺必填字段 → INVALID_PARAM", () => {
        expect(
            codeOf(() => parseOB11MessageSegments([{ type: "image", data: { url: "http://x" } }])),
        ).toBe("INVALID_PARAM");
        expect(codeOf(() => parseOB11MessageSegments([{ type: "record", data: {} }]))).toBe(
            "INVALID_PARAM",
        );
        expect(codeOf(() => parseOB11MessageSegments([{ type: "face", data: {} }]))).toBe(
            "INVALID_PARAM",
        );
    });

    it("数值型 id（OB11 允许）容忍，并在转换时归一为字符串", () => {
        /** 取唯一解析结果（缺失即测试前置断言失败）。 */
        function single(raw: unknown[]): OB11MessageSegment {
            const [first] = parseOB11MessageSegments(raw);
            if (first === undefined) {
                throw new Error("解析结果为空");
            }
            return first;
        }
        expect(segmentToCanonical(single([{ type: "at", data: { qq: 90001 } }]))).toEqual({
            type: "at",
            target: "90001",
        });
        expect(segmentToCanonical(single([{ type: "face", data: { id: 7 } }]))).toEqual({
            type: "face",
            id: "7",
        });
        expect(segmentToCanonical(single([{ type: "reply", data: { id: 42 } }]))).toEqual({
            type: "reply",
            messageId: "42",
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

describe("cqCodeToSegment：params 缺失兜底", () => {
    it("各已知类型 params 为空对象 → data 值用空串兜底", () => {
        const cases: [string, Record<string, unknown>][] = [
            ["text", { text: "" }],
            ["at", { qq: "" }],
            ["face", { id: "" }],
            ["image", { file: "" }],
            ["record", { file: "" }],
            ["video", { file: "" }],
            ["file", { file: "" }],
            ["reply", { id: "" }],
            ["forward", { id: "" }],
            ["json", { data: "" }],
            ["xml", { data: "" }],
        ];
        for (const [type, data] of cases) {
            expect(cqCodeToSegment({ type, params: {} })).toEqual({ type, data });
        }
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
