/**
 * Satori 事件翻译（kernel RawMessage → Satori Event 内容，纯函数 + 注入转换）
 *
 * 第一版支持：
 *  - message-created：普通消息（Msg/onRecvMsg）
 *  - message-deleted：grayTip REVOKE（撤回）
 *  - guild-member-added / guild-member-removed：grayTip GROUP（TipGroupElement）
 * （friend-request / guild-request 事件留待后续：grayTip 的 jsonGrayTipElement
 *  结构待运行时探测，OB11 走主动查询 get_group_system_msg 不广播。）
 *
 * 收方向 ID 空间：uid → uin 批量转换（deps.uidToUin，与消息翻译同依赖）。
 */
import { ChatType, GrayTipSubType, type RawMessage, TipGroupElementType } from "@napuketto/kernel";
import { collectGrayTipUids } from "../../shared/gray-tip.js";
import { toUinString } from "../../shared/uid-uin.js";
import { type SatoriTranslateDeps, toSatoriMessage, toUser } from "../helper/index.js";
import type { Channel, Guild, GuildMember, Message, User } from "../types/resource.js";

/** 事件内容（不含 sn/login，由 adapter 包一层完整 Event）。 */
export interface SatoriEventContent {
    type: string;
    timestamp: number;
    channel?: Channel;
    guild?: Guild;
    message?: Message;
    user?: User;
    member?: GuildMember;
    operator?: User;
}

/** 事件翻译依赖（selfUin + uidToUin）。 */
export interface SatoriEventDeps extends SatoriTranslateDeps {}

/** 普通消息 → message-created 事件。 */
export async function toSatoriMessageEvent(
    raw: RawMessage,
    deps: SatoriEventDeps,
): Promise<SatoriEventContent> {
    const message = await toSatoriMessage(raw, deps);
    const content: SatoriEventContent = {
        type: "message-created",
        timestamp: Number(raw.msgTime),
    };
    if (message.channel !== undefined) {
        content.channel = message.channel;
    }
    if (message.guild !== undefined) {
        content.guild = message.guild;
    }
    if (message.user !== undefined) {
        content.user = message.user;
    }
    if (message.member !== undefined) {
        content.member = message.member;
    }
    content.message = message;
    return content;
}

/** 检查消息是否含可翻译的 grayTip（撤回 / 群成员变动）。 */
export function hasSatoriGrayTip(raw: RawMessage): boolean {
    for (const el of raw.elements) {
        const g = el.grayTipElement;
        if (g == null) {
            continue;
        }
        if (
            g.subElementType === GrayTipSubType.REVOKE ||
            g.subElementType === GrayTipSubType.GROUP
        ) {
            return true;
        }
    }
    return false;
}

/** 收集 grayTip 涉及的 uid（批量 uidToUin 用，core 共享实现）。 */
export const collectSatoriGrayTipUids = collectGrayTipUids;

/** 判断消息是否为群聊 grayTip（peerUid 是群号）。 */
function isGroupMessage(raw: RawMessage): boolean {
    return raw.chatType === ChatType.GROUP;
}

/** grayTip → 事件（撤回 / 群成员变动；无匹配返回 null）。 */
export async function toSatoriGrayTipEvent(
    raw: RawMessage,
    uidToUinMap: Map<string, string>,
): Promise<SatoriEventContent | null> {
    for (const el of raw.elements) {
        const g = el.grayTipElement;
        if (g == null) {
            continue;
        }
        if (g.subElementType === GrayTipSubType.REVOKE) {
            const revoked = toRevokeEvent(raw, uidToUinMap);
            if (revoked !== null) {
                return revoked;
            }
        }
        if (g.subElementType === GrayTipSubType.GROUP && isGroupMessage(raw)) {
            const member = toMemberChangeEvent(raw, uidToUinMap);
            if (member !== null) {
                return member;
            }
        }
    }
    return null;
}

/** 撤回 → message-deleted 事件。 */
function toRevokeEvent(
    raw: RawMessage,
    uidToUinMap: Map<string, string>,
): SatoriEventContent | null {
    for (const el of raw.elements) {
        const revoke = el.grayTipElement?.revokeElement;
        if (revoke === undefined) {
            continue;
        }
        const operatorUin = toUinString(revoke.operatorUid, uidToUinMap);
        const peerUin = String(raw.peerUin ?? "");
        const content: SatoriEventContent = {
            type: "message-deleted",
            timestamp: Number(raw.msgTime),
        };
        content.channel = {
            id: peerUin,
            type: isGroupMessage(raw) ? 0 : 1,
        };
        if (isGroupMessage(raw)) {
            content.guild = { id: peerUin, name: raw.peerName };
        }
        // 撤回消息的 id：NT 侧仅 grayTip 的 msgSeq 可用（对齐 OB11 message_id 语义）
        content.message = { id: raw.msgSeq };
        content.operator = toUser(operatorUin, revoke.operatorNick);
        return content;
    }
    return null;
}

/** 群成员变动 → guild-member-added / guild-member-removed 事件。 */
function toMemberChangeEvent(
    raw: RawMessage,
    uidToUinMap: Map<string, string>,
): SatoriEventContent | null {
    for (const el of raw.elements) {
        const grp = el.grayTipElement?.groupElement;
        if (grp === undefined || grp.type === undefined) {
            continue;
        }
        const type = memberChangeType(grp.type);
        if (type === null) {
            return null;
        }
        const memberUid = grp.memberUid ?? "";
        const adminUid = grp.adminUid ?? "";
        const peerUin = String(raw.peerUin ?? "");
        const content: SatoriEventContent = {
            type,
            timestamp: Number(raw.msgTime),
            guild: toGroupGuild(peerUin, raw.peerName),
            channel: { id: peerUin, type: 0 },
            member: toMember(memberUid, grp.memberNick, grp.memberRemark, uidToUinMap),
            user: toUser(toUinString(memberUid, uidToUinMap), grp.memberNick),
        };
        if (adminUid !== "" && adminUid !== memberUid) {
            content.operator = toUser(toUinString(adminUid, uidToUinMap), grp.adminNick);
        }
        return content;
    }
    return null;
}

/** 成员变动类型（MEMBER_ADD=added / QUIT=removed；其余 null）。 */
function memberChangeType(
    type: TipGroupElementType,
): "guild-member-added" | "guild-member-removed" | null {
    if (type === TipGroupElementType.MEMBER_ADD) {
        return "guild-member-added";
    }
    if (type === TipGroupElementType.QUIT) {
        return "guild-member-removed";
    }
    return null;
}

/** 构造群组（带可选群名）。 */
function toGroupGuild(id: string, name: string | undefined): Guild {
    const guild: Guild = { id };
    if (name !== undefined && name !== "") {
        guild.name = name;
    }
    return guild;
}

/** 构造群成员（user + 可选备注 nick）。 */
function toMember(
    uid: string,
    nick: string | undefined,
    remark: string | undefined,
    uidToUinMap: Map<string, string>,
): GuildMember {
    const member: GuildMember = { user: toUser(toUinString(uid, uidToUinMap), nick) };
    if (remark !== undefined && remark !== "" && remark !== nick) {
        member.nick = remark;
    }
    return member;
}
