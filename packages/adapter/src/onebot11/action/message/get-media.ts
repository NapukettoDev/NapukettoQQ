/**
 * get_image / get_record 动作：获取图片/语音文件（P2-14；2026-09-08 T5 接主动下载；
 * 2026-09-08 B1 语音接原生 downloadRichMedia）
 *
 * message_id 反查 → fetchMsgsByMsgId → 找 PIC/PTT 元素：
 *  - 本地文件解析：NT 相对路径（sourcePath/filePath）按 mediaBaseDir（QQ NT
 *    global 目录）解析为绝对路径，命中磁盘即返回 file
 *  - 图片主动下载：本地未命中且有 picUrl → @napuketto/media downloadUrl 落
 *    cacheDir/media/，返回 file（绝对路径）+ url + file_size/file_name；
 *    无 picUrl（Windows/Linux 入站形态）或 HTTP 下载失败 → kernel
 *    MsgApi.downloadImage 原生按需下载（issue #105）
 *  - 语音主动下载（B1）：本地未命中 → kernel MsgApi.downloadPtt（原生
 *    downloadRichMedia + 轮询元素回查）→ filePath 落盘后返回绝对路径；
 *    失败回退原始 filePath（NT 相对/绝对）+ 元数据，不抛错
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { kernelError, type Peer, type RawElement } from "@napuketto/kernel";
import { downloadUrl, inferExtension } from "@napuketto/media";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const getMediaSchema = z.object({
    /** CQ 码 file 字段或 message_id（简化：message_id 反查）。 */
    file: z.string().optional(),
    message_id: z.union([z.number(), z.string()]).optional(),
});

type GetMediaPayload = z.infer<typeof getMediaSchema>;

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
    "msgApi" | "messageUnique" | "cacheDir" | "mediaBaseDir"
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
    deps: Pick<GetMediaDeps, "cacheDir">,
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
    } catch {
        return null;
    }
}

/**
 * 反查消息并提取媒体元素路径。
 * 返回 result = null 语义不存在：消息缺失抛错；extract 返回 undefined = 无匹配元素。
 * 同时回传 msgId/peer，供后续主动下载复用（避免二次反查）。
 */
async function resolveMedia(
    id: number | string,
    label: string,
    deps: GetMediaDeps,
    extract: (element: RawElement) => MediaInfoResult | undefined,
): Promise<{ result: MediaInfoResult; msgId: string; peer: Peer }> {
    const { msgId, peer } = resolveMsgIdAndPeer(id, deps.messageUnique);
    const msgs = await deps.msgApi.fetchMsgsByMsgId(peer, [msgId]);
    const [first] = msgs;
    if (first === undefined) {
        throw kernelError(`消息 ${id} 不存在或已被撤回`, "NOT_FOUND");
    }
    for (const el of first.elements) {
        const found = extract(el);
        if (found !== undefined) {
            return { result: found, msgId, peer };
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

/** 获取图片信息（本地优先，picUrl 主动下载 + 原生按需下载兜底）。 */
export class GetImageAction extends BaseAction<GetMediaPayload, MediaInfoResult> {
    readonly name = "get_image";
    readonly schema = getMediaSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: GetMediaDeps;

    constructor(deps: GetMediaDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetMediaPayload): Promise<MediaInfoResult> {
        const id = takeId(payload, "get_image");
        const {
            result: base,
            msgId,
            peer,
        } = await resolveMedia(id, "图片", this.deps, (el) => {
            const pic = el.picElement;
            if (pic === undefined) {
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
                const local = resolveLocalMediaFile(rel, this.deps);
                if (local !== null) {
                    out.file = local;
                }
            }
            return out;
        });
        // 本地未命中且有 URL → 主动下载到缓存目录
        if (base.file === undefined && base.url !== undefined) {
            const downloaded = await downloadImageToCache(base.url, this.deps);
            if (downloaded !== null) {
                base.file = downloaded;
            }
        }
        // 仍无文件（无 picUrl 的 Windows/Linux 入站形态，或 HTTP 下载失败）→ 原生按需下载
        if (base.file === undefined) {
            try {
                const { filePath } = await this.deps.msgApi.downloadImage(msgId, peer);
                base.file = filePath;
            } catch {
                // 下载失败：回退元数据（不抛错，对齐语音口径）
            }
        }
        return base;
    }
}

/** 获取语音信息（本地优先；未命中走原生 downloadRichMedia，失败回退原始路径）。 */
export class GetRecordAction extends BaseAction<GetMediaPayload, MediaInfoResult> {
    readonly name = "get_record";
    readonly schema = getMediaSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: GetMediaDeps;

    constructor(deps: GetMediaDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetMediaPayload): Promise<MediaInfoResult> {
        const id = takeId(payload, "get_record");
        const { msgId, peer } = resolveMsgIdAndPeer(id, this.deps.messageUnique);
        const msgs = await this.deps.msgApi.fetchMsgsByMsgId(peer, [msgId]);
        const [first] = msgs;
        if (first === undefined) {
            throw kernelError(`消息 ${id} 不存在或已被撤回`, "NOT_FOUND");
        }
        const el = first.elements.find((e) => e.pttElement !== undefined);
        const ptt = el?.pttElement;
        if (ptt === undefined || ptt.filePath === undefined) {
            throw kernelError(`消息 ${id} 不包含语音`, "NOT_FOUND");
        }
        const meta = (): MediaInfoResult => ({
            ...(ptt.fileSize !== undefined ? { file_size: ptt.fileSize } : {}),
            ...(ptt.fileName !== undefined ? { file_name: ptt.fileName } : {}),
        });
        const local = resolveLocalMediaFile(ptt.filePath, this.deps);
        if (local !== null) {
            return { ...meta(), file: local };
        }
        // 本地未命中 → 原生下载（downloadRichMedia + 元素回查；失败回退原始路径）
        try {
            const downloaded = await this.deps.msgApi.downloadPtt(msgId, peer);
            const rel = downloaded.filePath;
            if (rel !== undefined && rel !== "") {
                const localAfter = resolveLocalMediaFile(rel, this.deps);
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
        } catch {
            // 下载失败：回退现状（原始路径 + 元数据，不抛错）
        }
        return { ...meta(), file: ptt.filePath };
    }
}
