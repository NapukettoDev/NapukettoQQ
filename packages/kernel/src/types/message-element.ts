/**
 * canonical 消息元素模型（协议无关，ADR-008 延伸）
 *
 * 描述 QQ 消息的事实结构，是各协议翻译层的公共中间表示：
 * kernel 只做一次 NT ↔ canonical（toCanonicalElements / toSendElements），
 * 各协议（onebot11/satori）只写薄映射 canonical ↔ 协议格式。
 */

import { kernelError } from "../infra/index.js";
import type {
    FaceElement,
    FileElement,
    PicElement,
    PttElement,
    RawElement,
    RawMessage,
    ReplyElement,
    TextElement,
    VideoElement,
} from "./entities.js";
import { ElementType, type SendMessageElement } from "./services/msg-service.js";

/** 文本 at 类型（QQ wrapper 契约，自研描述）。 */
const AtType = { ALL: 1, ONE: 2, ME: 4 } as const;

/**
 * 视频缩略图在 thumbPath 中的 key（收向实测 Map<0, path>；平面对象形态下
 * 数字 key 经序列化变字符串 "0"。apis/msg.ts 发送侧有同名常量，types 层
 * 不能反向 import apis（依赖方向），此处独立定义）。
 */
const VIDEO_THUMB_KEY = 0;

/**
 * 读视频缩略图路径（接收方向形态不唯一，防御读取）：
 *  - 进程内为 `Map<0, path>`（收向实测）；
 *  - 跨进程/JSON 序列化后退化为平面对象 `{"0": path}`（`JSON.stringify(Map)`
 *    内容全丢，无规整的传输会得到空对象 `{}`）；
 *  - 个别形态可能直接给字符串路径（兜底容忍）。
 *
 * 2026-10-24 线上事故：koishi IPC 模式下 thumbPath 到达父进程已是平面对象，
 * 直接 `.get(0)` 抛 TypeError，整条视频消息事件分派失败。
 */
function readVideoThumbPath(thumb: VideoElement["thumbPath"]): string | undefined {
    if (thumb === undefined || thumb === "") {
        return undefined;
    }
    if (typeof thumb === "string") {
        return thumb;
    }
    if (thumb instanceof Map) {
        const value = thumb.get(VIDEO_THUMB_KEY);
        return value === "" ? undefined : value;
    }
    const value = thumb[String(VIDEO_THUMB_KEY)];
    return value === "" ? undefined : value;
}

/** TEXT 元素 → canonical（at 或纯文本）。 */
function textToCanonical(textEl: TextElement | undefined): CanonicalElement {
    if (textEl === undefined) {
        return { type: "text", text: "" };
    }
    const { atType, atUid, content } = textEl;
    if (atType === AtType.ALL) {
        return { type: "at", target: "all" };
    }
    if (atType === AtType.ONE || atType === AtType.ME) {
        // 2026-08-07：at 段补 display（显示名）——QQ 的 content 通常是 "@昵称"，
        // 剥掉 @ 作 display，供 OB11 at 段 name / 日志渲染使用（此前只有 target=uid）。
        const base = { type: "at" as const, target: atUid ?? content };
        const display = content.startsWith("@") ? content.slice(1) : content;
        if (display === "") {
            return base;
        }
        return { ...base, display };
    }
    return { type: "text", text: content };
}

/** PIC 元素 → canonical image。 */
function picToCanonical(pic: PicElement | undefined): CanonicalElement {
    if (pic === undefined) {
        return { type: "image", path: "" };
    }
    const path = pic.picPath ?? pic.picUrl ?? "";
    const url = pic.picUrl;
    if (url === undefined) {
        return { type: "image", path };
    }
    return { type: "image", path, url };
}

/** FACE 元素 → canonical face。 */
function faceToCanonical(face: FaceElement | undefined): CanonicalElement {
    if (face === undefined) {
        return { type: "face", id: "0" };
    }
    return { type: "face", id: String(face.faceIndex) };
}

/** PTT 元素 → canonical voice。 */
function pttToCanonical(ptt: PttElement | undefined): CanonicalElement {
    if (ptt === undefined) {
        return { type: "voice", path: "" };
    }
    return { type: "voice", path: ptt.filePath ?? "" };
}

/** VIDEO 元素 → canonical video。 */
function videoToCanonical(video: VideoElement | undefined): CanonicalElement {
    if (video === undefined) {
        return { type: "video", path: "" };
    }
    const path = video.filePath ?? video.videoUrl ?? "";
    const base: Extract<CanonicalElement, { type: "video" }> = { type: "video", path };
    if (video.videoUrl !== undefined) {
        base.url = video.videoUrl;
    }
    // thumbPath 接收形态不唯一（Map / 序列化平面对象 / 字符串），统一走防御读取
    const thumb = readVideoThumbPath(video.thumbPath);
    if (thumb !== undefined) {
        base.thumbPath = thumb;
    }
    if (video.thumbWidth !== undefined && video.thumbWidth > 0) {
        base.width = video.thumbWidth;
    }
    if (video.thumbHeight !== undefined && video.thumbHeight > 0) {
        base.height = video.thumbHeight;
    }
    if (video.fileTime !== undefined && video.fileTime > 0) {
        base.durationSec = video.fileTime;
    }
    return base;
}

/** FILE 元素 → canonical file。 */
function fileToCanonical(file: FileElement | undefined): CanonicalElement {
    if (file === undefined) {
        return { type: "file", path: "" };
    }
    const path = file.filePath ?? "";
    const name = file.fileName;
    if (name === undefined) {
        return { type: "file", path };
    }
    return { type: "file", path, name };
}

/** REPLY 元素 → canonical reply。 */
function replyToCanonical(reply: ReplyElement | undefined): CanonicalElement {
    if (reply === undefined) {
        return { type: "reply", messageId: "" };
    }
    return { type: "reply", messageId: reply.replayMsgId };
}

/** 单个 NT 元素 → canonical（接收方向，宽容：无法表达回 unknown，不抛错）。 */
function toCanonicalElement(el: RawElement): CanonicalElement {
    switch (el.elementType) {
        case ElementType.TEXT:
            return textToCanonical(el.textElement);
        case ElementType.PIC:
            return picToCanonical(el.picElement);
        case ElementType.FACE:
            return faceToCanonical(el.faceElement);
        case ElementType.PTT:
            return pttToCanonical(el.pttElement);
        case ElementType.VIDEO:
            return videoToCanonical(el.videoElement);
        case ElementType.FILE:
            return fileToCanonical(el.fileElement);
        case ElementType.REPLY:
            return replyToCanonical(el.replyElement);
        default:
            return { type: "unknown", raw: el };
    }
}

/** NT RawMessage → canonical 元素（与 toSendElements 对称，接收方向）。 */
export function toCanonicalElements(msg: RawMessage): CanonicalElement[] {
    return msg.elements.map(toCanonicalElement);
}

/** canonical 元素 → NT 发送元素（text/at/face/image/voice/reply 核心五类）。 */
export function toSendElements(elements: CanonicalElement[]): SendMessageElement[] {
    const out: SendMessageElement[] = [];
    for (const el of elements) {
        switch (el.type) {
            case "text":
                out.push({ elementType: ElementType.TEXT, textElement: { content: el.text } });
                break;
            case "at":
                if (el.target === "all") {
                    out.push({
                        elementType: ElementType.TEXT,
                        textElement: { content: el.display ?? "@", atType: 1 },
                    });
                } else {
                    out.push({
                        elementType: ElementType.TEXT,
                        textElement: { content: el.display ?? "@", atType: 2, atUid: el.target },
                    });
                }
                break;
            case "face":
                out.push({
                    elementType: ElementType.FACE,
                    faceElement: { faceIndex: Number(el.id) },
                });
                break;
            case "image":
                out.push({ elementType: ElementType.PIC, picElement: { picPath: el.path } });
                break;
            case "voice":
                out.push({ elementType: ElementType.PTT, pttElement: { filePath: el.path } });
                break;
            case "reply":
                out.push({
                    elementType: ElementType.REPLY,
                    replyElement: {
                        replayMsgId: el.messageId,
                        replayMsgSeq: el.messageId,
                        replayMsgTime: "0",
                    },
                });
                break;
            case "video":
                // 视频发送必须经 MsgApi.prepareVideoElement 预处理（md5/目标路径/
                // 缩略图 Map 等字段无法从 canonical 直接得到）。canonical → NT
                // 元元素只在 prepareSendElements 内部发生，此处属误用。
                throw kernelError(
                    "视频发送需经 MsgApi 预处理（prepareVideoElement）",
                    "INVALID_PARAM",
                );
            case "file":
            case "forward":
            case "json":
            case "xml":
            case "unknown":
                throw kernelError(`发送元素 ${el.type} 暂不支持（P2-2 探测后补）`, "INVALID_PARAM");
            default:
                // exhaustive：CanonicalElement 无其他成员
                break;
        }
    }
    return out;
}

/** 协议无关的规范消息元素。 */
export type CanonicalElement =
    | { type: "text"; text: string }
    | { type: "at"; target: string; display?: string }
    | { type: "image"; path: string; url?: string; size?: { width: number; height: number } }
    | { type: "face"; id: string }
    | { type: "voice"; path: string; durationMs?: number; url?: string }
    | {
          type: "video";
          path: string;
          url?: string;
          thumbPath?: string;
          width?: number;
          height?: number;
          durationSec?: number;
      }
    | { type: "file"; path: string; name?: string; size?: number }
    | { type: "reply"; messageId: string }
    | { type: "forward"; messageIds: string[] }
    | { type: "json"; raw: unknown }
    | { type: "xml"; raw: unknown }
    | { type: "unknown"; raw: unknown };
