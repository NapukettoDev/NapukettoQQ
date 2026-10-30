/**
 * Milky 事件翻译（RawMessage → Milky 事件，纯函数，ADR-008）
 *
 * P0 事件两种：message_receive（onRecvMsg）/ message_recall（grayTip REVOKE）。
 * 实体与 reply 回填在广播路径异步取得后经 ctx 注入（翻译保持纯函数）；
 * 撤回事件的 sender_id 取 RawMessage.senderUin（grayTip 系统消息的 sender
 * 即被撤回原消息的发送者，口径待真实事件校准）。
 */
import {
    type CanonicalElement,
    ChatType,
    type RawMessage,
    toCanonicalElements,
} from "@napuketto/kernel";
import type {
    GroupEntity,
    GroupFileUploadData,
    GroupMemberEntity,
    IncomingMessage,
    IncomingSegment,
    MessageRecallData,
    MilkyEvent,
} from "../types.js";
import { toFriendEntity, toGroupEntity, toGroupMemberEntity } from "./entities.js";
import { canonicalToIncomingSegments, type ReceiveSegmentContext } from "./segments.js";

/** 毫秒 → 秒（Unix 时间戳）。 */
const MS_TO_SEC = 1000;

/** 接收事件翻译上下文。 */
export interface ReceiveTranslateContext extends ReceiveSegmentContext {
    /** 登录 uin（self_id）。 */
    selfUin: string;
    /** friend 场景：好友实体（广播路径 best-effort 构造；缺省最小实体）。 */
    friendEntity?: import("../types.js").FriendEntity;
    /** group 场景：群实体（缺省最小实体）。 */
    groupEntity?: GroupEntity;
    /** group 场景：群成员实体（缺省最小实体）。 */
    groupMemberEntity?: GroupMemberEntity;
    /**
     * 合并转发段（P1）：adapter 从 RawMessage 的 multiForwardMsgElement 提取
     * resId 后预构建（canonical 不承载 MULTI_FORWARD），追加到段尾。
     */
    forwardSegments?: IncomingSegment[];
}

/** chatType → message_scene。 */
export function chatTypeToScene(chatType: number): "friend" | "group" | "temp" {
    if (chatType === ChatType.GROUP) {
        return "group";
    }
    if (chatType === ChatType.C2C_TEMP) {
        return "temp";
    }
    return "friend";
}

/** peer_id：群聊 = 群号（peerUid）；好友/临时 = 对端 uin（peerUin，空退 peerUid）。 */
function peerIdOf(msg: RawMessage, scene: "friend" | "group" | "temp"): number {
    const raw = scene === "group" ? msg.peerUid : msg.peerUin !== "" ? msg.peerUin : msg.peerUid;
    return Number(raw);
}

/** RawMessage → message_receive 事件（实体缺省最小合法值，schema 形状完整）。 */
export function toMessageReceiveEvent(
    msg: RawMessage,
    ctx: ReceiveTranslateContext,
): MilkyEvent<IncomingMessage> {
    const elements: CanonicalElement[] = toCanonicalElements(msg);
    const segments = canonicalToIncomingSegments(elements, {
        ...(ctx.uidToUin !== undefined ? { uidToUin: ctx.uidToUin } : {}),
        ...(ctx.replyMeta !== undefined ? { replyMeta: ctx.replyMeta } : {}),
    });
    if (ctx.forwardSegments !== undefined) {
        segments.push(...ctx.forwardSegments);
    }
    const scene = chatTypeToScene(msg.chatType);
    const time = Math.floor(Number(msg.msgTime) / MS_TO_SEC);
    let data: IncomingMessage;
    if (scene === "group") {
        data = {
            message_scene: "group",
            peer_id: peerIdOf(msg, scene),
            message_seq: Number(msg.msgSeq),
            sender_id: Number(msg.senderUin),
            time,
            segments,
            group: ctx.groupEntity ?? toGroupEntity(undefined, msg.peerUid),
            group_member:
                ctx.groupMemberEntity ?? toGroupMemberEntity(undefined, msg.peerUid, msg.senderUin),
        };
    } else if (scene === "friend") {
        data = {
            message_scene: "friend",
            peer_id: peerIdOf(msg, scene),
            message_seq: Number(msg.msgSeq),
            sender_id: Number(msg.senderUin),
            time,
            segments,
            friend:
                ctx.friendEntity ??
                toFriendEntity(
                    undefined,
                    msg.peerUin !== "" ? msg.peerUin : msg.senderUin,
                    msg.peerName,
                ),
        };
    } else {
        data = {
            message_scene: "temp",
            peer_id: peerIdOf(msg, scene),
            message_seq: Number(msg.msgSeq),
            sender_id: Number(msg.senderUin),
            time,
            segments,
            group: ctx.groupEntity ?? null,
        };
    }
    return {
        time,
        self_id: Number(ctx.selfUin),
        event_type: "message_receive",
        data,
    };
}

/** 撤回 grayTip → message_recall 事件（非撤回 grayTip 返回 null）。 */
export function toMessageRecallEvent(
    msg: RawMessage,
    ctx: { selfUin: string; uidToUin?: Map<string, string> },
): MilkyEvent<MessageRecallData> | null {
    const gray = msg.elements.find((el) => el.grayTipElement !== undefined)?.grayTipElement;
    const revoke = gray?.revokeElement;
    if (revoke === undefined) {
        return null;
    }
    const scene = chatTypeToScene(msg.chatType);
    const operatorUin = ctx.uidToUin?.get(revoke.operatorUid) ?? revoke.operatorUid;
    return {
        time: Math.floor(Number(msg.msgTime) / MS_TO_SEC),
        self_id: Number(ctx.selfUin),
        event_type: "message_recall",
        data: {
            message_scene: scene,
            peer_id: peerIdOf(msg, scene),
            message_seq: Number(msg.msgSeq),
            sender_id: Number(msg.senderUin),
            operator_id: Number(operatorUin) || 0,
            display_suffix: revoke.wording ?? "",
        },
    };
}

/** 群文件上传事件（群场景文件消息 → group_file_upload，替代 message_receive）。 */
export function toGroupFileUploadEvent(
    msg: RawMessage,
    selfUin: string,
): MilkyEvent<GroupFileUploadData> | null {
    if (msg.chatType !== ChatType.GROUP) {
        return null;
    }
    const file = msg.elements.find((el) => el.fileElement !== undefined)?.fileElement;
    if (file === undefined) {
        return null;
    }
    return {
        time: Math.floor(Number(msg.msgTime) / MS_TO_SEC),
        self_id: Number(selfUin),
        event_type: "group_file_upload",
        data: {
            group_id: Number(msg.peerUid),
            user_id: Number(msg.senderUin) || 0,
            file_id: file.fileUuid ?? file.fileName ?? "",
            file_name: file.fileName ?? "",
            file_size: Number(file.fileSize ?? 0),
        },
    };
}
