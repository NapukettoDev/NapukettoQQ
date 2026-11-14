/**
 * Satori 消息动作：message.create / get / list / delete
 * （message.update：QQ 不支持编辑 → 501，见 registry）
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { parseContentToCanonical } from "../helper/element/element-convert.js";
import { toChannelById, toSatoriMessage } from "../helper/index.js";
import type { BidiList, Message } from "../types/index.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type MessageActionDeps = Pick<
    SatoriApi,
    "msgApi" | "selfUin" | "uidToUin" | "resolvePeer" | "setChannelType" | "toCanonicalDeps"
>;

/** 消息列表默认条数（规范推荐 50）。 */
const DEFAULT_LIST_LIMIT = 50;

/** message.create 参数。 */
const messageCreateSchema = z.object({
    channel_id: z.string(),
    content: z.string(),
    /** 被动请求来源（第一版透传忽略，QQ 不区分主动/被动）。 */
    referrer: z.unknown().optional(),
});

/** 消息动作工厂（create / get / list / delete）。 */
export function createMessageActions(deps: MessageActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "message.create",
            schema: messageCreateSchema,
            // 发送消息：返回 Message 数组（规范）
            handle: async (payload): Promise<Message[]> => {
                const { channel_id: channelId, content } = payload;
                const peer = await deps.resolvePeer(channelId);
                deps.setChannelType(channelId, peer.chatType === 2);
                const elements = await parseContentToCanonical(content, deps.toCanonicalDeps());
                const { msgId } = await deps.msgApi.sendMessage(peer, elements);
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
                    throw new Error("消息不存在");
                }
                deps.setChannelType(channelId, peer.chatType === 2);
                return toSatoriMessage(first, {
                    selfUin: deps.selfUin,
                    uidToUin: (uids) => deps.uidToUin(uids),
                });
            },
        }),
        defineSatoriAction({
            name: "message.list",
            schema: z.object({
                channel_id: z.string(),
                /** 分页令牌（缺省从最新开始）。 */
                next: z.string().optional(),
                /** 查询方向（缺省 before）。 */
                direction: z.enum(["before", "after", "around"]).optional(),
                /** 消息数量限制（缺省平台默认，推荐 50）。 */
                limit: z.number().int().optional(),
                /** 排序（缺省 asc）。 */
                order: z.enum(["asc", "desc"]).optional(),
            }),
            // 双向分页；第一版仅支持 before 方向
            handle: async (payload): Promise<BidiList<Message>> => {
                const { channel_id: channelId, next, direction, limit, order } = payload;
                if (direction === "around") {
                    throw new Error("暂不支持 around 方向");
                }
                const peer = await deps.resolvePeer(channelId);
                const count = limit ?? DEFAULT_LIST_LIMIT;
                const raw = await deps.msgApi.fetchMessages(peer, {
                    count,
                    msgId: next ?? "",
                });
                deps.setChannelType(channelId, peer.chatType === 2);
                // QQ getMsgs 返回时间倒序（最新在前）；Satori 默认 asc（旧在前）
                const asc = order !== "desc";
                const ordered = asc ? [...raw].reverse() : raw;
                const messages: Message[] = [];
                for (const msg of ordered) {
                    messages.push(
                        await toSatoriMessage(msg, {
                            selfUin: deps.selfUin,
                            uidToUin: (uids) => deps.uidToUin(uids),
                        }),
                    );
                }
                // 分页令牌：asc 时下一页为更早消息 → 首条（最早）的 msgId；desc 时下一批更新 → 末条 msgId
                const last = messages[messages.length - 1];
                const out: BidiList<Message> = { data: messages };
                if (last !== undefined && raw.length >= count) {
                    out.next = last.id;
                }
                return out;
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
