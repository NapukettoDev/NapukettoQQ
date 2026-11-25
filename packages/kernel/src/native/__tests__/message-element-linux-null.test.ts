/**
 * message-element.ts Linux 原生对象形态回归测试（2026-11 线上 issue）
 *
 * Linux 3.2.x 原生 `wrapper.node` 与 Windows 形态差异：
 *  - Windows：省略未命中的变体字段（`undefined`）；
 *  - Linux：把**所有**未命中的变体字段显式赋值为 `null`
 *    （纯文本元素的 `picElement: null` / `grayTipElement: null` / …）。
 *
 * 事故链路：`collectCandidates` 把每个元素的 `picElement`（可能是 null）传给
 * `picLocalCandidates`，旧实现只判 `=== undefined`，读 `null.picPath` 抛
 * TypeError → 整个 `Msg/onRecvMsg` 分支在 channel.emit 前中断（OB11 收不到
 * message 事件）。本文件锁定「null 与 undefined 等价」的转换契约。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawElement, RawMessage } from "../../types/entities.js";
import { ElementType } from "../../types/services/msg-service.js";
import { picLocalCandidates, toCanonicalElements } from "../message-codec.js";

/** 构造 RawMessage（elements 可覆盖）。 */
function makeMsg(elements: RawElement[]): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1",
        msgTime: "0",
        msgType: 0,
        chatType: 2,
        peerUid: "g1",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "1",
        peerName: "群",
        sendNickName: "",
        elements,
    };
}

/** Linux 形态：所有未命中的变体字段显式 null。 */
const NULL_VARIANTS = {
    textElement: null,
    picElement: null,
    pttElement: null,
    faceElement: null,
    replyElement: null,
    videoElement: null,
    fileElement: null,
    grayTipElement: null,
    arkElement: null,
    multiForwardMsgElement: null,
} as const satisfies Partial<RawElement>;

/** 构造 Linux 形态元素（默认全部变体字段 null，可覆盖命中的那个）。 */
function linuxElement(overrides: Partial<RawElement> & { elementType: number }): RawElement {
    return { ...NULL_VARIANTS, ...overrides };
}

let picTmpDir: string;
let realPicPath: string;
beforeAll(() => {
    picTmpDir = mkdtempSync(join(tmpdir(), "napuketto-pic-null-"));
    realPicPath = join(picTmpDir, "real.png");
    writeFileSync(realPicPath, "png");
});
afterAll(() => {
    rmSync(picTmpDir, { recursive: true, force: true });
});

describe("toCanonicalElements：Linux 显式 null 变体字段", () => {
    it("纯文本消息携带全部 null 变体字段 → text（不抛错）", () => {
        const el = linuxElement({
            elementType: ElementType.TEXT,
            textElement: { content: "hi", atType: null, atUid: null },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "text", text: "hi" }]);
    });

    it.each([
        {
            name: "PIC 的 picElement 为 null",
            el: linuxElement({ elementType: ElementType.PIC }),
            expected: { type: "image", path: "" },
        },
        {
            name: "TEXT 的 textElement 为 null",
            el: linuxElement({ elementType: ElementType.TEXT }),
            expected: { type: "text", text: "" },
        },
        {
            name: "FACE 的 faceElement 为 null",
            el: linuxElement({ elementType: ElementType.FACE }),
            expected: { type: "face", id: "0" },
        },
        {
            name: "PTT 的 pttElement 为 null",
            el: linuxElement({ elementType: ElementType.PTT }),
            expected: { type: "voice", path: "" },
        },
        {
            name: "VIDEO 的 videoElement 为 null",
            el: linuxElement({ elementType: ElementType.VIDEO }),
            expected: { type: "video", path: "" },
        },
        {
            name: "FILE 的 fileElement 为 null",
            el: linuxElement({ elementType: ElementType.FILE }),
            expected: { type: "file", path: "" },
        },
        {
            name: "REPLY 的 replyElement 为 null",
            el: linuxElement({ elementType: ElementType.REPLY }),
            expected: { type: "reply", messageId: "" },
        },
    ])("$name → 空值兜底", ({ el, expected }) => {
        expect(toCanonicalElements(makeMsg([el]))).toEqual([expected]);
    });

    it("ARK 的 arkElement 为 null → unknown（保留 raw 供探测）", () => {
        const el = linuxElement({ elementType: ElementType.ARK });
        const [out] = toCanonicalElements(makeMsg([el]));
        expect(out).toMatchObject({ type: "unknown" });
        expect((out as { raw: unknown }).raw).toBe(el);
    });

    it("GRAY_TIP 的 grayTipElement 为 null → unknown（不抛错）", () => {
        const el = linuxElement({ elementType: ElementType.GRAY_TIP });
        expect(toCanonicalElements(makeMsg([el]))).toMatchObject([{ type: "unknown" }]);
    });

    it("混合列表：文本 / PIC(null) / PTT(null) / grayTip(null) 全部按序转换", () => {
        const elements = [
            linuxElement({ elementType: ElementType.TEXT, textElement: { content: "a" } }),
            linuxElement({ elementType: ElementType.PIC }),
            linuxElement({ elementType: ElementType.PTT }),
            linuxElement({ elementType: ElementType.GRAY_TIP }),
        ];
        expect(toCanonicalElements(makeMsg(elements))).toEqual([
            { type: "text", text: "a" },
            { type: "image", path: "" },
            { type: "voice", path: "" },
            { type: "unknown", raw: elements[3] },
        ]);
    });
});

describe("toCanonicalElements：Linux 显式 null 子字段", () => {
    it("PIC：picPath/picUrl/sourcePath 全 null → path 空", () => {
        const el = linuxElement({
            elementType: ElementType.PIC,
            picElement: { picPath: null, picUrl: null, sourcePath: null },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "image", path: "" }]);
    });

    it("PIC：本地路径 null 但 picUrl 有值 → 回退 url", () => {
        const el = linuxElement({
            elementType: ElementType.PIC,
            picElement: { picPath: null, sourcePath: null, picUrl: "https://x/p.png" },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([
            { type: "image", path: "https://x/p.png", url: "https://x/p.png" },
        ]);
    });

    it("PIC：sourcePath 命真实文件 → 直通本地路径", () => {
        const el = linuxElement({
            elementType: ElementType.PIC,
            picElement: { picPath: null, sourcePath: realPicPath },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "image", path: realPicPath }]);
    });

    it("VIDEO：filePath/videoUrl/thumbPath/宽高/时长全 null → 仅空 path", () => {
        const el = linuxElement({
            elementType: ElementType.VIDEO,
            videoElement: {
                filePath: null,
                videoUrl: null,
                thumbPath: null,
                thumbWidth: null,
                thumbHeight: null,
                fileTime: null,
            },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "video", path: "" }]);
    });

    it("VIDEO：thumbPath Map 内部值为 null → 不产出 thumbPath（不穿透索引访问）", () => {
        const el = linuxElement({
            elementType: ElementType.VIDEO,
            videoElement: {
                filePath: "/v.mp4",
                thumbPath: new Map([[0, null as unknown as string]]),
            },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "video", path: "/v.mp4" }]);
    });

    it("FILE：filePath/fileName 为 null → path 空且无 name", () => {
        const el = linuxElement({
            elementType: ElementType.FILE,
            fileElement: { filePath: null, fileName: null },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "file", path: "" }]);
    });

    it("FILE：fileName 为 null → 不产出 name（path 保留）", () => {
        const el = linuxElement({
            elementType: ElementType.FILE,
            fileElement: { filePath: "/f.bin", fileName: null },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "file", path: "/f.bin" }]);
    });

    it("REPLY：replayMsgId 为 null（运行时形态）→ messageId 空串", () => {
        const el = linuxElement({
            elementType: ElementType.REPLY,
            replyElement: { replayMsgId: null as unknown as string },
        });
        expect(toCanonicalElements(makeMsg([el]))).toEqual([{ type: "reply", messageId: "" }]);
    });

    it("ARK：bytesData 为 null → unknown", () => {
        const el = linuxElement({
            elementType: ElementType.ARK,
            arkElement: { bytesData: null as unknown as string },
        });
        expect(toCanonicalElements(makeMsg([el]))).toMatchObject([{ type: "unknown" }]);
    });
});

describe("picLocalCandidates：Linux null 判空", () => {
    it("pic 为 null / undefined → 空候选（不抛 TypeError）", () => {
        expect(picLocalCandidates(null)).toEqual([]);
        expect(picLocalCandidates(undefined)).toEqual([]);
    });

    it("picPath/sourcePath 为 null → 空候选", () => {
        expect(picLocalCandidates({ picPath: null, sourcePath: null })).toEqual([]);
    });

    it("picPath 为 null、sourcePath 有值 → 只收 sourcePath（去重保序）", () => {
        expect(picLocalCandidates({ picPath: null, sourcePath: "/a.png" })).toEqual(["/a.png"]);
        expect(picLocalCandidates({ picPath: "/b.png", sourcePath: "/b.png" })).toEqual(["/b.png"]);
    });
});
