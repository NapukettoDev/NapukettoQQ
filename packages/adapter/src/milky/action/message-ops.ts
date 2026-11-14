/**
 * Milky 消息操作域动作：recall_private_message / recall_group_message /
 * mark_message_as_read / get_custom_face_url_list（收藏表情）/ get_resource_temp_url
 * （资源反查）/ upload_private_file（闪传通道，分享链接卡片）。
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
import { defineMilkyAction, type MilkyAction } from "./base-action.js";
import { peerMessageFields } from "./message-query.js";

const recallFields = { message_seq: z.number().int().min(0) } as const;

/** 消息操作域动作工厂（recall×2 / mark_read / 收藏表情 / 资源反查 / 私聊文件上传）。 */
export function createMessageOpsActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "recall_private_message",
            schema: z.object({ user_id: z.number().int().min(10001), ...recallFields }),
            handle: async (payload: { user_id: number; message_seq: number }) => {
                const peer = await api.resolvePeer("friend", payload.user_id);
                await recallBySeq(peer, payload.message_seq, api);
                return {};
            },
        }),
        defineMilkyAction({
            name: "recall_group_message",
            schema: z.object({ group_id: z.number().int().min(10001), ...recallFields }),
            handle: async (payload: { group_id: number; message_seq: number }) => {
                const peer = await api.resolvePeer("group", payload.group_id);
                await recallBySeq(peer, payload.message_seq, api);
                return {};
            },
        }),
        defineMilkyAction({
            name: "mark_message_as_read",
            schema: z.object({ ...peerMessageFields }),
            // NT setMsgRead 以会话为粒度，seq 入参仅兼容 schema
            handle: async (payload: {
                message_scene: MessageScene;
                peer_id: number;
                message_seq: number;
            }) => {
                const peer = await api.resolvePeer(payload.message_scene, payload.peer_id);
                await api.msgApi.markRead(peer);
                return {};
            },
        }),
        defineMilkyAction({
            name: "get_custom_face_url_list",
            schema: z.object({}),
            // queryFavEmojiByDesc 形状待校准
            handle: async (): Promise<GetCustomFaceUrlListOutput> => ({
                urls: await api.msgApi.queryFavEmojis(),
            }),
        }),
        defineMilkyAction({
            name: "get_resource_temp_url",
            schema: z.object({ resource_id: z.string().min(1) }),
            handle: async (payload: { resource_id: string }): Promise<GetResourceTempUrlOutput> => {
                const id = payload.resource_id;
                if (
                    id.startsWith("http://") ||
                    id.startsWith("https://") ||
                    id.startsWith("base64://")
                ) {
                    return { url: id };
                }
                throw kernelError(`资源 ${id} 无临时链接（resource_id 非链接形态）`, "NOT_FOUND");
            },
        }),
        defineMilkyAction({
            name: "upload_private_file",
            schema: z.object({
                user_id: z.number().int().min(10001),
                file_uri: z.string().min(1),
                file_name: z.string().min(1),
            }),
            // 闪传通道：对端收到分享链接卡片而不是 fileElement 文件消息（kernel design §15）
            handle: async (payload: {
                user_id: number;
                file_uri: string;
                file_name: string;
            }): Promise<UploadFileOutput> => {
                const path = await resolveUriToPath(payload.file_uri, api.mediaDir);
                const peer = await api.resolvePeer("friend", payload.user_id);
                const uploaded = await api.flashTransferApi.sendFile(peer, [path], {
                    name: payload.file_name,
                });
                return { file_id: uploaded.fileSetId };
            },
        }),
    ];
}

/** seq → msgId（反查）→ recallMessage。 */
async function recallBySeq(peer: Peer, seq: number, api: MilkyApi): Promise<void> {
    const msgId = await api.resolveMsgIdBySeq(peer, seq, peer.chatType);
    if (msgId === undefined) {
        throw kernelError(`消息 ${seq} 不存在`, "NOT_FOUND");
    }
    await api.msgApi.recallMessage(peer, [msgId]);
}
