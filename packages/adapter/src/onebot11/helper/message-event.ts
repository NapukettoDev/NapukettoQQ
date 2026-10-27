/**
 * OB11 消息事件翻译（RawMessage → OB11 消息事件，纯函数，ADR-008）
 *
 * 与 message-info.ts 的 toOb11MessageInfo（get_msg/历史消息返回结构）是两套格式：
 * 事件带 self_id/post_type/message_id；信息结构用于动作返回。
 */
import type { RawMessage } from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type {
    OB11GroupMessageEvent,
    OB11MessageEvent,
    OB11PrivateMessageEvent,
} from "../event/index.js";
import type { GroupSender } from "../event/message.js";
import type { Sender } from "../types/index.js";
import {
    applyReceiveContext,
    canonicalToCqMessage,
    canonicalToSegments,
    type ReceiveTranslateContext,
} from "./data.js";
import type { MessageUnique } from "./message-unique.js";

/** 毫秒 → 秒（Unix 时间戳）。 */
const MS_TO_SEC = 1000;

/** RawMessage → OB11 消息事件（message_id 经 MessageUnique 映射并记录 peer）。
 * messageFormat 决定 message 字段格式：array = 消息段数组（标准），string = CQ 码字符串。
 * ctx（可选）：接收方向 ID 转换上下文（at uid→uin、reply NT msgId→OB11 id，P2-19）。 */
export function toOb11MessageEvent(
    msg: RawMessage,
    selfUin: string,
    unique: MessageUnique,
    messageFormat: "array" | "string" = "array",
    ctx: ReceiveTranslateContext = {},
): OB11MessageEvent {
    const elements = applyReceiveContext(toCanonicalElements(msg), ctx);
    const segments = canonicalToSegments(elements);
    const time = Math.floor(Number(msg.msgTime) / MS_TO_SEC);
    const selfId = Number(selfUin);
    const userId = Number(msg.senderUin);
    // 记录 peer：delete_msg / get_msg 等只有 message_id 的动作可反查
    const messageId = unique.alloc(msg.msgId, {
        chatType: msg.chatType,
        peerUid: msg.peerUid,
    });
    const base = {
        time,
        self_id: selfId,
        post_type: "message" as const,
        message_id: messageId,
        message: messageFormat === "string" ? canonicalToCqMessage(elements) : segments,
        raw_message: canonicalToCqMessage(elements),
        font: 0,
    };

    if (msg.chatType === ChatType.GROUP) {
        const sender: GroupSender = {
            user_id: userId,
            nickname: msg.sendNickName,
            // 发送者角色由调用方经 ctx 注入（GroupCache 查询在协议边界，翻译纯函数）
            role: ctx.senderRole ?? "member",
        };
        if (msg.sendMemberName !== undefined) {
            sender.card = msg.sendMemberName;
        }
        const event: OB11GroupMessageEvent = {
            ...base,
            message_type: "group",
            sub_type: "normal",
            group_id: Number(msg.peerUid),
            user_id: userId,
            sender,
        };
        return event;
    }

    // 私聊：C2C=好友，临时会话（群内私聊）sub_type=group
    let subType: "friend" | "group" = "friend";
    if (msg.chatType === ChatType.C2C_TEMP) {
        subType = "group";
    }
    const sender: Sender = {
        user_id: userId,
        nickname: msg.sendNickName,
    };
    const event: OB11PrivateMessageEvent = {
        ...base,
        message_type: "private",
        sub_type: subType,
        user_id: userId,
        sender,
    };
    return event;
}
