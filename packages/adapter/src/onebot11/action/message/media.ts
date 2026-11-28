/**
 * 消息媒体域动作
 *
 * - get_image/get_record：经当前账号的消息 API 取资源，并导出到带租约的缓存。
 * - fetch_ptt_text：经内核拉取语音转文字。
 */

import { errorMessage, kernelError, type Peer, type RawElement } from "@napuketto/kernel";
import { inferExtension } from "@napuketto/media";
import { z } from "zod";
import { mediaDownloader } from "../../../internal/domain/media.js";
import { exportQqMedia } from "../../../internal/infra/local-media.js";
import { cacheMediaFile } from "../../../internal/infra/media-cache.js";
import type { OneBotApi } from "../../api/onebot-api.js";
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
    "msgApi" | "messageUnique" | "cacheDir" | "mediaBaseDir" | "logger" | "getMediaOutboundPolicy"
>;

/** 图片主动下载（picUrl → cacheDir/media/<uuid>.<ext>；无 cacheDir/url 返回 null）。 */
async function downloadImageToCache(
    url: string,
    deps: Pick<GetMediaDeps, "cacheDir" | "logger" | "getMediaOutboundPolicy">,
): Promise<string | null> {
    const cacheDir = deps.cacheDir;
    if (cacheDir === undefined || cacheDir === "") {
        return null;
    }
    try {
        return await cacheMediaFile(
            cacheDir,
            inferExtension(null, url),
            async (dest) => {
                await mediaDownloader(deps.getMediaOutboundPolicy?.())(url, dest);
            },
            "reference",
        );
    } catch (err) {
        // 下载失败退原始 url（QQ 端自行拉取；warn 留痕）
        deps.logger?.warn(
            { error: errorMessage(err) },
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
    extract: (element: RawElement) => Promise<MediaInfoResult | undefined>,
): Promise<MediaInfoResult> {
    const { msgId, peer } = resolveMsgIdAndPeer(id, deps.messageUnique);
    const msgs = await deps.msgApi.fetchMsgsByMsgId(peer, [msgId]);
    const [first] = msgs;
    if (first === undefined) {
        throw kernelError(`消息 ${id} 不存在或已被撤回`, "NOT_FOUND");
    }
    for (const el of first.elements) {
        const found = await extract(el);
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
async function extractPicElement(
    el: RawElement,
    deps: GetMediaDeps,
): Promise<MediaInfoResult | undefined> {
    const pic = el.picElement;
    if (pic == null) {
        return undefined;
    }
    const out: MediaInfoResult = {};
    if (pic.fileSize != null) {
        out.file_size = pic.fileSize;
    }
    if (pic.fileName != null) {
        out.file_name = pic.fileName;
    }
    if (pic.picUrl != null) {
        out.url = pic.picUrl;
    }
    const rel = pic.sourcePath || pic.picPath;
    if (rel != null) {
        const local = await exportQqMedia(rel, deps.mediaBaseDir, deps.cacheDir);
        if (local !== undefined) {
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
        if (rel != null && rel !== "") {
            const localAfter = await exportQqMedia(rel, deps.mediaBaseDir, deps.cacheDir);
            if (localAfter !== undefined) {
                return {
                    ...(downloaded.fileSize != null ? { file_size: downloaded.fileSize } : {}),
                    ...(downloaded.fileName != null ? { file_name: downloaded.fileName } : {}),
                    file: localAfter,
                };
            }
        }
    } catch (err) {
        deps.logger?.warn(
            { message_id: id, error: errorMessage(err) },
            "ob11: 语音原生下载失败，get_record 回退元数据",
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
                const el = first.elements.find((e) => e.pttElement != null);
                const ptt = el?.pttElement;
                const filePath = ptt?.filePath;
                if (ptt == null || filePath == null) {
                    throw kernelError(`消息 ${id} 不包含语音`, "NOT_FOUND");
                }
                const meta = (): MediaInfoResult => ({
                    ...(ptt.fileSize != null ? { file_size: ptt.fileSize } : {}),
                    ...(ptt.fileName != null ? { file_name: ptt.fileName } : {}),
                });
                const local = await exportQqMedia(filePath, api.mediaBaseDir, api.cacheDir);
                if (local !== undefined) {
                    return { ...meta(), file: local };
                }
                // 本地未命中 → 原生下载 + 元素回查；失败回退元数据
                const downloaded = await downloadPttFallback(msgId, peer, id, api);
                return downloaded ?? meta();
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
