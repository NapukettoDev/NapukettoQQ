/**
 * adapter core 媒体辅助：语音归一化 + 视频缩略图（media 严格解耦的协议层落点）
 *
 * 协议层（onebot11 / satori）发送媒体前统一走这里：
 * - `ensureSilk`：非 silk 音频转 QQ 语音格式（silk v3）；
 * - `prepareVideoElements`：视频缺缩略图/时长/尺寸时，用 ffmpeg 抽首帧并探测元数据。
 * 都依赖 @napuketto/media，只发生在 adapter 层；kernel 不 import media（红线），
 * 只接收「文件齐全」的 canonical 元素。
 */
import { copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import { errorMessage, kernelError } from "@napuketto/kernel";
import { downloadUrl, encodePcmToSilk, extractVideoFrame, getVideoInfo } from "@napuketto/media";
import type { AdapterLoggerLike } from "../infra/log.js";
import { cacheMediaFile, MEDIA_TEMP_ROOT, protectMediaPath } from "../infra/media-cache.js";

/** file:// 前缀（fileURLToPath 解析失败时的裸剥离兜底）。 */
export const FILE_URI_PREFIX_RE = /^file:\/\//;
const MEDIA_EXTENSION_RE = /^\.[a-zA-Z0-9]+$/;
// Match media's audio input bound before creating the owned conversion copy.
const MAX_AUDIO_COPY_BYTES = 32 * 1024 * 1024;

/**
 * file:// URI → 平台路径（Windows 盘符 / 百分号编码兼容）。
 * fileURLToPath 解析失败时退化为裸剥离前缀（历史兜底行为，协议侧共用）。
 */
export function fileUriToPath(uri: string): string {
    try {
        return fileURLToPath(uri);
    } catch {
        return FILE_URI_PREFIX_RE.test(uri) ? uri.replace(FILE_URI_PREFIX_RE, "") : uri;
    }
}

/**
 * 远程 URL → 本地文件（异步 mkdir + 流式落盘，全仓协议层唯一落盘入口）。
 *
 * - 走 `@napuketto/media` 的 `downloadUrl`：超时、大小上限、流式落盘、协议白名单
 *   与「逐跳复检」的重定向策略都在那里统一（此前这里是裸 `fetch` + `arrayBuffer()`，
 *   无超时无上限：恶意超大响应可直接打爆 Node 堆）；
 * - 父目录不存在时自动创建；
 * - 失败统一包成 KernelError SEND_FAILED（`label` 供调用方定制前缀，如「头像下载失败」）；
 * - 返回落盘路径（便于调用方直接回传）。
 */
export async function downloadBufferToFile(
    url: string,
    filePath: string,
    init?: RequestInit,
    label = "下载失败",
): Promise<string> {
    try {
        const headers = init?.headers === undefined ? undefined : normalizeHeaders(init.headers);
        await downloadUrl(url, filePath, headers === undefined ? {} : { headers });
    } catch (err) {
        throw kernelError(`${label}: ${errorMessage(err)}`, "SEND_FAILED", { cause: err });
    }
    return filePath;
}

/** RequestInit.headers（Headers / 元组数组 / 普通对象）→ 普通字符串对象。 */
function normalizeHeaders(headers: NonNullable<RequestInit["headers"]>): Record<string, string> {
    const out: Record<string, string> = {};
    new Headers(headers).forEach((value, key) => {
        out[key] = value;
    });
    return out;
}

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
        await protectMediaPath(path);
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_AUDIO_COPY_BYTES) {
            throw kernelError("语音复制输入必须是 32MiB 以内的普通文件", "INVALID_PARAM");
        }
        const header = await readFileHead(path);
        if (header.startsWith("#!SILK")) {
            return path;
        }
        const ext = extname(path);
        return await cacheMediaFile(
            MEDIA_TEMP_ROOT,
            MEDIA_EXTENSION_RE.test(ext) ? ext : ".bin",
            async (copy) => {
                await copyFile(path, copy);
                return await encodePcmToSilk(copy);
            },
        );
    } catch (err) {
        logger?.warn({ path, error: errorMessage(err) }, "语音 silk 转码失败，原样透传");
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
