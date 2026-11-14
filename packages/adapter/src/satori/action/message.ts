/**
 * Satori 消息动作：message.create / get / list / delete
 * （message.update：QQ 不支持编辑 → 501，见 registry）
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { parseContentToCanonical } from "../helper/element/element-convert.js";
import { toChannelById, toSatoriMessage } from "../helper/index.js";
import type { BidiList, Message } from "../types/index.js";
import { BaseSatoriAction } from "./base-action.js";

/** 消息列表默认条数（规范推荐 50）。 */
const DEFAULT_LIST_LIMIT = 50;

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type MessageActionDeps = Pick<
    SatoriApi,
    "msgApi" | "selfUin" | "uidToUin" | "resolvePeer" | "setChannelType" | "toCanonicalDeps"
>;

/** message.create 参数。 */
const messageCreateSchema = z.object({
    channel_id: z.string(),
    content: z.string(),
    /** 被动请求来源（第一版透传忽略，QQ 不区分主动/被动）。 */
    referrer: z.unknown().optional(),
});

/** 发送消息：返回 Message 数组（规范）。 */
export class MessageCreateAction extends BaseSatoriAction<
    z.infer<typeof messageCreateSchema>,
    Message[]
> {
    readonly name = "message.create";
    readonly schema = messageCreateSchema;
    private readonly deps: MessageActionDeps;

    constructor(deps: MessageActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof messageCreateSchema>): Promise<Message[]> {
        const { channel_id: channelId, content } = payload;
        const peer = await this.deps.resolvePeer(channelId);
        this.deps.setChannelType(channelId, peer.chatType === 2);
        const elements = await parseContentToCanonical(content, this.deps.toCanonicalDeps());
        const { msgId } = await this.deps.msgApi.sendMessage(peer, elements);
        const message: Message = {
            id: msgId,
            channel: toChannelById(channelId, peer.chatType === 2),
        };
        // content 回显原始输入（发送成功即已按协议解析；规范化回显留待后续）
        message.content = content;
        return [message];
    }
}

/** message.get 参数。 */
const messageGetSchema = z.object({
    channel_id: z.string(),
    message_id: z.string(),
});

/** 获取单条消息。 */
export class MessageGetAction extends BaseSatoriAction<z.infer<typeof messageGetSchema>, Message> {
    readonly name = "message.get";
    readonly schema = messageGetSchema;
    private readonly deps: MessageActionDeps;

    constructor(deps: MessageActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof messageGetSchema>): Promise<Message> {
        const { channel_id: channelId, message_id: messageId } = payload;
        const peer = await this.deps.resolvePeer(channelId);
        const msgs = await this.deps.msgApi.fetchMsgsByMsgId(peer, [messageId]);
        const first = msgs[0];
        if (first === undefined) {
            throw new Error("消息不存在");
        }
        this.deps.setChannelType(channelId, peer.chatType === 2);
        return toSatoriMessage(first, {
            selfUin: this.deps.selfUin,
            uidToUin: (uids) => this.deps.uidToUin(uids),
        });
    }
}

/** message.list 参数。 */
const messageListSchema = z.object({
    channel_id: z.string(),
    /** 分页令牌（缺省从最新开始）。 */
    next: z.string().optional(),
    /** 查询方向（缺省 before）。 */
    direction: z.enum(["before", "after", "around"]).optional(),
    /** 消息数量限制（缺省平台默认，推荐 50）。 */
    limit: z.number().int().optional(),
    /** 排序（缺省 asc）。 */
    order: z.enum(["asc", "desc"]).optional(),
});

/** 获取消息列表（双向分页；第一版仅支持 before 方向）。 */
export class MessageListAction extends BaseSatoriAction<
    z.infer<typeof messageListSchema>,
    BidiList<Message>
> {
    readonly name = "message.list";
    readonly schema = messageListSchema;
    private readonly deps: MessageActionDeps;

    constructor(deps: MessageActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(
        payload: z.infer<typeof messageListSchema>,
    ): Promise<BidiList<Message>> {
        const { channel_id: channelId, next, direction, limit, order } = payload;
        if (direction === "around") {
            throw new Error("暂不支持 around 方向");
        }
        const peer = await this.deps.resolvePeer(channelId);
        const count = limit ?? DEFAULT_LIST_LIMIT;
        const raw = await this.deps.msgApi.fetchMessages(peer, {
            count,
            msgId: next ?? "",
        });
        this.deps.setChannelType(channelId, peer.chatType === 2);
        // QQ getMsgs 返回时间倒序（最新在前）；Satori 默认 asc（旧在前）
        const asc = order !== "desc";
        const ordered = asc ? [...raw].reverse() : raw;
        const messages: Message[] = [];
        for (const msg of ordered) {
            messages.push(
                await toSatoriMessage(msg, {
                    selfUin: this.deps.selfUin,
                    uidToUin: (uids) => this.deps.uidToUin(uids),
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
    }
}

/** message.delete 参数。 */
const messageDeleteSchema = z.object({
    channel_id: z.string(),
    message_id: z.string(),
});

/** 撤回消息。 */
export class MessageDeleteAction extends BaseSatoriAction<
    z.infer<typeof messageDeleteSchema>,
    void
> {
    readonly name = "message.delete";
    readonly schema = messageDeleteSchema;
    private readonly deps: MessageActionDeps;

    constructor(deps: MessageActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof messageDeleteSchema>): Promise<void> {
        const { channel_id: channelId, message_id: messageId } = payload;
        const peer = await this.deps.resolvePeer(channelId);
        await this.deps.msgApi.recallMessage(peer, [messageId]);
    }
}
