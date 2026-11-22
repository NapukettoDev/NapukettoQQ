/**
 * 文件收发域动作
 *
 * - download_file：按媒体出站策略下载到 cacheDir 的独立缓存文件，返回 { file }。
 * - upload_group_file / upload_private_file——**闪传通道**
 *
 * ⚠️ 语义降级（探测依据见 kernel design §15）：
 * QQ NT 没有任何「把文件传进群文件列表」的 NAPI，`sendMsg` 带 fileElement 时原生走的
 * 文件传输命令被服务端拒绝（`170019002`，逐维扫参无效），`fileUuid` 永远拿不到。唯一实测
 * 可用的投递通道是闪传：上传文件集 → 发分享卡片。因此本动作：
 *  - 对端收到的是「分享链接卡片」（`qfile.qq.com`），**不是 fileElement 文件消息**，
 *    也**不进群文件列表**；
 *  - 返回的 `file_id` 是闪传文件集 id，只可自留，**不能**喂给 delete_group_file /
 *    get_group_file_download_url 等群文件动作；
 *  - `name` 作为文件集名称（卡片标题）；`folder` 忽略（闪传没有目录概念）。
 *
 * 输入只接受本地路径与 `file://` URI：远程 `http(s)://` / `base64://` 需要下载缓存与媒体
 * 依赖，当前未接（明确报错，不静默失败）。
 */

import { basename } from "node:path";
import { ChatType, kernelError, type Peer } from "@napuketto/kernel";
import { inferExtension } from "@napuketto/media";
import { z } from "zod";
import { resolveLocalMedia } from "../../../internal/infra/local-media.js";
import { cacheMediaFile } from "../../../internal/infra/media-cache.js";
import { downloadProtocolMedia } from "../../../internal/qq/media.js";
import type { OneBotApi } from "../../api/onebot-api.js";
import { defineOb11Action, type Ob11Action, resolveTargetPeer } from "../base-action.js";

const downloadFileSchema = z.object({
    url: z.string(),
    thread_count: z.number().optional(),
    headers: z.record(z.string(), z.string()).optional(),
});

const uploadGroupFileSchema = z.object({
    group_id: z.number(),
    file: z.string().min(1),
    name: z.string().optional(),
    /** go-cqhttp 兼容字段：闪传无目录概念，忽略。 */
    folder: z.string().optional(),
});

const uploadPrivateFileSchema = z.object({
    user_id: z.number(),
    file: z.string().min(1),
    name: z.string().optional(),
});

/** 上传动作响应（闪传文件集 id）。 */
interface UploadFileResult {
    file_id: string;
}

/** 文件收发域动作工厂（download_file / upload_group_file / upload_private_file）。 */
export function createSystemFileActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "download_file",
            schema: downloadFileSchema,
            handle: async (payload) => {
                const { cacheDir } = api;
                if (cacheDir === undefined || cacheDir === "") {
                    throw kernelError(
                        "download_file 未配置缓存目录（装配方未注入）",
                        "INVALID_STATE",
                    );
                }
                const filePath = await cacheMediaFile(
                    cacheDir,
                    inferExtension(null, payload.url),
                    async (path) => {
                        await downloadProtocolMedia(payload.url, path, {
                            outboundPolicy: api.getMediaOutboundPolicy?.(),
                            headers: payload.headers,
                        });
                    },
                    "reference",
                );
                return { file: filePath };
            },
        }),
        defineOb11Action({
            name: "upload_group_file",
            schema: uploadGroupFileSchema,
            handle: async (payload): Promise<UploadFileResult> => {
                const path = await resolveLocalMedia(payload.file, api.getLocalMediaRoots?.());
                const peer: Peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
                const uploaded = await api.flashTransferApi.sendFile(peer, [path], {
                    name: payload.name ?? basename(path),
                });
                return { file_id: uploaded.fileSetId };
            },
        }),
        defineOb11Action({
            name: "upload_private_file",
            schema: uploadPrivateFileSchema,
            handle: async (payload): Promise<UploadFileResult> => {
                const path = await resolveLocalMedia(payload.file, api.getLocalMediaRoots?.());
                const peer = await resolveTargetPeer(
                    { user_id: payload.user_id },
                    api,
                    "upload_private_file 需要 user_id",
                );
                const uploaded = await api.flashTransferApi.sendFile(peer, [path], {
                    name: payload.name ?? basename(path),
                });
                return { file_id: uploaded.fileSetId };
            },
        }),
    ];
}
