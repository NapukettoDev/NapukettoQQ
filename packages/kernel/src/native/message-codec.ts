/**
 * canonical 消息元素双向转换（NT wrapper ↔ 协议无关中间表示）。
 * 类型层（`types/message-element.ts`）保持纯声明，本文件承担运行时转换与本地路径存在性校验；
 * kernel 只做一次 NT ↔ canonical 转换，各协议只写薄映射 canonical ↔ 协议格式。
 */
import { existsSync } from "node:fs";
import { errorMessage, kernelError } from "../infra/index.js";
// 运行时枚举走叶子模块/子域 barrel（不经 types/index.js）：types/index 反向
// re-export 本文件的转换函数，值依赖须避免 codec ↔ types/index 环。
import { VIDEO_THUMB_KEY } from "../types/entities.js";
import type {
    CanonicalElement,
    FaceElement,
    FileElement,
    PicElement,
    PttElement,
    RawElement,
    RawMessage,
    ReplyElement,
    SendMessageElement,
    TextElement,
    VideoElement,
} from "../types/index.js";
import { ElementType } from "../types/services/index.js";

/** 文本 at 类型（QQ wrapper 契约，自研描述）。 */
const AtType = { ALL: 1, ONE: 2, ME: 4 } as const;

/**
 * wrapper 对无效 at 目标的归零值：`atUid` 只接受数字 UIN，非数字会被归零成 `"0"`。
 * 接收方向必须把它当「无目标」，否则 `"0"` 会一路传给 uid→uin 转换
 * （`getUinByUids` → `Data Not Existed!`）。
 */
const AT_TARGET_ZERO = "0";

/** 纯数字 UIN（`atUid` 唯一接受的形态；`u_...` 等 NT UID 只能进 `atNtUid`）。 */
const NUMERIC_UIN_RE = /^\d+$/;

/** `@全体` 的显示文本（客户端原生元素实测）。 */
const AT_ALL_CONTENT = "@全体成员";

/** `@全体` 的目标值（原生元素把它放在 `atNtUid`，不是 `atUid`）。 */
const AT_ALL_TARGET = "all";

/**
 * 读视频缩略图路径（接收方向形态不唯一，防御读取）：
 *  - 进程内为 `Map<0, path>`（收向实测）；
 *  - 跨进程/JSON 序列化后退化为平面对象 `{"0": path}`（`JSON.stringify(Map)`
 *    内容全丢，无规整的传输会得到空对象 `{}`）；
 *  - 个别形态可能直接给字符串路径（兜底容忍）。
 *
 * ⚠️ 线上事故：koishi IPC 模式下 thumbPath 到达父进程已是平面对象，
 * 直接 `.get(0)` 抛 TypeError，整条视频消息事件分派失败。
 */
function readVideoThumbPath(thumb: VideoElement["thumbPath"]): string | undefined {
    // Linux 3.2.x 原生对象把未命中的变体字段显式置 null（不是省略成 undefined），
    // 必须用 `== null` 同时挡住两种情况，否则会穿透到索引访问。
    if (thumb == null || thumb === "") {
        return undefined;
    }
    if (typeof thumb === "string") {
        return thumb;
    }
    if (thumb instanceof Map) {
        const value = thumb.get(VIDEO_THUMB_KEY);
        return value == null || value === "" ? undefined : value;
    }
    const value = thumb[String(VIDEO_THUMB_KEY)];
    // 平面对象/Map 的内部值在原生宿主上同样可能是显式 null
    return value == null || value === "" ? undefined : value;
}

/**
 * at 目标解析（接收方向）：
 *  - 优先 `atNtUid`（`u_...` NT UID）——QQNT 解析真实提及所依赖的字段，也是发送侧
 *    唯一写入 `u_...` 的地方；
 *  - 缺失时回退 `atUid`（数字 UIN 镜像）；
 *  - `""` / `"0"` 均为无效（wrapper 把非数字 atUid 归零成 `"0"`），宁可按文本降级
 *    也不能把 `"0"` 传给下游 uid→uin 转换。
 */
function readAtTarget(textEl: TextElement): string | undefined {
    for (const raw of [textEl.atNtUid, textEl.atUid]) {
        const hit = emptyToUndefined(raw);
        if (hit !== undefined && hit.trim() !== "" && hit !== AT_TARGET_ZERO) {
            return hit;
        }
    }
    return undefined;
}

/** TEXT 元素 → canonical（at 或纯文本）。 */
function textToCanonical(textEl: TextElement | null | undefined): CanonicalElement {
    if (textEl == null) {
        return { type: "text", text: "" };
    }
    const { atType, content } = textEl;
    if (atType === AtType.ALL) {
        return { type: "at", target: AT_ALL_TARGET };
    }
    if (atType === AtType.ONE || atType === AtType.ME) {
        const target = readAtTarget(textEl);
        // 目标无效（atNtUid 与 atUid 都空 / atUid 被归零）：按文本降级，不产出 target "0"
        if (target !== undefined) {
            // at 段补 display（显示名）：QQ 的 content 通常是 "@昵称"，剥掉 @ 作 display，
            // 供 OB11 at 段 name / 日志渲染使用。
            const base = { type: "at" as const, target };
            const display = content.startsWith("@") ? content.slice(1) : content;
            if (display === "") {
                return base;
            }
            return { ...base, display };
        }
    }
    return { type: "text", text: content };
}

/**
 * 空值视为缺失（跨平台原生对象形态差异）：
 *  - Windows 省略未命中的字段 → undefined；
 *  - Linux 3.2.x 显式置 null；
 *  - Linux 原生对象也常给 "" 而不是省略字段。
 * 三者统一归为 undefined，避免 null 被当成有效值继续下传。
 */
function emptyToUndefined(value: string | null | undefined): string | undefined {
    return value == null || value === "" ? undefined : value;
}

/** 取第一个非空字符串（跨平台字段名不一致时的兜底链）。 */
function firstNonEmpty(...values: (string | null | undefined)[]): string | undefined {
    for (const value of values) {
        const hit = emptyToUndefined(value);
        if (hit !== undefined) {
            return hit;
        }
    }
    return undefined;
}

/** CDN/HTTP 前缀（URL 不是本地路径，不参与存在性校验）。 */
const HTTP_URL_RE = /^https?:\/\//i;

/** 非 CDN/HTTP 的候选路径（本地路径形态）。 */
function isLocalPathCandidate(value: string): boolean {
    return !HTTP_URL_RE.test(value);
}

/**
 * pic 元素的本地路径候选（按 canonical 选取顺序去重）。
 *
 * 收向实测：sourcePath 是 nt_data 下的绝对路径，指向「自动下载完成后才会出现」的
 * 文件——补丁生效前该文件不存在。导出给 pic-path-grace（桥层等待落盘）与
 * picToCanonical 共用同一候选序。
 */
export function picLocalCandidates(pic: PicElement | null | undefined): string[] {
    // Linux 原生对象的 `picElement` 在非 PIC 元素上是显式 null（Windows 为省略），
    // 这里必须同时挡住 null/undefined（线上事故：null 读取 picPath 崩溃）。
    if (pic == null) {
        return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [pic.picPath, pic.sourcePath]) {
        const value = emptyToUndefined(raw);
        if (value !== undefined && isLocalPathCandidate(value) && !seen.has(value)) {
            seen.add(value);
            out.push(value);
        }
    }
    return out;
}

/** PIC 元素 → canonical image。 */
function picToCanonical(pic: PicElement | null | undefined): CanonicalElement {
    if (pic == null) {
        return { type: "image", path: "" };
    }
    // 字段随平台不同（Linux 原生 wrapper 实测）：
    //  - Windows：picPath（本地路径）/ picUrl（CDN 链接）；
    //  - Linux：两者都不存在，原图落 sourcePath（绝对本地路径），originImageUrl
    //    是相对路径（/download?appid=…&fileid=…，无 host，不能当 url 用）。
    //
    // 本地路径存在性防御：候选链上取第一个真实存在的本地路径；全部缺失时回退
    // picUrl（URL 可供下游下载）——严禁把不存在的本地路径暴露给协议层（下游
    // AstrBot 一类直接 stat 的消费者会 FileNotFoundError）。
    const url = firstNonEmpty(pic.picUrl);
    let path = picLocalCandidates(pic).find((candidate) => existsSync(candidate));
    if (path === undefined) {
        path = url ?? "";
    }
    if (url === undefined) {
        return { type: "image", path };
    }
    return { type: "image", path, url };
}

/** FACE 元素 → canonical face。 */
function faceToCanonical(face: FaceElement | null | undefined): CanonicalElement {
    if (face == null) {
        return { type: "face", id: "0" };
    }
    return { type: "face", id: String(face.faceIndex) };
}

/** PTT 元素 → canonical voice。 */
function pttToCanonical(ptt: PttElement | null | undefined): CanonicalElement {
    if (ptt == null) {
        return { type: "voice", path: "" };
    }
    return { type: "voice", path: ptt.filePath ?? "" };
}

/** VIDEO 元素 → canonical video。 */
function videoToCanonical(video: VideoElement | null | undefined): CanonicalElement {
    if (video == null) {
        return { type: "video", path: "" };
    }
    const path = video.filePath ?? video.videoUrl ?? "";
    const base: Extract<CanonicalElement, { type: "video" }> = { type: "video", path };
    if (video.videoUrl != null) {
        base.url = video.videoUrl;
    }
    // thumbPath 接收形态不唯一（Map / 序列化平面对象 / 字符串 / Linux 显式 null），
    // 统一走防御读取
    const thumb = readVideoThumbPath(video.thumbPath);
    if (thumb !== undefined) {
        base.thumbPath = thumb;
    }
    if (video.thumbWidth != null && video.thumbWidth > 0) {
        base.width = video.thumbWidth;
    }
    if (video.thumbHeight != null && video.thumbHeight > 0) {
        base.height = video.thumbHeight;
    }
    if (video.fileTime != null && video.fileTime > 0) {
        base.durationSec = video.fileTime;
    }
    return base;
}

/** FILE 元素 → canonical file。 */
function fileToCanonical(file: FileElement | null | undefined): CanonicalElement {
    if (file == null) {
        return { type: "file", path: "" };
    }
    const path = file.filePath ?? "";
    const name = file.fileName;
    // Linux 原生对象未命中的字段显式 null（不仅是 undefined）
    if (name == null) {
        return { type: "file", path };
    }
    return { type: "file", path, name };
}

/** REPLY 元素 → canonical reply。 */
function replyToCanonical(reply: ReplyElement | null | undefined): CanonicalElement {
    if (reply == null) {
        return { type: "reply", messageId: "" };
    }
    const senderUid = emptyToUndefined(reply.senderUid);
    const senderUin = emptyToUndefined(reply.senderUin);
    return {
        type: "reply",
        messageId: reply.replayMsgId ?? "",
        ...(senderUid !== undefined ? { senderUid } : {}),
        ...(senderUin !== undefined ? { senderUin } : {}),
    };
}

/**
 * ARK 元素 → canonical json（小程序/分享卡片）。
 *
 * bytesData 是卡片 JSON 字符串，原样透传不解析重组——OB11 json 段 data.data
 * 保持原始载荷（go-cqhttp/NapCat 生态一致），title/url 由下游自行 parse。
 * bytesData 缺失/为空时维持 unknown 兜底：空 json 段无信息量，保留 raw 供探测。
 */
function arkToCanonical(
    ark: { bytesData: string } | null | undefined,
    el: RawElement,
): CanonicalElement {
    const bytes = ark?.bytesData;
    // Linux 原生对象未命中的变体字段显式 null（arkElement 本身与 bytesData 均按空值判）
    if (bytes == null || bytes === "") {
        return { type: "unknown", raw: el };
    }
    return { type: "json", raw: bytes };
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
        case ElementType.ARK:
            return arkToCanonical(el.arkElement, el);
        default:
            return { type: "unknown", raw: el };
    }
}

/** NT RawMessage → canonical 元素（与 toSendElements 对称，接收方向）。 */
export function toCanonicalElements(msg: RawMessage): CanonicalElement[] {
    return msg.elements.map(toCanonicalElement);
}

/**
 * canonical json → ARK bytesData 字符串：字符串原样透传（OB11 json 段 /
 * satori 发送链给的已是卡片 JSON 文本），其余值 JSON 序列化。
 * 与接收方向 arkToCanonical 对称（bytesData 字段名经真实消息实测）。
 */
function jsonToArkBytes(raw: unknown): string {
    if (typeof raw === "string") {
        return raw;
    }
    try {
        return JSON.stringify(raw) ?? "";
    } catch (err) {
        throw kernelError(`json 元素序列化失败: ${errorMessage(err)}`, "INVALID_PARAM");
    }
}

/**
 * at 显示文本归一：客户端原生元素的 content 恒为带 `@` 前缀的显示文本，
 * 而 canonical `display` 可能来自群成员昵称（不带 `@`）——统一补前缀，
 * 避免聊天框出现「@」后无名字的空提及。
 */
function atContent(display: string | undefined, fallback: string): string {
    const text = emptyToUndefined(display) ?? fallback;
    return text.startsWith("@") ? text : `@${text}`;
}

/** canonical 元素 → NT 发送元素（text/at/face/image/voice/reply 核心 + json ARK 透传）。 */
export function toSendElements(elements: CanonicalElement[]): SendMessageElement[] {
    const out: SendMessageElement[] = [];
    for (const el of elements) {
        switch (el.type) {
            case "text":
                out.push({ elementType: ElementType.TEXT, textElement: { content: el.text } });
                break;
            case "at":
                if (el.target === AT_ALL_TARGET) {
                    // @全体：atType=1 + atNtUid="all"（客户端原生元素实测，无 atUid）
                    out.push({
                        elementType: ElementType.TEXT,
                        textElement: {
                            content: atContent(el.display, AT_ALL_CONTENT),
                            atType: AtType.ALL,
                            atNtUid: AT_ALL_TARGET,
                        },
                    });
                } else {
                    // 单人 @：`u_...` 写 atNtUid（QQNT 解析目标依赖它）；atUid 只放数字
                    // UIN——写非数字会被 wrapper 归零成 "0"
                    const target = el.target;
                    const isNumericUin = NUMERIC_UIN_RE.test(target);
                    out.push({
                        elementType: ElementType.TEXT,
                        textElement: {
                            content: atContent(el.display, "@"),
                            atType: AtType.ONE,
                            atUid: isNumericUin ? target : "",
                            atNtUid: isNumericUin ? "" : target,
                        },
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
            case "json":
                // ARK 卡片透传（elementType=10）：bytesData 装卡片 JSON 字符串，
                // 与接收方向 arkToCanonical 对称；wrapper 对缺省字段容忍（djinni
                // 转换缺省字段为默认值）。发送失败走 KernelError 语义，不崩溃。
                out.push({
                    elementType: ElementType.ARK,
                    arkElement: { bytesData: jsonToArkBytes(el.raw) },
                });
                break;
            case "file":
            case "forward":
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
