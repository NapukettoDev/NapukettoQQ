/**
 * Milky notice 事件翻译（grayTip 系，P1 2026-10-30）
 *
 * NT QQ 中群成员变动/禁言/戳一戳等系统事件通过消息的灰色提示元素（grayTip）
 * 广播。本模块把 RawMessage 里的 grayTip 翻译为 Milky notice 事件（纯函数，
 * ADR-008），判据与 OB11 helper/notice.ts 同源（同一 wrapper 事实）：
 *  - group_member_increase / group_member_decrease（subType=GROUP + type MEMBER_ADD/QUIT）
 *  - group_mute / group_whole_mute（SHUT_UP；member uid 空 = 全员禁言口径）
 *  - group_nudge / friend_nudge（aioOpGrayTipElement；形状待真实事件校准，
 *    best-effort + raw 校准日志，与 OB11 poke 同口径）
 *  - group_name_change / group_disband（GROUP_NAME_MODIFIED / DISBANDED；操作者
 *    uid 不可得时不产出事件，避免违反 schema operator_id 下限）
 *
 * user_id / operator_id 都是 uin：接收 uidToUin Map（调用方批量转换后传入）。
 * 未知/未翻译的 grayTip 子类型打 raw JSON 日志（为后续真实事件校准积累数据）。
 */
import type { RawMessage } from "@napuketto/kernel";
import {
    ChatType,
    type GrayTipElement,
    GrayTipSubType,
    type TipGroupElement,
    TipGroupElementType,
} from "@napuketto/kernel";
import { firstUntranslatedGrayTip } from "../../core/gray-tip.js";
import { resolveUin } from "../../core/uid-uin.js";
import type {
    FriendNudgeData,
    GroupDisbandData,
    GroupMemberDecreaseData,
    GroupMemberIncreaseData,
    GroupMuteData,
    GroupNameChangeData,
    GroupNudgeData,
    GroupWholeMuteData,
    MilkyEvent,
} from "../types.js";

/** 毫秒 → 秒（Unix 时间戳）。 */
const MS_TO_SEC = 1000;

/** grayTip 翻译上下文（uid→uin 映射，调用方批量转换）。 */
export interface NoticeTranslateContext {
    selfUin: string;
    uidToUin: Map<string, string>;
    /** 校准日志（可选：未知子类型 / aioOp raw JSON；缺省静默）。 */
    logger?: { warn(obj: unknown, msg?: string): void };
}

/** uid → uin（core 共享解析；ctx 携带映射）。 */
function toUin(uid: string | undefined, ctx: NoticeTranslateContext): number {
    return resolveUin(uid, ctx.uidToUin);
}

/** 事件信封公共字段。 */
function envelope<T>(
    msg: RawMessage,
    ctx: NoticeTranslateContext,
    eventType: string,
    data: T,
): MilkyEvent<T> {
    return {
        time: Math.floor(Number(msg.msgTime) / MS_TO_SEC),
        self_id: Number(ctx.selfUin),
        event_type: eventType,
        data,
    };
}

/** 单个 grayTip → Milky notice 事件（null = 不可翻译）。 */
function translateGrayTip(
    msg: RawMessage,
    g: GrayTipElement,
    ctx: NoticeTranslateContext,
): MilkyEvent | null {
    // aioOp 优先于子类型判定：群戳一戳载荷挂 GROUP 子类型（归属未实证，
    // 与 OB11 poke 同口径——按元素存在性识别）
    if (g.aioOpGrayTipElement !== undefined) {
        return aioOpToEvent(msg, g, ctx);
    }
    if (g.subElementType === GrayTipSubType.GROUP) {
        return groupElementToEvent(msg, g.groupElement, ctx);
    }
    return null;
}

/** TipGroupElement → 群成员变动 / 禁言 / 改名 / 解散事件（按类型分发的映射表键）。 */
interface GroupChangeCommon {
    groupId: number;
    memberUid: string;
    adminUid: string;
}

/** 群成员变动类映射器表（键 = TipGroupElementType；缺项 = 不可翻译返回 null）。 */
const GROUP_CHANGE_MAPPERS: Partial<
    Record<
        TipGroupElementType,
        (
            msg: RawMessage,
            common: GroupChangeCommon,
            grp: TipGroupElement,
            ctx: NoticeTranslateContext,
        ) => MilkyEvent | null
    >
> = {
    [TipGroupElementType.MEMBER_ADD]: toMemberIncrease,
    [TipGroupElementType.QUIT]: toMemberDecrease,
    [TipGroupElementType.SHUT_UP]: toShutUpEvent,
    [TipGroupElementType.GROUP_NAME_MODIFIED]: toNameChange,
    [TipGroupElementType.DISBANDED]: toDisband,
};

function groupElementToEvent(
    msg: RawMessage,
    grp: TipGroupElement | undefined,
    ctx: NoticeTranslateContext,
): MilkyEvent | null {
    if (grp === undefined || grp.type === undefined) {
        return null;
    }
    const mapper = GROUP_CHANGE_MAPPERS[grp.type];
    if (mapper === undefined) {
        return null;
    }
    return mapper(msg, groupChangeCommon(grp, Number(msg.peerUid)), grp, ctx);
}

/** 禁言载荷优先（shutUp.member/admin 覆盖顶层 memberUid/adminUid）。 */
function groupChangeCommon(grp: TipGroupElement, groupId: number): GroupChangeCommon {
    return {
        groupId,
        memberUid: grp.shutUp?.member?.uid ?? grp.memberUid ?? "",
        adminUid: grp.shutUp?.admin?.uid ?? grp.adminUid ?? "",
    };
}

/** 群成员增加（管理员同意 → operator_id；邀请入群 → invitor_id）。 */
function toMemberIncrease(
    msg: RawMessage,
    common: GroupChangeCommon,
    _grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): MilkyEvent {
    const { groupId, memberUid, adminUid } = common;
    const data: GroupMemberIncreaseData = {
        group_id: groupId,
        user_id: toUin(memberUid, ctx),
        operator_id: adminUid !== "" && adminUid === memberUid ? toUin(adminUid, ctx) : null,
        invitor_id: adminUid !== "" && adminUid !== memberUid ? toUin(adminUid, ctx) : null,
    };
    return envelope(msg, ctx, "group_member_increase", data);
}

/** 群成员减少（操作者与本人不同 = 被踢；主动退群无操作者）。 */
function toMemberDecrease(
    msg: RawMessage,
    common: GroupChangeCommon,
    _grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): MilkyEvent {
    const { groupId, memberUid, adminUid } = common;
    const data: GroupMemberDecreaseData = {
        group_id: groupId,
        user_id: toUin(memberUid, ctx),
        operator_id: adminUid !== "" && adminUid !== memberUid ? toUin(adminUid, ctx) : null,
    };
    return envelope(msg, ctx, "group_member_decrease", data);
}

/** 禁言（member 空 = 全员禁言口径；is_mute = 是否处于禁言态）。 */
function toShutUpEvent(
    msg: RawMessage,
    common: GroupChangeCommon,
    grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): MilkyEvent {
    const { groupId, memberUid, adminUid } = common;
    const duration = Number(grp.shutUp?.duration ?? 0);
    if (memberUid === "") {
        const data: GroupWholeMuteData = {
            group_id: groupId,
            operator_id: toUin(adminUid, ctx),
            is_mute: duration > 0,
        };
        return envelope(msg, ctx, "group_whole_mute", data);
    }
    const data: GroupMuteData = {
        group_id: groupId,
        user_id: toUin(memberUid, ctx),
        operator_id: toUin(adminUid, ctx),
        duration,
    };
    return envelope(msg, ctx, "group_mute", data);
}

/** 改名 / 解散公共守卫：操作者 uid 不可得时不产出（schema operator_id 下限）。 */
function operatorOf(common: GroupChangeCommon): string {
    return common.adminUid !== "" ? common.adminUid : common.memberUid;
}

function toNameChange(
    msg: RawMessage,
    common: GroupChangeCommon,
    grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): MilkyEvent | null {
    const operatorUid = operatorOf(common);
    if (operatorUid === "") {
        return null;
    }
    const data: GroupNameChangeData = {
        group_id: common.groupId,
        new_group_name: grp.groupName ?? "",
        operator_id: toUin(operatorUid, ctx),
    };
    return envelope(msg, ctx, "group_name_change", data);
}

function toDisband(
    msg: RawMessage,
    common: GroupChangeCommon,
    _grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): MilkyEvent | null {
    const operatorUid = operatorOf(common);
    if (operatorUid === "") {
        return null;
    }
    const data: GroupDisbandData = {
        group_id: common.groupId,
        operator_id: toUin(operatorUid, ctx),
    };
    return envelope(msg, ctx, "group_disband", data);
}

/**
 * aioOp → 戳一戳事件（friend_nudge / group_nudge）。
 * aioOp 载荷完整字段形状未经实测（已证字段仅 operateType/peerUid）：
 * sender 取消息发送者、receiver 取 aioOp.peerUid（口径与 OB11 poke 一致，待校准）；
 * display_* 字段无来源，恒空串；始终打 raw 日志积累校准数据。
 */
function aioOpToEvent(msg: RawMessage, g: GrayTipElement, ctx: NoticeTranslateContext): MilkyEvent {
    const aioOp = g.aioOpGrayTipElement;
    ctx.logger?.warn(
        { raw: JSON.stringify(g)?.slice(0, 2000) },
        "milky: aioOp grayTip raw（戳一戳待真实事件校准）",
    );
    if (msg.chatType === ChatType.GROUP) {
        const data: GroupNudgeData = {
            group_id: Number(msg.peerUid),
            sender_id: toUin(msg.senderUid, ctx),
            receiver_id: toUin(aioOp?.peerUid ?? "", ctx),
            display_action: "",
            display_suffix: "",
            display_action_img_url: "",
        };
        return envelope(msg, ctx, "group_nudge", data);
    }
    const senderUin = toUin(msg.senderUid, ctx);
    const data: FriendNudgeData = {
        user_id: senderUin,
        is_self_send: senderUin === Number(ctx.selfUin),
        is_self_receive: senderUin !== Number(ctx.selfUin),
        display_action: "",
        display_suffix: "",
        display_action_img_url: "",
    };
    return envelope(msg, ctx, "friend_nudge", data);
}

/**
 * RawMessage → Milky notice 事件（无 grayTip / 不可翻译返回 null）。
 * 未知子类型打 raw JSON 日志（JSON/BUDDY/ESSENCE/FILE 等——校准数据积累入口）。
 */
export function toMilkyNoticeEvent(
    msg: RawMessage,
    ctx: NoticeTranslateContext,
): MilkyEvent | null {
    for (const el of msg.elements) {
        const g = el.grayTipElement;
        if (g === undefined) {
            continue;
        }
        const event = translateGrayTip(msg, g, ctx);
        if (event !== null) {
            return event;
        }
    }
    const untranslated = firstUntranslatedGrayTip(msg);
    if (untranslated !== undefined) {
        ctx.logger?.warn(
            {
                subType: untranslated.subElementType,
                raw: JSON.stringify(untranslated)?.slice(0, 2000),
            },
            "milky: 未翻译的 grayTip 子类型（raw 校准数据）",
        );
    }
    return null;
}
