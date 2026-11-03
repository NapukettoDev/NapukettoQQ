/**
 * send_private_msg 动作：发送私聊消息（复用 sendOb11Message 核心）
 */

import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_MESSAGE_SEGMENTS } from "../limits.js";
import type { SendMsgDeps } from "./send-msg.js";
import { sendOb11Message } from "./send-msg.js";

const sendPrivateMsgSchema = z.object({
    user_id: z.number(),
    // 上界见 action/limits.ts
    message: z.union([z.string(), z.array(z.unknown()).max(MAX_MESSAGE_SEGMENTS)]),
    auto_escape: z.boolean().optional(),
});

type SendPrivateMsgPayload = z.infer<typeof sendPrivateMsgSchema>;

/** 发送私聊消息（P2-10 复用 sendOb11Message）。 */
export class SendPrivateMsgAction extends BaseAction<
    SendPrivateMsgPayload,
    { message_id: number }
> {
    readonly name = "send_private_msg";
    readonly schema = sendPrivateMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SendMsgDeps;

    constructor(deps: SendMsgDeps) {
        super();
        this.deps = deps;
    }

    protected _handle(payload: SendPrivateMsgPayload): Promise<{ message_id: number }> {
        return sendOb11Message(payload, this.deps);
    }
}
