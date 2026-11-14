/**
 * 消息转发域动作（2026-11-14 自 send-forward-msg / forward-single-msg /
 * get-forward-msg 合并）
 *
 * - send_group_forward_msg / send_private_forward_msg（P2-12）：messages 每项为
 *   node 元素 `{ type: "node", data: { id } }`——id 是此前 send_msg 返回的 OB11
 *   message_id。经 MessageUnique 反查源 msgId + peer，组装到目标 peer（群直通 /
 *   私聊 uinToUid）→ MsgApi.sendForwardMessage
 * - forward_group_single_msg / forward_friend_single_msg（P2-12）：message_id 反查
 *   源 msgId + peer；group_id/user_id 为目标 → MsgApi.forwardSingleMessage
 * - get_forward_msg（P2-12）：message_id / id → fetchForwardMessage（getMultiMsg）
 *   → 每条 toOb11MessageInfo → { messages }
 */

import { ChatType, kernelError, type Peer } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { toOb11MessageInfo } from "../../helper/index.js";
import { type MessageUnique, resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import type { OB11MessageInfo } from "../../types/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_FORWARD_NODES } from "../limits.js";
import { resolveUid } from "../resolve-uid.js";
import { resolveTargetPeer } from "./resolve-peer.js";

const forwardNodeSchema = z.object({
    type: z.literal("node").optional(),
    data: z
        .object({
            id: z.union([z.number(), z.string()]),
        })
        .optional(),
});

const sendGroupForwardMsgSchema = z.object({
    group_id: z.number(),
    // 上界见 action/limits.ts
    messages: z.array(z.unknown()).max(MAX_FORWARD_NODES).default([]),
});

type SendGroupForwardMsgPayload = z.infer<typeof sendGroupForwardMsgSchema>;

const sendPrivateForwardMsgSchema = z.object({
    user_id: z.number(),
    // 上界见 action/limits.ts
    messages: z.array(z.unknown()).max(MAX_FORWARD_NODES).default([]),
});

type SendPrivateForwardMsgPayload = z.infer<typeof sendPrivateForwardMsgSchema>;

/** 合并转发依赖（OneBotApi 视图，由装配方注入）。 */
export type ForwardMsgDeps = Pick<OneBotApi, "msgApi" | "messageUnique" | "uinToUid">;

/** 解析 node 元素列表 → 源消息 (msgId, peer) 列表（id 反查，跳过无法解析的项）。 */
function resolveSourceMessages(
    messages: unknown[],
    unique: MessageUnique,
): Array<{ msgId: string; peer: Peer }> {
    const out: Array<{ msgId: string; peer: Peer }> = [];
    for (const raw of messages) {
        const parsed = forwardNodeSchema.safeParse(raw);
        if (parsed.success) {
            const id = parsed.data.data?.id;
            if (id !== undefined) {
                const msgId = unique.getMsgId(Number(id));
                if (msgId !== undefined) {
                    const peer = unique.getPeer(msgId);
                    if (peer !== undefined) {
                        out.push({ msgId, peer });
                    }
                }
            }
        }
    }
    return out;
}

/** 合并转发发送（群/私聊共用：解析源消息 → 发送 → 映射 message_id）。 */
async function sendForward(
    messages: unknown[],
    target: Peer,
    deps: ForwardMsgDeps,
): Promise<{ message_id: number }> {
    const sources = resolveSourceMessages(messages, deps.messageUnique);
    const [firstSource] = sources;
    if (firstSource === undefined) {
        throw kernelError("合并转发需要至少一条可解析的源消息（node.id）", "INVALID_PARAM");
    }
    const { msgId } = await deps.msgApi.sendForwardMessage(
        target,
        firstSource.peer,
        sources.map((s) => s.msgId),
    );
    return { message_id: deps.messageUnique.alloc(msgId, target) };
}

/** 发送群合并转发（P2-12 接 kernel sendForwardMessage）。 */
export class SendGroupForwardMsgAction extends BaseAction<
    SendGroupForwardMsgPayload,
    { message_id: number }
> {
    readonly name = "send_group_forward_msg";
    readonly schema = sendGroupForwardMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: ForwardMsgDeps;

    constructor(deps: ForwardMsgDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: SendGroupForwardMsgPayload): Promise<{ message_id: number }> {
        const target: Peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
        return await sendForward(payload.messages, target, this.deps);
    }
}

/** 发送私聊合并转发（P2-12）。 */
export class SendPrivateForwardMsgAction extends BaseAction<
    SendPrivateForwardMsgPayload,
    { message_id: number }
> {
    readonly name = "send_private_forward_msg";
    readonly schema = sendPrivateForwardMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: ForwardMsgDeps;

    constructor(deps: ForwardMsgDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(
        payload: SendPrivateForwardMsgPayload,
    ): Promise<{ message_id: number }> {
        const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
        const target: Peer = { chatType: ChatType.C2C, peerUid: uid };
        return await sendForward(payload.messages, target, this.deps);
    }
}

const forwardSingleMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
    group_id: z.number().optional(),
    user_id: z.number().optional(),
});

type ForwardSingleMsgPayload = z.infer<typeof forwardSingleMsgSchema>;

/** 单条转发依赖（OneBotApi 视图，由装配方注入）。 */
type ForwardSingleMsgDeps = Pick<OneBotApi, "msgApi" | "messageUnique" | "uinToUid">;

/** 单条转发基类（两个动作共用实现）。 */
abstract class ForwardSingleMsgBase extends BaseAction<ForwardSingleMsgPayload, null> {
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: ForwardSingleMsgDeps;

    constructor(deps: ForwardSingleMsgDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: ForwardSingleMsgPayload): Promise<null> {
        const { msgId, peer: sourcePeer } = resolveMsgIdAndPeer(
            payload.message_id,
            this.deps.messageUnique,
        );
        const dstPeer = await resolveTargetPeer(
            payload,
            this.deps,
            "单条转发需要 group_id 或 user_id",
        );
        await this.deps.msgApi.forwardSingleMessage(sourcePeer, [msgId], dstPeer);
        return null;
    }
}

/** 转发单条消息到群（P2-12）。 */
export class ForwardGroupSingleMsgAction extends ForwardSingleMsgBase {
    readonly name = "forward_group_single_msg";
    readonly schema = forwardSingleMsgSchema;
}

/** 转发单条消息到好友（P2-12）。 */
export class ForwardFriendSingleMsgAction extends ForwardSingleMsgBase {
    readonly name = "forward_friend_single_msg";
    readonly schema = forwardSingleMsgSchema;
}

const getForwardMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]).optional(),
    id: z.union([z.number(), z.string()]).optional(),
});

type GetForwardMsgPayload = z.infer<typeof getForwardMsgSchema>;

/** 获取合并转发内容（P2-12 接 kernel fetchForwardMessage）。 */
export class GetForwardMsgAction extends BaseAction<
    GetForwardMsgPayload,
    { messages: OB11MessageInfo[] }
> {
    readonly name = "get_forward_msg";
    readonly schema = getForwardMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "msgApi" | "messageUnique">;

    constructor(deps: Pick<OneBotApi, "msgApi" | "messageUnique">) {
        super();
        this.deps = deps;
    }

    protected async _handle(
        payload: GetForwardMsgPayload,
    ): Promise<{ messages: OB11MessageInfo[] }> {
        const id = payload.message_id ?? payload.id;
        if (id === undefined) {
            throw kernelError("get_forward_msg 需要 message_id 或 id", "INVALID_PARAM");
        }
        const { msgId, peer } = resolveMsgIdAndPeer(id, this.deps.messageUnique);
        const msgs = await this.deps.msgApi.fetchForwardMessage(peer, msgId);
        return {
            messages: msgs.map((msg) => toOb11MessageInfo(msg, this.deps.messageUnique)),
        };
    }
}

/** 消息转发域动作工厂（合并转发 ×2 / 单条转发 ×2 / get_forward_msg）。 */
export function createForwardActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new SendGroupForwardMsgAction(api),
        new SendPrivateForwardMsgAction(api),
        new GetForwardMsgAction(api),
        new ForwardGroupSingleMsgAction(api),
        new ForwardFriendSingleMsgAction(api),
    ];
}
