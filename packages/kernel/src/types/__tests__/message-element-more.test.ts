/**
 * message-element.ts 接收方向（toCanonicalElements）补充测试：
 *  - text：at all / at one / at me / display 剥离与缺省 / 纯文本
 *  - pic / video / file / face / reply / ark / unknown 兜底
 *  - video thumbPath 三形态防御读取（Map / 平面对象 / 字符串 / 空对象）
 * 发送方向（toSendElements）已有基线，不重复。
 */
import { describe, expect, it } from "vitest";
import type { RawElement, RawMessage } from "../entities.js";
import type { CanonicalElement } from "../message-element.js";
import { toCanonicalElements, toSendElements } from "../message-element.js";

function msgOf(el: RawElement): RawMessage {
    return { msgId: "m1", elements: [el] } as unknown as RawMessage;
}

describe("text 元素", () => {
    it("纯文本", () => {
        expect(
            toCanonicalElements(msgOf({ elementType: 1, textElement: { content: "hi" } as never })),
        ).toEqual([{ type: "text", text: "hi" }]);
    });

    it("textElement 缺失 → 空文本（防御）", () => {
        expect(toCanonicalElements(msgOf({ elementType: 1 } as never))).toEqual([
            { type: "text", text: "" },
        ]);
    });

    it("atType=ALL → at all（忽略内容）", () => {
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 1,
                    textElement: { atType: 1, content: "@全体成员" } as never,
                }),
            ),
        ).toEqual([{ type: "at", target: "all" }]);
    });

    it("atType=ONE：display 剥离 @；content 无 @ 原样", () => {
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 1,
                    textElement: { atType: 2, atUid: "u1", content: "@小明" } as never,
                }),
            ),
        ).toEqual([{ type: "at", target: "u1", display: "小明" }]);
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 1,
                    textElement: { atType: 2, atUid: "u1", content: "小明" } as never,
                }),
            ),
        ).toEqual([{ type: "at", target: "u1", display: "小明" }]);
    });

    it("atType=ONE：display 空串不产出；atUid 缺失回退 content", () => {
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 1,
                    textElement: { atType: 2, atUid: "u1", content: "@" } as never,
                }),
            ),
        ).toEqual([{ type: "at", target: "u1" }]);
        expect(
            toCanonicalElements(
                msgOf({ elementType: 1, textElement: { atType: 4, content: "@me" } as never }),
            ),
        ).toEqual([{ type: "at", target: "@me", display: "me" }]);
    });
});

describe("pic 元素", () => {
    it("picPath + picUrl：path/url 都带上", () => {
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 2,
                    picElement: { picPath: "/p.png", picUrl: "https://u" } as never,
                }),
            ),
        ).toEqual([{ type: "image", path: "/p.png", url: "https://u" }]);
    });

    it("仅 picUrl → path 兜底 picUrl；仅 picPath → 无 url 键", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 2, picElement: { picUrl: "https://u" } as never }),
            ),
        ).toEqual([{ type: "image", path: "https://u", url: "https://u" }]);
        expect(
            toCanonicalElements(msgOf({ elementType: 2, picElement: { picPath: "/p" } as never })),
        ).toEqual([{ type: "image", path: "/p" }]);
        expect(toCanonicalElements(msgOf({ elementType: 2 } as never))).toEqual([
            { type: "image", path: "" },
        ]);
    });
});

describe("video 元素", () => {
    it("全字段：filePath/videoUrl/thumbPath(Map)/宽高/时长", () => {
        const el = {
            elementType: 5,
            videoElement: {
                filePath: "/v.mp4",
                videoUrl: "https://v",
                thumbPath: new Map([[0, "/t.png"]]),
                thumbWidth: 640,
                thumbHeight: 360,
                fileTime: 18,
            },
        } as unknown as RawElement;
        expect(toCanonicalElements(msgOf(el))).toEqual([
            {
                type: "video",
                path: "/v.mp4",
                url: "https://v",
                thumbPath: "/t.png",
                width: 640,
                height: 360,
                durationSec: 18,
            },
        ]);
    });

    it("thumbPath 平面对象（IPC 退化形态）/ 字符串形态防御读取", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 5, videoElement: { thumbPath: { "0": "/t2.png" } } as never }),
            ),
        ).toEqual([{ type: "video", path: "", thumbPath: "/t2.png" }]);
        expect(
            toCanonicalElements(
                msgOf({ elementType: 5, videoElement: { thumbPath: "/t3.png" } as never }),
            ),
        ).toEqual([{ type: "video", path: "", thumbPath: "/t3.png" }]);
    });

    it("thumbPath 空串 / Map 空值 / 空对象 → 不产出 thumbPath", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 5, videoElement: { thumbPath: "" } as never }),
            ),
        ).toEqual([{ type: "video", path: "" }]);
        expect(
            toCanonicalElements(
                msgOf({ elementType: 5, videoElement: { thumbPath: new Map([[0, ""]]) } as never }),
            ),
        ).toEqual([{ type: "video", path: "" }]);
        expect(
            toCanonicalElements(
                msgOf({ elementType: 5, videoElement: { thumbPath: {} } as never }),
            ),
        ).toEqual([{ type: "video", path: "" }]);
    });

    it("宽高/时长非正值不产出；videoUrl 缺省 path 空串；videoElement 缺失兜底", () => {
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 5,
                    videoElement: { thumbWidth: 0, thumbHeight: 0, fileTime: 0 },
                } as never),
            ),
        ).toEqual([{ type: "video", path: "" }]);
        expect(toCanonicalElements(msgOf({ elementType: 5 } as never))).toEqual([
            { type: "video", path: "" },
        ]);
    });
});

describe("file / face / reply / ark / unknown", () => {
    it("file：fileName 缺失不产出 name", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 3, fileElement: { filePath: "/f" } as never }),
            ),
        ).toEqual([{ type: "file", path: "/f" }]);
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 3,
                    fileElement: { filePath: "/f", fileName: "a.zip" } as never,
                }),
            ),
        ).toEqual([{ type: "file", path: "/f", name: "a.zip" }]);
        expect(toCanonicalElements(msgOf({ elementType: 3 } as never))).toEqual([
            { type: "file", path: "" },
        ]);
    });

    it("face：faceIndex 字符串化；缺失兜底 id=0", () => {
        expect(
            toCanonicalElements(msgOf({ elementType: 6, faceElement: { faceIndex: 96 } as never })),
        ).toEqual([{ type: "face", id: "96" }]);
        expect(toCanonicalElements(msgOf({ elementType: 6 } as never))).toEqual([
            { type: "face", id: "0" },
        ]);
    });

    it("reply：replayMsgId 透传；缺失兜底空串", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 7, replyElement: { replayMsgId: "m9" } as never }),
            ),
        ).toEqual([{ type: "reply", messageId: "m9" }]);
        expect(toCanonicalElements(msgOf({ elementType: 7 } as never))).toEqual([
            { type: "reply", messageId: "" },
        ]);
    });

    it("ark：bytesData 有值 → json 透传；缺失/空串 → unknown（raw 保留）", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 10, arkElement: { bytesData: '{"k":1}' } } as never),
            ),
        ).toEqual([{ type: "json", raw: '{"k":1}' }]);
        expect(toCanonicalElements(msgOf({ elementType: 10 } as never))).toMatchObject([
            { type: "unknown" },
        ]);
        expect(
            toCanonicalElements(msgOf({ elementType: 10, arkElement: { bytesData: "" } } as never)),
        ).toMatchObject([{ type: "unknown" }]);
    });

    it("未知 elementType（GRAY_TIP 8 等）→ unknown 带 raw", () => {
        const raw = {
            elementType: 8,
            grayTipElement: { subElementType: 1 },
        } as unknown as RawElement;
        const out = toCanonicalElements(msgOf(raw));
        expect(out[0]).toMatchObject({ type: "unknown" });
        expect((out[0] as { raw: unknown }).raw).toBe(raw);
    });

    it("ptt：filePath 透传；缺失兜底空串", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 4, pttElement: { filePath: "/a.silk" } as never }),
            ),
        ).toEqual([{ type: "voice", path: "/a.silk" }]);
        expect(toCanonicalElements(msgOf({ elementType: 4 } as never))).toEqual([
            { type: "voice", path: "" },
        ]);
    });
});

describe("toSendElements 补充分支", () => {
    it("at all 带 display：content 用 display", () => {
        expect(toSendElements([{ type: "at", target: "all", display: "@全体" }])).toEqual([
            { elementType: 1, textElement: { content: "@全体", atType: 1 } },
        ]);
    });

    it("json：字符串原样 / 对象 JSON 序列化 / 循环引用抛 INVALID_PARAM", () => {
        expect(toSendElements([{ type: "json", raw: '{"a":1}' }])).toEqual([
            { elementType: 10, arkElement: { bytesData: '{"a":1}' } },
        ]);
        expect(toSendElements([{ type: "json", raw: { a: 1 } }])).toEqual([
            { elementType: 10, arkElement: { bytesData: '{"a":1}' } },
        ]);
        const cyc: Record<string, unknown> = {};
        cyc["self"] = cyc;
        expect(() => toSendElements([{ type: "json", raw: cyc }])).toThrow(/序列化失败/);
    });

    it("file / forward / xml / unknown 发送不支持抛 INVALID_PARAM", () => {
        for (const el of [
            { type: "file", path: "/x" },
            { type: "forward", messageIds: ["1"] },
            { type: "xml", raw: "<a/>" },
            { type: "unknown", raw: 1 },
        ] as CanonicalElement[]) {
            expect(() => toSendElements([el])).toThrow(/暂不支持/);
        }
    });

    it("视频直接发送被拒（需经 MsgApi 预处理）", () => {
        expect(() => toSendElements([{ type: "video", path: "/v.mp4" } as never])).toThrow(
            /prepareVideoElement/,
        );
    });
});

describe("缺省字段兜底补充", () => {
    it("pic：picPath/picUrl 全缺 → path 空串；仅 picPath → 无 url 键", () => {
        expect(toCanonicalElements(msgOf({ elementType: 2, picElement: {} } as never))).toEqual([
            { type: "image", path: "" },
        ]);
        expect(
            toCanonicalElements(
                msgOf({ elementType: 2, picElement: { picPath: "/local/p.png" } } as never),
            ),
        ).toEqual([{ type: "image", path: "/local/p.png" }]);
    });

    it("pic：有 picUrl → canonical 带 url", () => {
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 2,
                    picElement: { picPath: "/p.png", picUrl: "https://example/p.png" },
                } as never),
            ),
        ).toEqual([{ type: "image", path: "/p.png", url: "https://example/p.png" }]);
    });

    it("file：无 fileName → 无 name 键；有 fileName → name 键", () => {
        expect(
            toCanonicalElements(
                msgOf({ elementType: 3, fileElement: { filePath: "/f.pdf" } } as never),
            ),
        ).toEqual([{ type: "file", path: "/f.pdf" }]);
        expect(
            toCanonicalElements(
                msgOf({
                    elementType: 3,
                    fileElement: { filePath: "/f.pdf", fileName: "f.pdf" },
                } as never),
            ),
        ).toEqual([{ type: "file", path: "/f.pdf", name: "f.pdf" }]);
    });

    it("ptt：无 filePath → path 空串", () => {
        expect(toCanonicalElements(msgOf({ elementType: 4, pttElement: {} } as never))).toEqual([
            { type: "voice", path: "" },
        ]);
    });

    it("video thumbPath：Map 值为空串 → undefined（无 thumbPath 键）", () => {
        const canonical = toCanonicalElements(
            msgOf({
                elementType: 5,
                videoElement: { filePath: "/v.mp4", thumbPath: new Map([[0, ""]]) },
            } as never),
        );
        expect(canonical).toHaveLength(1);
        expect((canonical[0] as { thumbPath?: unknown }).thumbPath).toBeUndefined();
    });
});
