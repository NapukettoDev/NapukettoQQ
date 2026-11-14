/**
 * Satori 资源翻译（RawMessage → Satori Message / 频道 / 群组，纯函数 + 注入转换）
 *
 * 收方向 ID 空间：canonical at.target 是 uid，Satori 规范是 uin——经
 * uidToUin 批量转换（依赖注入，与 OB11 的 ReceiveTranslateContext 同思路）。
 */
import { ChatType, type RawMessage, toCanonicalElements } from "@napuketto/kernel";
import { toUnixSeconds } from "../../shared/raw-message.js";
import { MS_TO_SEC } from "../../shared/uid-uin.js";
import type { Channel, Message } from "../types/resource.js";
import { canonicalToSatoriElements } from "./element/canonical.js";
import { renderElements } from "./element/element.js";
import { toDirectChannel, toGroupChannel, toGuild, toUser } from "./ids.js";

/** 收方向翻译依赖（uid → uin 转换，缺省 at 原样 uid）。 */
export interface SatoriTranslateDeps {
    /** 机器人自身 uin（频道类型判定 / 私聊对端兜底）。 */
    selfUin: string;
    /** uid → uin（at 目标 / 用户 ID；缺省不转换）。 */
    uidToUin?: (uids: string[]) => Promise<Map<string, string>>;
}

/** RawMessage → Satori Message（资源提升：message 不嵌套 user/member/channel）。 */
export async function toSatoriMessage(
    raw: RawMessage,
    deps: SatoriTranslateDeps,
): Promise<Message> {
    const elementDeps: { uidToUin?: (uids: string[]) => Promise<Map<string, string>> } = {};
    if (deps.uidToUin !== undefined) {
        elementDeps.uidToUin = deps.uidToUin;
    }
    const elements = await canonicalToSatoriElements(toCanonicalElements(raw), elementDeps);
    const content = renderElements(elements);
    const isGroup = raw.chatType === ChatType.GROUP;
    const peerUin = String(raw.peerUin ?? "");
    const senderUin = String(raw.senderUin ?? "");
    const nickname = raw.sendNickName ?? "";
    const memberName = raw.sendMemberName ?? "";

    const message: Message = { id: raw.msgId };
    if (content !== "") {
        message.content = content;
    }
    if (isGroup) {
        message.guild = toGuild(peerUin, raw.peerName);
        message.channel = toGroupChannel(peerUin, raw.peerName);
        message.user = toUser(senderUin, nickname);
        message.member = { user: message.user };
        if (memberName !== "" && memberName !== nickname) {
            message.member.nick = memberName;
        }
    } else {
        const peerId = senderUin !== "" ? senderUin : peerUin;
        message.channel = toDirectChannel(peerId, nickname);
        message.user = toUser(peerId, nickname);
    }
    // Satori 规范 created_at 为毫秒级时间戳；msgTime 单位随平台不一致，
    // 先归一成 Unix 秒再换算毫秒（Windows 毫秒 / Linux 秒）
    const created = toUnixSeconds(raw.msgTime) * MS_TO_SEC;
    if (created > 0) {
        message.created_at = created;
    }
    return message;
}

/** 按频道 id 构造频道（isGroup 由调用方从事件/缓存得知）。 */
export function toChannelById(channelId: string, isGroup: boolean, name?: string): Channel {
    if (isGroup) {
        return toGroupChannel(channelId, name);
    }
    return toDirectChannel(channelId, name);
}
