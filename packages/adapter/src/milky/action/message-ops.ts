/**
 * Milky 消息操作域动作（2026-11-14 自 message.ts 拆分，结构重构会话 4/5）
 *
 * P0：recall_private_message / recall_group_message；P1：mark_message_as_read；
 * P2 批次二：get_custom_face_url_list（收藏表情）/ get_resource_temp_url（资源
 * 反查）/ upload_private_file（闪传通道，分享链接卡片）。
 * get/recall 入口是 message_seq（Milky ID 模型），经 seqIndex 反查 msgId。
 */
import type { Peer } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { resolveUriToPath } from "../helper/message/media-uri.js";
import type {
    GetCustomFaceUrlListOutput,
    GetResourceTempUrlOutput,
    MessageScene,
    UploadFileOutput,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";
import { peerMessageFields } from "./message-query.js";

const recallFields = { message_seq: z.number().int().min(0) } as const;

/** recall_private_message：撤回私聊消息。 */
export class RecallPrivateMessageAction extends MilkyApiAction<
    { user_id: number; message_seq: number },
    Record<string, never>
> {
    readonly name = "recall_private_message";
    readonly schema = z.object({ user_id: z.number().int().min(10001), ...recallFields });

    protected async _handle(payload: {
        user_id: number;
        message_seq: number;
    }): Promise<Record<string, never>> {
        const peer = await this.api.resolvePeer("friend", payload.user_id);
        await recallBySeq(peer, payload.message_seq, this.api);
        return {};
    }
}

/** recall_group_message：撤回群消息。 */
export class RecallGroupMessageAction extends MilkyApiAction<
    { group_id: number; message_seq: number },
    Record<string, never>
> {
    readonly name = "recall_group_message";
    readonly schema = z.object({ group_id: z.number().int().min(10001), ...recallFields });

    protected async _handle(payload: {
        group_id: number;
        message_seq: number;
    }): Promise<Record<string, never>> {
        const peer = await this.api.resolvePeer("group", payload.group_id);
        await recallBySeq(peer, payload.message_seq, this.api);
        return {};
    }
}

/** seq → msgId（反查）→ recallMessage。 */
async function recallBySeq(peer: Peer, seq: number, api: MilkyApi): Promise<void> {
    const msgId = await api.resolveMsgIdBySeq(peer, seq, peer.chatType);
    if (msgId === undefined) {
        throw kernelError(`消息 ${seq} 不存在`, "NOT_FOUND");
    }
    await api.msgApi.recallMessage(peer, [msgId]);
}

/** mark_message_as_read：标记会话已读（NT setMsgRead 以会话为粒度，seq 入参仅兼容 schema）。 */
export class MarkMessageAsReadAction extends MilkyApiAction<
    { message_scene: MessageScene; peer_id: number; message_seq: number },
    Record<string, never>
> {
    readonly name = "mark_message_as_read";
    readonly schema = z.object({ ...peerMessageFields });

    protected async _handle(payload: {
        message_scene: MessageScene;
        peer_id: number;
        message_seq: number;
    }): Promise<Record<string, never>> {
        const peer = await this.api.resolvePeer(payload.message_scene, payload.peer_id);
        await this.api.msgApi.markRead(peer);
        return {};
    }
}

/** get_custom_face_url_list：收藏表情链接（queryFavEmojiByDesc 形状待校准）。 */
export class GetCustomFaceUrlListAction extends MilkyApiAction<
    Record<string, never>,
    GetCustomFaceUrlListOutput
> {
    readonly name = "get_custom_face_url_list";
    readonly schema = z.object({});

    protected async _handle(): Promise<GetCustomFaceUrlListOutput> {
        return { urls: await this.api.msgApi.queryFavEmojis() };
    }
}

/**
 * get_resource_temp_url：资源临时链接。
 * 已知差异（P0 模型）：接收段 resource_id 即临时链接（本地路径优先 url 兜底），
 * 无独立资源索引——http(s)/base64 形态原样返回，其余 NOT_FOUND。
 */
export class GetResourceTempUrlAction extends MilkyApiAction<
    { resource_id: string },
    GetResourceTempUrlOutput
> {
    readonly name = "get_resource_temp_url";
    readonly schema = z.object({ resource_id: z.string().min(1) });

    protected async _handle(payload: { resource_id: string }): Promise<GetResourceTempUrlOutput> {
        const id = payload.resource_id;
        if (id.startsWith("http://") || id.startsWith("https://") || id.startsWith("base64://")) {
            return { url: id };
        }
        throw kernelError(`资源 ${id} 无临时链接（resource_id 非链接形态）`, "NOT_FOUND");
    }
}

/**
 * upload_private_file：上传并投递私聊文件（**闪传通道**：分享链接卡片）。
 * file_id 返回闪传文件集 id（非文件消息 fileUuid）。语义降级同 upload_group_file：
 * 对端收到的是分享链接卡片而不是 fileElement 文件消息（kernel design §15）。
 */
export class UploadPrivateFileAction extends MilkyApiAction<
    { user_id: number; file_uri: string; file_name: string },
    UploadFileOutput
> {
    readonly name = "upload_private_file";
    readonly schema = z.object({
        user_id: z.number().int().min(10001),
        file_uri: z.string().min(1),
        file_name: z.string().min(1),
    });

    protected async _handle(payload: {
        user_id: number;
        file_uri: string;
        file_name: string;
    }): Promise<UploadFileOutput> {
        const path = await resolveUriToPath(payload.file_uri, this.api.mediaDir);
        const peer = await this.api.resolvePeer("friend", payload.user_id);
        const uploaded = await this.api.flashTransferApi.sendFile(peer, [path], {
            name: payload.file_name,
        });
        return { file_id: uploaded.fileSetId };
    }
}
