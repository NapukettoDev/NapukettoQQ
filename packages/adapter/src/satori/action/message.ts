/**
 * Satori 消息动作：message.create / get / list / delete
 * （message.update：QQ 不支持编辑 → 501，见 registry）
 */
import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { kernelError, type Peer, type RawMessage } from "@napuketto/kernel";
import { z } from "zod";
import { prepareImageElements } from "../../internal/domain/media.js";
import type { SatoriApi } from "../api/satori-api.js";
import { parseContentToCanonical } from "../helper/element/element-convert.js";
import { toChannelById, toSatoriMessage } from "../helper/index.js";
import type { BidiList, Message } from "../types/index.js";
import { defineSatoriAction, type SatoriActionHandler } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type MessageActionDeps = Pick<
    SatoriApi,
    | "msgApi"
    | "selfUin"
    | "uidToUin"
    | "resolvePeer"
    | "setChannelType"
    | "toCanonicalDeps"
    | "publishLocalAsset"
    | "logger"
>;

/** 消息列表默认条数（规范推荐 50）。 */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

/** message.create 参数。 */
const messageCreateSchema = z.object({
    channel_id: z.string(),
    content: z.string(),
    /** 被动请求来源（第一版透传忽略，QQ 不区分主动/被动）。 */
    referrer: z.unknown().optional(),
});

/** 消息动作工厂（create / get / list / delete）。 */
export function createMessageActions(deps: MessageActionDeps): SatoriActionHandler[] {
    return [
        defineSatoriAction({
            name: "message.create",
            schema: messageCreateSchema,
            // 发送消息：返回 Message 数组（规范）
            handle: async (payload): Promise<Message[]> => {
                const { channel_id: channelId, content } = payload;
                const peer = await deps.resolvePeer(channelId);
                deps.setChannelType(channelId, peer.chatType === 2);
                const ownedOutputs = new Set<string>();
                let msgId: string;
                try {
                    const elements = await prepareImageElements(
                        await parseContentToCanonical(content, {
                            ...deps.toCanonicalDeps(),
                            onVideoTranscoded: (path) => ownedOutputs.add(path),
                        }),
                        deps.logger,
                    );
                    ({ msgId } = await deps.msgApi.sendMessage(peer, elements));
                } finally {
                    await Promise.all(
                        [...ownedOutputs].map(async (path) => {
                            await rm(path, { force: true });
                            // Only remove the now-empty directory owned by transcodeVideo.
                            await rmdir(dirname(path));
                        }),
                    );
                }
                const message: Message = {
                    id: msgId,
                    channel: toChannelById(channelId, peer.chatType === 2),
                };
                // content 回显原始输入（发送成功即已按协议解析；规范化回显留待后续）
                message.content = content;
                return [message];
            },
        }),
        defineSatoriAction({
            name: "message.get",
            schema: z.object({
                channel_id: z.string(),
                message_id: z.string(),
            }),
            handle: async (payload): Promise<Message> => {
                const { channel_id: channelId, message_id: messageId } = payload;
                const peer = await deps.resolvePeer(channelId);
                const msgs = await deps.msgApi.fetchMsgsByMsgId(peer, [messageId]);
                const first = msgs[0];
                if (first === undefined) {
                    throw kernelError("消息不存在", "NOT_FOUND");
                }
                deps.setChannelType(channelId, peer.chatType === 2);
                return toSatoriMessage(first, {
                    selfUin: deps.selfUin,
                    uidToUin: (uids) => deps.uidToUin(uids),
                    publishLocalAsset: deps.publishLocalAsset,
                });
            },
        }),
        defineSatoriAction({
            name: "message.list",
            schema: z.object({
                channel_id: z.string(),
                /** 分页令牌（缺省从最新开始）。 */
                next: z.string().min(1).nullish(),
                /** 查询方向（缺省 before）。 */
                direction: z.enum(["before", "after", "around"]).optional(),
                /** 消息数量限制（缺省平台默认，推荐 50）。 */
                limit: z.int().positive().optional(),
                /** 排序（缺省 asc）。 */
                order: z.enum(["asc", "desc"]).optional(),
            }),
            handle: async (payload): Promise<BidiList<Message>> => {
                const { channel_id: channelId, next, direction, limit, order } = payload;
                if (direction !== undefined && direction !== "before") {
                    throw kernelError(`暂不支持 ${direction} 方向`, "INVALID_PARAM");
                }
                const peer = await deps.resolvePeer(channelId);
                const count = Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
                const page = await fetchBefore(deps.msgApi, peer, next ?? "", count);
                deps.setChannelType(channelId, peer.chatType === 2);
                const delivered = page.slice(0, count);
                const cursor = page.length > count ? delivered.at(-1)?.msgId : undefined;
                const ordered = order === "desc" ? delivered : delivered.reverse();
                const messages: Message[] = [];
                for (const msg of ordered) {
                    messages.push(
                        await toSatoriMessage(msg, {
                            selfUin: deps.selfUin,
                            uidToUin: (uids) => deps.uidToUin(uids),
                        }),
                    );
                }
                return cursor === undefined
                    ? { data: messages }
                    : { data: messages, prev: cursor, next: cursor };
            },
        }),
        defineSatoriAction({
            name: "message.delete",
            schema: z.object({
                channel_id: z.string(),
                message_id: z.string(),
            }),
            handle: async (payload): Promise<void> => {
                const { channel_id: channelId, message_id: messageId } = payload;
                const peer = await deps.resolvePeer(channelId);
                await deps.msgApi.recallMessage(peer, [messageId]);
            },
        }),
    ];
}

/** 原生历史按新到旧读取，允许原生把起始消息也放进响应。 */
async function fetchBefore(
    api: MessageActionDeps["msgApi"],
    peer: Peer,
    start: string,
    count: number,
): Promise<RawMessage[]> {
    const seen = new Set(["", start]);
    const messages: RawMessage[] = [];
    let cursor = start;
    while (messages.length <= count) {
        const remaining = count + 1 - messages.length;
        const raw = await api.fetchMessages(peer, {
            count: remaining + (cursor === "" ? 0 : 1),
            msgId: cursor,
        });
        const anchor = raw.findIndex(({ msgId }) => msgId === cursor);
        const older = raw.slice(anchor + 1).filter(({ msgId }) => {
            if (seen.has(msgId)) {
                return false;
            }
            seen.add(msgId);
            return true;
        });
        const oldest = older.at(-1);
        if (oldest === undefined) {
            break;
        }
        messages.push(...older);
        cursor = oldest.msgId;
    }
    return messages;
}
