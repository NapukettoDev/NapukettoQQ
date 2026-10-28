/**
 * message-element.ts toSendElements 基线测试（kernel 核心转换，fallow HIGH）
 *
 * 锁定 canonical → NT 发送元素的映射规则：
 *  - text / at（all 与单目标）/ face / image / voice / reply 六类核心
 *  - json → ARK 透传（bytesData 字符串原样 / 对象 JSON 序列化）
 *  - at 的 display 兜底 "@"、atType 区分 all(1)/单(2)
 *  - 不支持的 video/file/forward/xml/unknown → 抛 KernelError
 */
import { describe, expect, it } from "vitest";
import { isKernelError } from "../../infra/index.js";
import { toSendElements } from "../message-element.js";
import { ElementType } from "../services/msg-service.js";

describe("toSendElements", () => {
    it("text → TEXT 元素", () => {
        expect(toSendElements([{ type: "text", text: "你好" }])).toEqual([
            { elementType: ElementType.TEXT, textElement: { content: "你好" } },
        ]);
    });

    it("空数组 → 空输出", () => {
        expect(toSendElements([])).toEqual([]);
    });

    it("at all → TEXT atType=1（display 兜底 @）", () => {
        expect(toSendElements([{ type: "at", target: "all" }])).toEqual([
            { elementType: ElementType.TEXT, textElement: { content: "@", atType: 1 } },
        ]);
        expect(toSendElements([{ type: "at", target: "all", display: "全体成员" }])).toEqual([
            {
                elementType: ElementType.TEXT,
                textElement: { content: "全体成员", atType: 1 },
            },
        ]);
    });

    it("at 单目标 → TEXT atType=2 + atUid", () => {
        expect(toSendElements([{ type: "at", target: "u1" }])).toEqual([
            {
                elementType: ElementType.TEXT,
                textElement: { content: "@", atType: 2, atUid: "u1" },
            },
        ]);
        expect(toSendElements([{ type: "at", target: "u1", display: "小明" }])).toEqual([
            {
                elementType: ElementType.TEXT,
                textElement: { content: "小明", atType: 2, atUid: "u1" },
            },
        ]);
    });

    it("face → FACE 元素（id 数字转 number）", () => {
        expect(toSendElements([{ type: "face", id: "127" }])).toEqual([
            { elementType: ElementType.FACE, faceElement: { faceIndex: 127 } },
        ]);
    });

    it("image → PIC 元素（picPath）", () => {
        expect(toSendElements([{ type: "image", path: "/tmp/a.png" }])).toEqual([
            { elementType: ElementType.PIC, picElement: { picPath: "/tmp/a.png" } },
        ]);
    });

    it("voice → PTT 元素（filePath）", () => {
        expect(toSendElements([{ type: "voice", path: "/tmp/a.silk" }])).toEqual([
            { elementType: ElementType.PTT, pttElement: { filePath: "/tmp/a.silk" } },
        ]);
    });

    it("reply → REPLY 元素（replayMsgId/Seq/Time）", () => {
        expect(toSendElements([{ type: "reply", messageId: "m1" }])).toEqual([
            {
                elementType: ElementType.REPLY,
                replyElement: {
                    replayMsgId: "m1",
                    replayMsgSeq: "m1",
                    replayMsgTime: "0",
                },
            },
        ]);
    });

    it("混合列表按序输出", () => {
        expect(
            toSendElements([
                { type: "text", text: "hi" },
                { type: "face", id: "1" },
            ]),
        ).toEqual([
            { elementType: ElementType.TEXT, textElement: { content: "hi" } },
            { elementType: ElementType.FACE, faceElement: { faceIndex: 1 } },
        ]);
    });

    it("json → ARK 元素（bytesData 字符串透传，对象 JSON 序列化）", () => {
        expect(toSendElements([{ type: "json", raw: '{"app":"com.test.app"}' }])).toEqual([
            {
                elementType: ElementType.ARK,
                arkElement: { bytesData: '{"app":"com.test.app"}' },
            },
        ]);
        expect(toSendElements([{ type: "json", raw: { app: "com.test.app" } }])).toEqual([
            {
                elementType: ElementType.ARK,
                arkElement: { bytesData: '{"app":"com.test.app"}' },
            },
        ]);
    });

    it("不支持的类型抛 KernelError", () => {
        const unsupported = [
            { type: "video" as const, path: "/v.mp4" },
            { type: "file" as const, path: "/f.bin" },
            { type: "forward" as const, messageIds: ["m1"] },
            { type: "xml" as const, raw: "<a/>" },
            { type: "unknown" as const, raw: {} },
        ];
        for (const el of unsupported) {
            try {
                toSendElements([el]);
                expect.unreachable(`应抛 KernelError: ${el.type}`);
            } catch (e) {
                expect(isKernelError(e)).toBe(true);
            }
        }
    });
});
