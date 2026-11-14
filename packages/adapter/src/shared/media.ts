/**
 * adapter core 媒体辅助：语音归一化 + 视频缩略图（media 严格解耦的协议层落点）
 *
 * 协议层（onebot11 / satori）发送媒体前统一走这里：
 * - `ensureSilk`：非 silk 音频转 QQ 语音格式（silk v3）；
 * - `prepareVideoElements`：视频缺缩略图/时长/尺寸时，用 ffmpeg 抽首帧并探测元数据。
 * 都依赖 @napuketto/media，只发生在 adapter 层；kernel 不 import media（红线），
 * 只接收「文件齐全」的 canonical 元素。
 */
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import { encodePcmToSilk, extractVideoFrame, getVideoInfo } from "@napuketto/media";
import type { AdapterLoggerLike } from "./log.js";

/** 读文件头 8 字节（判断 silk 魔数）。 */
async function readFileHead(path: string): Promise<string> {
    const handle = await open(path, "r");
    try {
        const buf = Buffer.alloc(8);
        await handle.read(buf, 0, 8, 0);
        return buf.toString("utf8");
    } finally {
        await handle.close();
    }
}

/**
 * 语音转码：非 silk 输入（任意音频格式，经 @napuketto/media 归一化）转 silk。
 * 已是 silk（#!SILK_V3 头）原样返回；转码失败原样返回（由 kernel 发送时兜底），
 * 可选 logger 记录降级上下文。
 */
export async function ensureSilk(path: string, logger?: AdapterLoggerLike): Promise<string> {
    try {
        const header = await readFileHead(path);
        if (header.startsWith("#!SILK")) {
            return path;
        }
        return await encodePcmToSilk(path);
    } catch (err) {
        logger?.warn(
            { path, error: err instanceof Error ? err.message : String(err) },
            "语音 silk 转码失败，原样透传",
        );
        return path;
    }
}

/** 视频元素准备结果。 */
export interface PreparedVideoElements {
    /** 补全后的元素（保持原顺序）。 */
    elements: CanonicalElement[];
    /** 删除临时缩略图目录；没有生成缩略图时是 no-op。发送结束后必须调用。 */
    cleanup: () => Promise<void>;
}

/** 是否是需要补缩略图的视频元素。 */
function needsVideoThumb(el: CanonicalElement): el is Extract<CanonicalElement, { type: "video" }> {
    return el.type === "video" && (el.thumbPath === undefined || el.thumbPath === "");
}

/**
 * 视频元素补「首帧缩略图 + 时长 + 尺寸」（QQ 视频消息发送契约）。
 *
 * 为什么必须补：kernel 的 `prepareVideoElement` 只有在 `thumbPath` 存在时才写
 * `thumbMd5 / thumbSize / thumbPath(Map)`，缺失时 native 传输找不到缩略图，
 * `sendMsg` 只回 `sendStatus=0`（无错误信息）；`fileTime`（秒）也取自
 * `durationSec`，缺省 0。Linux 原生宿主实测：只给 `file` 的 OB11 `video` 段
 * 必然失败，补上首帧后成功。
 *
 * 缩略图写在系统临时目录（发送时 kernel 会 copyFile 进 QQ 数据目录），
 * 由 `cleanup` 统一删除——不污染用户文件目录。
 *
 * 依赖系统 ffmpeg / ffprobe（@napuketto/media）；缺失或抽帧失败时抛
 * `MediaError`，由协议动作层映射成可读错误，而不是让 native 回 `sendStatus=0`。
 */
export async function prepareVideoElements(
    elements: readonly CanonicalElement[],
): Promise<PreparedVideoElements> {
    if (!elements.some(needsVideoThumb)) {
        return { elements: [...elements], cleanup: async () => undefined };
    }
    const dir = await mkdtemp(join(tmpdir(), "napuketto-video-thumb-"));
    const cleanup = async (): Promise<void> => {
        await rm(dir, { recursive: true, force: true });
    };
    try {
        const out: CanonicalElement[] = [];
        let index = 0;
        for (const el of elements) {
            if (!needsVideoThumb(el)) {
                out.push(el);
                continue;
            }
            index += 1;
            const thumbPath = join(dir, `thumb-${index}.png`);
            const info = await getVideoInfo(el.path);
            await extractVideoFrame(el.path, thumbPath);
            out.push({
                ...el,
                thumbPath,
                // kernel 把 width/height 写进 thumbWidth/thumbHeight（收向语义是缩略图尺寸；
                // 首帧不缩放 → 与视频宽高一致）
                width: el.width ?? info.width,
                height: el.height ?? info.height,
                durationSec: el.durationSec ?? Math.max(1, Math.round(info.durationMs / 1000)),
            });
        }
        return { elements: out, cleanup };
    } catch (err) {
        await cleanup();
        throw err;
    }
}
