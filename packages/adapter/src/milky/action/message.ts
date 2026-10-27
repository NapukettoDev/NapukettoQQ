/**
 * Milky 消息类动作（P0）：send_private_message / send_group_message /
 * get_message / recall_private_message / recall_group_message
 *
 * 发送核心 sendMilkyMessage：OutgoingSegment → canonical（媒体 URI 异步落盘 +
 * at uin→uid + reply seq→msgId 原样兜底）→ MsgApi.sendMessage → 回查 msgSeq/time。
 * get/recall 入口是 message_seq（Milky ID 模型），经 seqIndex 反查 msgId。
 */
import type { CanonicalElement, Peer, RawMessage } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import { type ZodType, z } from "zod";
import type { MilkyApi } from "../api.js";
import { toGroupEntity, toGroupMemberEntity } from "../helper/entities.js";
import { resolveMediaUri } from "../helper/media-uri.js";
import { outgoingSegmentsToCanonical } from "../helper/segments.js";
import { type ReceiveTranslateContext, toMessageReceiveEvent } from "../helper/translate.js";
import type {
    GetMessageOutput,
    IncomingMessage,
    MessageScene,
    OutgoingSegment,
    SendMessageOutput,
} from "../types.js";
import type { MilkyErrorCodeMap } from "./base-action.js";
import { MilkyAction } from "./base-action.js";
import { milkyErrorCodeMap } from "./error-map.js";

/**
 * OutgoingSegment 宽松校验：入口只保证「{type, data}」形状，字段级转换在
 * outgoingSegmentsToCanonical 内做（未知段跳过 = 规范兼容性要求）。
 */
const outgoingSegmentSchema = z
    .object({ type: z.string(), data: z.record(z.string(), z.unknown()) })
    .loose() as unknown as ZodType<OutgoingSegment>;

const sendMessageFields = { message: z.array(outgoingSegmentSchema).min(1) } as const;
const recallFields = { message_seq: z.number().int().min(0) } as const;

/** send_private_message：发送私聊消息。 */
export class SendPrivateMessageAction extends MilkyAction<
    { user_id: number; message: OutgoingSegment[] },
    SendMessageOutput
> {
    readonly name = "send_private_message";
    readonly schema = z.object({ user_id: z.number().int().min(10001), ...sendMessageFields });
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

    protected async _handle(payload: {
        user_id: number;
        message: OutgoingSegment[];
    }): Promise<SendMessageOutput> {
        const peer = await this.api.resolvePeer("friend", payload.user_id);
        return await sendMilkyMessage(peer, payload.message, this.api);
    }
}

/** send_group_message：发送群聊消息。 */
export class SendGroupMessageAction extends MilkyAction<
    { group_id: number; message: OutgoingSegment[] },
    SendMessageOutput
> {
    readonly name = "send_group_message";
    readonly schema = z.object({ group_id: z.number().int().min(10001), ...sendMessageFields });
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

    protected async _handle(payload: {
        group_id: number;
        message: OutgoingSegment[];
    }): Promise<SendMessageOutput> {
        const peer = await this.api.resolvePeer("group", payload.group_id);
        return await sendMilkyMessage(peer, payload.message, this.api);
    }
}

/** get_message：获取单条消息（seq → msgId 反查 + 实体回填）。 */
export class GetMessageAction extends MilkyAction<
    { message_scene: MessageScene; peer_id: number; message_seq: number },
    GetMessageOutput
> {
    readonly name = "get_message";
    readonly schema = z.object({
        message_scene: z.enum(["friend", "group", "temp"]),
        peer_id: z.number().int().min(10001),
        message_seq: z.number().int().min(0),
    });
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

    protected async _handle(payload: {
        message_scene: MessageScene;
        peer_id: number;
        message_seq: number;
    }): Promise<GetMessageOutput> {
        const peer = await this.api.resolvePeer(payload.message_scene, payload.peer_id);
        const msgId = await this.api.resolveMsgIdBySeq(peer, payload.message_seq, peer.chatType);
        if (msgId === undefined) {
            throw kernelError(`消息 ${payload.message_seq} 不存在`, "NOT_FOUND");
        }
        const [msg] = await this.api.msgApi.fetchMsgsByMsgId(peer, [msgId]);
        if (msg === undefined) {
            throw kernelError(`消息 ${payload.message_seq} 不存在`, "NOT_FOUND");
        }
        return { message: await this.translateWithEntities(payload.message_scene, peer, msg) };
    }

    /** 实体回填（group 场景 schema 要求完整实体）→ IncomingMessage。 */
    private async translateWithEntities(
        scene: MessageScene,
        peer: Peer,
        msg: RawMessage,
    ): Promise<IncomingMessage> {
        const ctx: ReceiveTranslateContext = { selfUin: this.api.self.uin };
        if (scene === "group" && this.api.groupCache !== undefined) {
            const [detail, member] = await Promise.all([
                this.api.groupCache.getGroupDetail(peer.peerUid).catch(() => undefined),
                this.api.groupCache.getMember(peer.peerUid, msg.senderUid).catch(() => undefined),
            ]);
            ctx.groupEntity = toGroupEntity(detail, peer.peerUid);
            ctx.groupMemberEntity = toGroupMemberEntity(member, peer.peerUid, msg.senderUin);
        }
        return toMessageReceiveEvent(msg, ctx).data;
    }
}

/** recall_private_message：撤回私聊消息。 */
export class RecallPrivateMessageAction extends MilkyAction<
    { user_id: number; message_seq: number },
    Record<string, never>
> {
    readonly name = "recall_private_message";
    readonly schema = z.object({ user_id: z.number().int().min(10001), ...recallFields });
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

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
export class RecallGroupMessageAction extends MilkyAction<
    { group_id: number; message_seq: number },
    Record<string, never>
> {
    readonly name = "recall_group_message";
    readonly schema = z.object({ group_id: z.number().int().min(10001), ...recallFields });
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

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

/** 发送核心：segments → canonical（URI/ID 转换）→ sendMessage → 回查输出。 */
export async function sendMilkyMessage(
    peer: Peer,
    segments: OutgoingSegment[],
    api: MilkyApi,
): Promise<SendMessageOutput> {
    const { elements, atUins } = outgoingSegmentsToCanonical(segments);
    const resolved = await resolveElements(elements, atUins, api);
    if (resolved.length === 0) {
        throw kernelError("消息内容为空（全部消息段不可用）", "INVALID_PARAM");
    }
    const { msgId } = await api.msgApi.sendMessage(peer, resolved);
    return await api.resolveSentOutput(peer, msgId);
}

/** 元素二次解析：at uin→uid + 远程媒体 URI 落盘（reply seq 已在映射层兜底原样）。 */
async function resolveElements(
    elements: CanonicalElement[],
    atUins: string[],
    api: MilkyApi,
): Promise<CanonicalElement[]> {
    let uinToUid: Map<string, string> | undefined;
    if (atUins.length > 0) {
        try {
            uinToUid = await api.uinToUid(atUins);
        } catch {
            // 转换失败：at 原样（uin），交 QQ 端判断
        }
    }
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        if (el.type === "at" && el.target !== "all") {
            const uid = uinToUid?.get(el.target) ?? el.target;
            out.push({ ...el, target: uid });
            continue;
        }
        if (
            (el.type === "image" || el.type === "voice" || el.type === "video") &&
            isRemoteUri(el.path)
        ) {
            out.push({ ...el, path: await resolveMediaUri(el.path, api.mediaDir) });
            continue;
        }
        out.push(el);
    }
    return out;
}

/** 远程媒体 URI（需异步落盘才能进 kernel 发送预处理）。 */
function isRemoteUri(path: string): boolean {
    return (
        path.startsWith("http://") || path.startsWith("https://") || path.startsWith("base64://")
    );
}
