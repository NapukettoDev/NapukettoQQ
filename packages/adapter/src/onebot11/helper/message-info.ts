/**
 * OB11 消息信息翻译（RawMessage → OB11 消息信息结构）
 *
 * get_msg / get_group_msg_history / get_friend_msg_history 返回项用。
 * 纯函数（ADR-008）：只读入参，不调 API、不读缓存。
 * 与 adapter.ts 的 toOb11MessageEvent（事件格式，带 self_id/post_type）是两套结构，不复用。
 */
import type { RawMessage } from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { OB11MessageInfo } from "../types/index.js";
import {
    applyReceiveContext,
    canonicalToCqMessage,
    canonicalToSegments,
    type ReceiveTranslateContext,
} from "./data.js";
import type { MessageUnique } from "./message-unique.js";

/** 毫秒 → 秒（Unix 时间戳）。 */
const MS_TO_SEC = 1000;

/** RawMessage → OB11 消息信息（message_id 经 MessageUnique 映射）。
 * ctx（可选）：接收方向 ID 转换上下文（at uid→uin、reply NT msgId→OB11 id，P2-19）。 */
export function toOb11MessageInfo(
    msg: RawMessage,
    unique: MessageUnique,
    ctx: ReceiveTranslateContext = {},
): OB11MessageInfo {
    const elements = applyReceiveContext(toCanonicalElements(msg), ctx);
    let messageType: "group" | "private" = "private";
    if (msg.chatType === ChatType.GROUP) {
        messageType = "group";
    }
    const info: OB11MessageInfo = {
        message_id: unique.alloc(msg.msgId, {
            chatType: msg.chatType,
            peerUid: msg.peerUid,
        }),
        message_type: messageType,
        sender: {
            user_id: Number(msg.senderUin),
            nickname: msg.sendNickName,
        },
        time: Math.floor(Number(msg.msgTime) / MS_TO_SEC),
        message: canonicalToSegments(elements),
        raw_message: canonicalToCqMessage(elements),
    };
    if (msg.chatType === ChatType.GROUP) {
        info.group_id = Number(msg.peerUid);
        const { sender } = info;
        // 发送者角色由调用方经 ctx 注入（GroupCache 查询在协议边界，翻译纯函数）
        sender.role = ctx.senderRole ?? "member";
        if (msg.sendMemberName !== undefined) {
            sender.card = msg.sendMemberName;
        }
    } else {
        // 2026-08-07 修复：user_id 应为发送者（senderUin），与消息事件一致。
        // 此前用 peerUin（会话对端）——机器人自己发的消息 user_id 会错成对端。
        info.user_id = Number(msg.senderUin);
    }
    return info;
}
