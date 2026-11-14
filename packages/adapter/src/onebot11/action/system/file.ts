/**
 * 文件收发域动作（2026-11-14 自 system/download-file 与根部 upload-file 合并）
 *
 * - download_file（P2-12）：url → fetch 下载 → 存 cacheDir（缺省抛错）→ 返回
 *   { file }。文件名：download-<timestamp>-<basename>（headers 等扩展字段忽略）
 * - upload_group_file / upload_private_file——**闪传通道**
 *
 * ⚠️ 语义降级（2026-11-11 决定，探测依据见 kernel design §15）：
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

import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename as pathBasename } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatType, kernelError, type Peer } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { resolveTargetPeer } from "../message/resolve-peer.js";

const downloadFileSchema = z.object({
    url: z.string(),
    thread_count: z.number().optional(),
    headers: z.record(z.string(), z.string()).optional(),
});

type DownloadFilePayload = z.infer<typeof downloadFileSchema>;

/** download_file 依赖（cacheDir 由装配方注入，OneBotApi 视图）。 */
export type DownloadFileDeps = Pick<OneBotApi, "cacheDir">;

/** 下载文件到缓存目录（P2-12）。 */
export class DownloadFileAction extends BaseAction<DownloadFilePayload, { file: string }> {
    readonly name = "download_file";
    readonly schema = downloadFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: DownloadFileDeps;

    constructor(deps: DownloadFileDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: DownloadFilePayload): Promise<{ file: string }> {
        const { cacheDir } = this.deps;
        if (cacheDir === undefined || cacheDir === "") {
            throw kernelError("download_file 未配置缓存目录（装配方未注入）", "INVALID_STATE");
        }
        const safeName = pathBasename(new URL(payload.url).pathname) || "download.bin";
        const filePath = join(cacheDir, `download-${Date.now()}-${safeName}`);
        mkdirSync(cacheDir, { recursive: true });
        const init: RequestInit = {};
        if (payload.headers !== undefined) {
            init.headers = payload.headers;
        }
        const res = await fetch(payload.url, init);
        if (!res.ok) {
            throw new Error(`下载失败: ${res.status} ${res.statusText}`);
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        writeFileSync(filePath, buf);
        return { file: filePath };
    }
}

/** file:// 前缀（fileURLToPath 失败时的裸剥离兜底）。 */
const FILE_URI_PREFIX_RE = /^file:\/\//;

/** 路径分隔符（取文件名用）。 */
const PATH_SEPARATORS = /[\\/]/;

/** 上传动作响应（闪传文件集 id）。 */
export interface UploadFileResult {
    file_id: string;
}

const uploadGroupFileSchema = z.object({
    group_id: z.number(),
    file: z.string().min(1),
    name: z.string().optional(),
    /** go-cqhttp 兼容字段：闪传无目录概念，忽略。 */
    folder: z.string().optional(),
});

type UploadGroupFilePayload = z.infer<typeof uploadGroupFileSchema>;

const uploadPrivateFileSchema = z.object({
    user_id: z.number(),
    file: z.string().min(1),
    name: z.string().optional(),
});

type UploadPrivateFilePayload = z.infer<typeof uploadPrivateFileSchema>;

/** 上传动作依赖（OneBotApi 视图：闪传通道 + uin→uid 转换）。 */
export type UploadFileDeps = Pick<OneBotApi, "flashTransferApi" | "uinToUid">;

/** upload_group_file：上传文件并投递到群（闪传卡片；语义降级见文件头）。 */
export class UploadGroupFileAction extends BaseAction<UploadGroupFilePayload, UploadFileResult> {
    readonly name = "upload_group_file";
    readonly schema = uploadGroupFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: UploadFileDeps;

    constructor(deps: UploadFileDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: UploadGroupFilePayload): Promise<UploadFileResult> {
        const path = resolveLocalFile(payload.file);
        const peer: Peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
        const uploaded = await this.deps.flashTransferApi.sendFile(peer, [path], {
            name: payload.name ?? basename(path),
        });
        return { file_id: uploaded.fileSetId };
    }
}

/** upload_private_file：上传文件并投递到私聊（闪传卡片；语义降级见文件头）。 */
export class UploadPrivateFileAction extends BaseAction<
    UploadPrivateFilePayload,
    UploadFileResult
> {
    readonly name = "upload_private_file";
    readonly schema = uploadPrivateFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: UploadFileDeps;

    constructor(deps: UploadFileDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: UploadPrivateFilePayload): Promise<UploadFileResult> {
        const path = resolveLocalFile(payload.file);
        const peer = await resolveTargetPeer(
            { user_id: payload.user_id },
            this.deps,
            "upload_private_file 需要 user_id",
        );
        const uploaded = await this.deps.flashTransferApi.sendFile(peer, [path], {
            name: payload.name ?? basename(path),
        });
        return { file_id: uploaded.fileSetId };
    }
}

/** 本地路径 / file:// 展开；远程 URI 明确拒绝（未接下载缓存）。 */
function resolveLocalFile(file: string): string {
    if (file.startsWith("http://") || file.startsWith("https://") || file.startsWith("base64://")) {
        throw kernelError(
            "upload_group_file/upload_private_file 目前只支持本地路径与 file:// URI（远程 URI 需要下载缓存，未接入）",
            "INVALID_PARAM",
        );
    }
    if (file.startsWith("file://")) {
        try {
            return fileURLToPath(file);
        } catch {
            return file.replace(FILE_URI_PREFIX_RE, "");
        }
    }
    return file;
}

/** 取路径末段作为缺省文件集名（卡片标题）。 */
function basename(path: string): string {
    const parts = path.split(PATH_SEPARATORS);
    const last = parts[parts.length - 1] ?? "";
    return last === "" ? "文件" : last;
}

/** 文件收发域动作工厂（download_file / upload_group_file / upload_private_file）。 */
export function createSystemFileActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new DownloadFileAction(api),
        new UploadGroupFileAction(api),
        new UploadPrivateFileAction(api),
    ];
}
