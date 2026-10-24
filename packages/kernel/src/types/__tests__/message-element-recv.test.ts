/**
 * message-element.ts toCanonicalElements 基线测试（接收方向，fallow 真实覆盖率
 * 暴露 0% 覆盖的对称缺口）
 *
 * 锁定 NT 元素 → canonical 的接收映射规则：
 *  - TEXT：at all/单/我 → at；普通 → text
 *  - PIC/PTT/VIDEO/FILE：path 兜底（url 可选）
 *  - FACE/REPLY：id 转字符串
 *  - 未知 elementType → unknown（宽容不抛）
 *  - 子元素缺失 → 默认空值 canonical
 */
import { ChatType, type RawElement, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toCanonicalElements } from "../message-element.js";
import { ElementType } from "../services/msg-service.js";

/** 构造 RawMessage（elements 可覆盖）。 */
function makeMsg(elements: RawElement[]): RawMessage {
    return {
        msgId: "m1",
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
        elements,
    };
}

describe("toCanonicalElements", () => {
    it("TEXT 普通 → canonical text", () => {
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.TEXT, textElement: { content: "hi" } }]),
            ),
        ).toEqual([{ type: "text", text: "hi" }]);
    });

    it("TEXT at all → canonical at all", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.TEXT,
                        textElement: { content: "@全体成员", atType: 1 },
                    },
                ]),
            ),
        ).toEqual([{ type: "at", target: "all" }]);
    });

    it("TEXT at 单人（content 带 @ 前缀）→ at + display 剥 @", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.TEXT,
                        textElement: { content: "@小明", atType: 2, atUid: "u1" },
                    },
                ]),
            ),
        ).toEqual([{ type: "at", target: "u1", display: "小明" }]);
    });

    it("TEXT at 单人无 atUid → target 兜底 content", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    { elementType: ElementType.TEXT, textElement: { content: "@x", atType: 2 } },
                ]),
            ),
        ).toEqual([{ type: "at", target: "@x", display: "x" }]);
    });

    it("TEXT at 我（atType=4）→ at + display", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.TEXT,
                        textElement: { content: "@我", atType: 4, atUid: "self" },
                    },
                ]),
            ),
        ).toEqual([{ type: "at", target: "self", display: "我" }]);
    });

    it("TEXT 子元素缺失 → canonical text 空", () => {
        expect(toCanonicalElements(makeMsg([{ elementType: ElementType.TEXT }]))).toEqual([
            { type: "text", text: "" },
        ]);
    });

    it("PIC：有 url → path + url；无 url → 仅 path", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.PIC,
                        picElement: { picPath: "/p.png", picUrl: "https://x/p.png" },
                    },
                ]),
            ),
        ).toEqual([{ type: "image", path: "/p.png", url: "https://x/p.png" }]);
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.PIC, picElement: { picPath: "/p.png" } }]),
            ),
        ).toEqual([{ type: "image", path: "/p.png" }]);
    });

    it("PIC 无 path 无 url → path 空", () => {
        expect(toCanonicalElements(makeMsg([{ elementType: ElementType.PIC }]))).toEqual([
            { type: "image", path: "" },
        ]);
    });

    it("FACE → id 转字符串；子元素缺失 → '0'", () => {
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.FACE, faceElement: { faceIndex: 127 } }]),
            ),
        ).toEqual([{ type: "face", id: "127" }]);
        expect(toCanonicalElements(makeMsg([{ elementType: ElementType.FACE }]))).toEqual([
            { type: "face", id: "0" },
        ]);
    });

    it("PTT → voice；子元素缺失 → path 空", () => {
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.PTT, pttElement: { filePath: "/v.silk" } }]),
            ),
        ).toEqual([{ type: "voice", path: "/v.silk" }]);
        expect(toCanonicalElements(makeMsg([{ elementType: ElementType.PTT }]))).toEqual([
            { type: "voice", path: "" },
        ]);
    });

    it("VIDEO：有 url → path + url；无 → 仅 path", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", videoUrl: "https://x/v.mp4" },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4", url: "https://x/v.mp4" }]);
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.VIDEO, videoElement: { filePath: "/v.mp4" } }]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4" }]);
    });

    it("VIDEO thumbPath 三形态防御读取（Map / 序列化平面对象 / 字符串）", () => {
        // 进程内实测形态：Map<0, path>
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", thumbPath: new Map([[0, "/t.png"]]) },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4", thumbPath: "/t.png" }]);
        // IPC/JSON 序列化后形态（2026-10-24 线上报错回归：平面对象无 .get）
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", thumbPath: { "0": "/t.png" } },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4", thumbPath: "/t.png" }]);
        // 字符串路径兜底
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", thumbPath: "/t.png" },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4", thumbPath: "/t.png" }]);
    });

    it("VIDEO thumbPath 空值形态：空对象（stringify 丢内容）/ 空串 / 空值 key → 忽略", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", thumbPath: {} },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4" }]);
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", thumbPath: new Map([[0, ""]]) },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4" }]);
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "/v.mp4", thumbPath: "" },
                    },
                ]),
            ),
        ).toEqual([{ type: "video", path: "/v.mp4" }]);
    });

    it("FILE：有 fileName → name；无 → 仅 path", () => {
        expect(
            toCanonicalElements(
                makeMsg([
                    {
                        elementType: ElementType.FILE,
                        fileElement: { filePath: "/f.bin", fileName: "文档" },
                    },
                ]),
            ),
        ).toEqual([{ type: "file", path: "/f.bin", name: "文档" }]);
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.FILE, fileElement: { filePath: "/f.bin" } }]),
            ),
        ).toEqual([{ type: "file", path: "/f.bin" }]);
    });

    it("REPLY → reply", () => {
        expect(
            toCanonicalElements(
                makeMsg([{ elementType: ElementType.REPLY, replyElement: { replayMsgId: "m1" } }]),
            ),
        ).toEqual([{ type: "reply", messageId: "m1" }]);
        expect(toCanonicalElements(makeMsg([{ elementType: ElementType.REPLY }]))).toEqual([
            { type: "reply", messageId: "" },
        ]);
    });

    it("未知 elementType → unknown（宽容不抛）", () => {
        expect(toCanonicalElements(makeMsg([{ elementType: 999 }]))).toEqual([
            { type: "unknown", raw: { elementType: 999 } },
        ]);
    });

    it("混合列表按序转换（at + text + 未知）", () => {
        const elements: RawElement[] = [
            {
                elementType: ElementType.TEXT,
                textElement: { content: "@A", atType: 2, atUid: "u1" },
            },
            { elementType: ElementType.TEXT, textElement: { content: "hi" } },
            { elementType: 999 },
        ];
        const out = toCanonicalElements(makeMsg(elements));
        expect(out[0]).toEqual({ type: "at", target: "u1", display: "A" });
        expect(out[1]).toEqual({ type: "text", text: "hi" });
        expect(out[2]).toMatchObject({ type: "unknown" });
    });
});
