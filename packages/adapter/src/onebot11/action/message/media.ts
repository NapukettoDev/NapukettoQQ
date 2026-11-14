/**
 * 消息媒体域动作
 *
 * - get_image / get_record：获取图片/语音文件（图片接主动下载；语音接原生
 *   downloadRichMedia）。message_id 反查 → fetchMsgsByMsgId → 找 PIC/PTT 元素：
 *     - 本地文件解析：NT 相对路径（sourcePath/filePath）按 mediaBaseDir（QQ NT
 *       global 目录）解析为绝对路径，命中磁盘即返回 file
 *     - 图片主动下载：本地未命中且有 picUrl → @napuketto/media downloadUrl 落
 *       cacheDir/media/，返回 file（绝对路径）+ url + file_size/file_name
 *     - 语音主动下载：本地未命中 → kernel MsgApi.downloadPtt（原生
 *       downloadRichMedia + 轮询元素回查）→ filePath 落盘后返回绝对路径；
 *       失败回退原始 filePath（NT 相对/绝对）+ 元数据，不抛错
 * - fetch_ptt_text：message_id → MsgApi.fetchPttText（内部：拉消息 → 找 PTT 元素
 *   → translatePtt2Text → 再拉取读 pttElement.text）
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { kernelError, type Peer, type RawElement } from "@napuketto/kernel";
import { downloadUrl, inferExtension } from "@napuketto/media";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

const getMediaSchema = z.object({
    /** CQ 码 file 字段或 message_id（简化：message_id 反查）。 */
    file: z.string().optional(),
    message_id: z.union([z.number(), z.string()]).optional(),
});

type GetMediaPayload = z.infer<typeof getMediaSchema>;

const fetchPttTextSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
});

/** 媒体信息返回。 */
export interface MediaInfoResult {
    file?: string;
    url?: string;
    file_size?: string;
    file_name?: string;
    base64?: string;
}

/** 媒体动作依赖（OneBotApi 视图）。 */
export type GetMediaDeps = Pick<
    OneBotApi,
    "msgApi" | "messageUnique" | "cacheDir" | "mediaBaseDir" | "logger"
>;

/**
 * NT 相对路径 → 本地绝对路径（存在才返回）。
 * 候选：原样绝对路径 / mediaBaseDir 下相对路径（反斜杠归一化）。
 */
export function resolveLocalMediaFile(
    relPath: string,
    deps: { mediaBaseDir?: string | undefined },
): string | null {
    if (relPath === "") {
        return null;
    }
    if (existsSync(relPath)) {
        return relPath;
    }
    const base = deps.mediaBaseDir;
    if (base !== undefined && base !== "") {
        const joined = join(base, relPath.replaceAll("\\", "/"));
        if (existsSync(joined)) {
            return joined;
        }
    }
    return null;
}

/** 图片主动下载（picUrl → cacheDir/media/<uuid>.<ext>；无 cacheDir/url 返回 null）。 */
async function downloadImageToCache(
    url: string,
    deps: Pick<GetMediaDeps, "cacheDir" | "logger">,
): Promise<string | null> {
    const cacheDir = deps.cacheDir;
    if (cacheDir === undefined || cacheDir === "") {
        return null;
    }
    const mediaDir = join(cacheDir, "media");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mediaDir, { recursive: true });
    const dest = join(mediaDir, `${randomUUID()}${inferExtension(null, url)}`);
    try {
        await downloadUrl(url, dest);
        return dest;
    } catch (err) {
        // 下载失败退原始 url（QQ 端自行拉取；warn 留痕）
        deps.logger?.warn(
            { url, error: err instanceof Error ? err.message : String(err) },
            "ob11: 图片主动下载失败，get_image 退原始 url",
        );
        return null;
    }
}

/**
 * 反查消息并提取媒体元素路径。
 * 返回 null = 消息不存在；extract 返回 undefined = 无匹配元素。
 */
async function resolveMedia(
    id: number | string,
    label: string,
    deps: GetMediaDeps,
    extract: (element: RawElement) => MediaInfoResult | undefined,
): Promise<MediaInfoResult> {
    const { msgId, peer } = resolveMsgIdAndPeer(id, deps.messageUnique);
    const msgs = await deps.msgApi.fetchMsgsByMsgId(peer, [msgId]);
    const [first] = msgs;
    if (first === undefined) {
        throw kernelError(`消息 ${id} 不存在或已被撤回`, "NOT_FOUND");
    }
    for (const el of first.elements) {
        const found = extract(el);
        if (found !== undefined) {
            return found;
        }
    }
    throw kernelError(`消息 ${id} 不包含${label}`, "NOT_FOUND");
}

/** 取 id 参数（message_id 优先，file 兜底）。 */
function takeId(payload: GetMediaPayload, actionName: string): number | string {
    const id = payload.message_id ?? payload.file;
    if (id === undefined) {
        throw kernelError(`${actionName} 需要 message_id 或 file`, "INVALID_PARAM");
    }
    return id;
}

/** 提取 pic 元素 → 媒体信息（url / 本地 file / 元数据；非 pic 元素返回 undefined）。 */
function extractPicElement(
    el: RawElement,
    deps: { mediaBaseDir?: string | undefined },
): MediaInfoResult | undefined {
    // Linux 原生对象未命中的变体字段显式置 null（== null 判据）
    const pic = el.picElement;
    if (pic == null) {
        return undefined;
    }
    const out: MediaInfoResult = {};
    if (pic.fileSize !== undefined) {
        out.file_size = pic.fileSize;
    }
    if (pic.fileName !== undefined) {
        out.file_name = pic.fileName;
    }
    if (pic.picUrl !== undefined) {
        out.url = pic.picUrl;
    }
    const rel = pic.sourcePath ?? pic.picPath;
    if (rel !== undefined) {
        const local = resolveLocalMediaFile(rel, deps);
        if (local !== null) {
            out.file = local;
        }
    }
    return out;
}

/** 原生下载语音 → 元素回查本地路径；下载失败/未命中 null（warn 留痕，不抛错）。 */
async function downloadPttFallback(
    msgId: string,
    peer: Peer,
    id: number | string,
    deps: GetMediaDeps,
): Promise<MediaInfoResult | null> {
    try {
        const downloaded = await deps.msgApi.downloadPtt(msgId, peer);
        const rel = downloaded.filePath;
        if (rel !== undefined && rel !== "") {
            const localAfter = resolveLocalMediaFile(rel, deps);
            if (localAfter !== null) {
                return {
                    ...(downloaded.fileSize !== undefined
                        ? { file_size: downloaded.fileSize }
                        : {}),
                    ...(downloaded.fileName !== undefined
                        ? { file_name: downloaded.fileName }
                        : {}),
                    file: localAfter,
                };
            }
        }
    } catch (err) {
        deps.logger?.warn(
            { message_id: id, error: err instanceof Error ? err.message : String(err) },
            "ob11: 语音原生下载失败，get_record 回退原始路径",
        );
    }
    return null;
}

/** 消息媒体域动作工厂（get_image / get_record / fetch_ptt_text）。 */
export function createMediaActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_image",
            schema: getMediaSchema,
            handle: async (payload): Promise<MediaInfoResult> => {
                const id = takeId(payload, "get_image");
                const base = await resolveMedia(id, "图片", api, (el) =>
                    extractPicElement(el, api),
                );
                // 本地未命中且有 URL → 主动下载到缓存目录
                if (base.file === undefined && base.url !== undefined) {
                    const downloaded = await downloadImageToCache(base.url, api);
                    if (downloaded !== null) {
                        base.file = downloaded;
                    }
                }
                return base;
            },
        }),
        defineOb11Action({
            name: "get_record",
            schema: getMediaSchema,
            handle: async (payload): Promise<MediaInfoResult> => {
                const id = takeId(payload, "get_record");
                const { msgId, peer } = resolveMsgIdAndPeer(id, api.messageUnique);
                const msgs = await api.msgApi.fetchMsgsByMsgId(peer, [msgId]);
                const [first] = msgs;
                if (first === undefined) {
                    throw kernelError(`消息 ${id} 不存在或已被撤回`, "NOT_FOUND");
                }
                // Linux 原生对象未命中的变体字段显式置 null（== null 判据）
                const el = first.elements.find((e) => e.pttElement != null);
                const ptt = el?.pttElement;
                if (ptt == null || ptt.filePath === undefined) {
                    throw kernelError(`消息 ${id} 不包含语音`, "NOT_FOUND");
                }
                const meta = (): MediaInfoResult => ({
                    ...(ptt.fileSize !== undefined ? { file_size: ptt.fileSize } : {}),
                    ...(ptt.fileName !== undefined ? { file_name: ptt.fileName } : {}),
                });
                const local = resolveLocalMediaFile(ptt.filePath, api);
                if (local !== null) {
                    return { ...meta(), file: local };
                }
                // 本地未命中 → 原生下载 + 元素回查；失败回退原始路径
                const downloaded = await downloadPttFallback(msgId, peer, id, api);
                return downloaded ?? { ...meta(), file: ptt.filePath };
            },
        }),
        defineOb11Action({
            name: "fetch_ptt_text",
            schema: fetchPttTextSchema,
            handle: async (payload) => {
                const { msgId, peer } = resolveMsgIdAndPeer(payload.message_id, api.messageUnique);
                const text = await api.msgApi.fetchPttText(msgId, peer);
                return { text };
            },
        }),
    ];
}
