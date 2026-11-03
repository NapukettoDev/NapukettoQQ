/**
 * send_group_forward_msg / send_private_forward_msg 动作：发送合并转发（P2-12）
 *
 * messages 每项为 node 元素 `{ type: "node", data: { id } }`——id 是此前
 * send_msg 返回的 OB11 message_id。经 MessageUnique 反查源 msgId + peer，
 * 组装到目标 peer（群直通 / 私聊 uinToUid）→ MsgApi.sendForwardMessage。
 */

import { ChatType, kernelError, type Peer } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import type { MessageUnique } from "../../helper/message-unique.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_FORWARD_NODES } from "../limits.js";
import { resolveUid } from "../resolve-uid.js";

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
