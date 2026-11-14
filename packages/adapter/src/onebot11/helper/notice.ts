/**
 * OB11 notice 事件翻译（ 补全）
 *
 * NT QQ 中群成员变动/撤回等系统事件通过**消息的灰色提示元素（grayTip）**广播。
 * 本模块把 RawMessage 里的 grayTip 翻译为 OB11 notice 事件（纯函数）。
 *
 * 支持：
 *  - group_recall（群撤回，grayTip.subElementType=REVOKE + chatType=GROUP）
 * - friend_recall（好友撤回，REVOKE + chatType=C2C）
 *  - group_increase / group_decrease（群成员变动，subElementType=GROUP + TipGroupElement.type）
 *  - group_admin（管理员变更，TipGroupElement.type=BLOCK/UNBLOCK 的 role 语义）
 *  - group_ban（禁言，TipGroupElement.type=SHUT_UP）
 * - notify.poke（戳一戳，aioOpGrayTipElement；⚠️ 待真实 poke 事件验证）
 *
 * 未知/未翻译的 grayTip 子类型（JSON/BUDDY/ESSENCE/GROUP_NOTIFY 等）打 raw JSON
 * 日志（ctx.logger 可选）——为后续真实事件校准积累数据。
 *
 * user_id/operator_id 都是 uin：接收 uidToUin Map（调用方批量转换后传入，保持纯函数）。
 */

import type { BuddyListEntry } from "@napuketto/kernel";
import {
    ChatType,
    type GrayTipElement,
    GrayTipSubType,
    type RawMessage,
    type TipGroupElement,
    TipGroupElementType,
} from "@napuketto/kernel";
import { toUnixSeconds } from "../../shared/raw-message.js";
import { MS_TO_SEC, toUin } from "../../shared/uid-uin.js";

export { collectGrayTipUids, hasGrayTip } from "../../shared/gray-tip.js";

import { firstUntranslatedGrayTip } from "../../shared/gray-tip.js";

import type {
    OB11Event,
    OB11FriendAddNoticeEvent,
    OB11FriendRecallNoticeEvent,
    OB11GroupAdminNoticeEvent,
    OB11GroupBanNoticeEvent,
    OB11GroupDecreaseNoticeEvent,
    OB11GroupIncreaseNoticeEvent,
    OB11GroupRecallNoticeEvent,
    OB11GroupUploadNoticeEvent,
    OB11NotifyNoticeEvent,
} from "../event/index.js";

/** 群文件业务类型（group_upload 的 file.busid,与 kernel 群文件系列同源语义）。 */
const GROUP_FILE_BUS_ID = 102;

/**
 * 检查消息是否含文件元素（group_upload 开关分支判定）。
 *
 * ⚠️ 用空值判定（`!= null`）而非 `!== undefined`（Linux 原生宿主）：
 * Windows 原生对象省略未命中的元素变体字段，Linux 3.2.x 原生对象则把**全部**
 * 变体字段显式置 `null`（`"grayTipElement":null` 等）。用 `!== undefined`
 * 会把每条普通消息都判成「含该元素」——OB11 入站消息因此全部被误路由到
 * grayTip notice 分支并静默丢弃（真机复现）。
 */
export function hasFileElement(msg: RawMessage): boolean {
    return msg.elements.some((el) => el.fileElement != null);
}

/** grayTip 翻译上下文（uid→uin 映射，调用方批量转换）。 */
export interface NoticeTranslateContext {
    selfUin: string;
    uidToUin: Map<string, string>;
    /** 校准日志（可选：未知 grayTip 子类型/poke raw JSON；缺省静默）。 */
    logger?: { warn(obj: unknown, msg?: string): void };
}

/** 基础字段（time/self_id/post_type）。 */
function base(
    msg: RawMessage,
    ctx: NoticeTranslateContext,
): {
    time: number;
    self_id: number;
    post_type: "notice";
    group_id: number;
} {
    return {
        time: toUnixSeconds(msg.msgTime),
        self_id: Number(ctx.selfUin),
        post_type: "notice",
        group_id: Number(msg.peerUid),
    };
}

/** 撤回事件（chatType 分流：GROUP→group_recall / C2C→friend_recall）。 */
function toRecall(
    msg: RawMessage,
    g: GrayTipElement,
    ctx: NoticeTranslateContext,
): OB11GroupRecallNoticeEvent | OB11FriendRecallNoticeEvent | null {
    // Linux 原生对象把未命中的变体字段显式置 null（== null 判据，见 design 不变量）
    if (g?.revokeElement == null) {
        return null;
    }
    const revoke = g.revokeElement;
    if (msg.chatType === ChatType.C2C) {
        // 好友撤回：user_id = 撤回者，message_id = msgSeq
        return {
            time: toUnixSeconds(msg.msgTime),
            self_id: Number(ctx.selfUin),
            post_type: "notice",
            notice_type: "friend_recall",
            user_id: toUin(revoke.operatorUid, ctx),
            message_id: Number(msg.msgSeq),
        };
    }
    return {
        ...base(msg, ctx),
        notice_type: "group_recall",
        user_id: toUin(revoke.operatorUid, ctx),
        operator_id: toUin(revoke.operatorUid, ctx),
        message_id: Number(msg.msgSeq),
    };
}

/**
 * 戳一戳（notify.poke，aioOpGrayTipElement）。
 *
 * ⚠️ 待真实 poke 事件验证：aioOp 载荷的完整字段形状未经实测（实体类型仅有
 * operateType/peerUid 两个已证字段）。当前口径：user_id = 消息发送者，
 * target_id = aioOp.peerUid（C2C 即对端；群内为目标 uid 的假设待校准），
 * group_id = 群号（C2C 为 0）。poke 路径始终打 raw 日志积累校准数据。
 */
function toPoke(
    msg: RawMessage,
    g: GrayTipElement,
    ctx: NoticeTranslateContext,
): OB11NotifyNoticeEvent {
    const aioOp = g?.aioOpGrayTipElement;
    ctx.logger?.warn(
        { raw: JSON.stringify(g)?.slice(0, 2000) },
        "ob11: poke grayTip raw（待真实事件校准）",
    );
    const isGroup = msg.chatType === ChatType.GROUP;
    return {
        time: toUnixSeconds(msg.msgTime),
        self_id: Number(ctx.selfUin),
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        group_id: isGroup ? Number(msg.peerUid) : 0,
        user_id: toUin(msg.senderUid, ctx),
        target_id: toUin(aioOp?.peerUid ?? "", ctx),
    };
}

/** 群成员变动事件族（increase/decrease/admin/ban 的联合，映射器返回类型）。 */
type OB11GroupEvent =
    | OB11GroupIncreaseNoticeEvent
    | OB11GroupDecreaseNoticeEvent
    | OB11GroupAdminNoticeEvent
    | OB11GroupBanNoticeEvent;

/** 群成员变动公共字段。 */
interface GroupChangeCommon {
    time: number;
    selfId: number;
    groupId: number;
    memberUid: string;
    adminUid: string;
}

/** 群成员变动映射器表（键 = TipGroupElementType；缺项 = 不可翻译返回 null）。 */
const GROUP_CHANGE_BUILDERS: Partial<
    Record<
        TipGroupElementType,
        (
            common: GroupChangeCommon,
            grp: TipGroupElement,
            ctx: NoticeTranslateContext,
        ) => OB11GroupEvent | null
    >
> = {
    [TipGroupElementType.MEMBER_ADD]: toMemberAdd,
    [TipGroupElementType.QUIT]: toQuit,
    [TipGroupElementType.BLOCK]: toAdminChange,
    [TipGroupElementType.UNBLOCK]: toAdminChange,
    [TipGroupElementType.SHUT_UP]: toBan,
};

/** 群成员变动（group_increase / group_decrease / group_admin / group_ban）。 */
function toGroupChange(
    msg: RawMessage,
    g: GrayTipElement,
    ctx: NoticeTranslateContext,
): OB11GroupEvent | null {
    // Linux 原生对象未命中的变体字段显式置 null（== null 判据）
    const grp = g?.groupElement;
    if (grp == null || grp.type === undefined) {
        return null;
    }
    const builder = GROUP_CHANGE_BUILDERS[grp.type];
    if (builder === undefined) {
        return null;
    }
    return builder(
        {
            time: toUnixSeconds(msg.msgTime),
            selfId: Number(ctx.selfUin),
            groupId: Number(msg.peerUid),
            memberUid: grp.memberUid ?? "",
            adminUid: grp.adminUid ?? "",
        },
        grp,
        ctx,
    );
}

/** 群成员增加（approve=管理员操作 / invite=普通邀请）。 */
function toMemberAdd(
    common: GroupChangeCommon,
    _grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): OB11GroupIncreaseNoticeEvent {
    const { time, selfId, groupId, memberUid, adminUid } = common;
    return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_increase",
        sub_type: adminUid === memberUid ? "approve" : "invite",
        group_id: groupId,
        operator_id: toUin(adminUid, ctx),
        user_id: toUin(memberUid, ctx),
    };
}

/** 群成员退出（leave）。 */
function toQuit(
    common: GroupChangeCommon,
    _grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): OB11GroupDecreaseNoticeEvent {
    const { time, selfId, groupId, memberUid, adminUid } = common;
    return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_decrease",
        sub_type: "leave",
        group_id: groupId,
        operator_id: toUin(adminUid, ctx),
        user_id: toUin(memberUid, ctx),
    };
}

/** 管理员变更（BLOCK=set / UNBLOCK=unset）。 */
function toAdminChange(
    common: GroupChangeCommon,
    grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): OB11GroupAdminNoticeEvent {
    const { time, selfId, groupId, memberUid, adminUid } = common;
    return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_admin",
        sub_type: grp.type === TipGroupElementType.BLOCK ? "set" : "unset",
        group_id: groupId,
        user_id: toUin(memberUid === "" ? adminUid : memberUid, ctx),
    };
}

/** 禁言（duration>0=ban / 否则 lift_ban）。 */
function toBan(
    common: GroupChangeCommon,
    grp: TipGroupElement,
    ctx: NoticeTranslateContext,
): OB11GroupBanNoticeEvent {
    const shutUp = grp.shutUp;
    const duration = Number(shutUp?.duration ?? 0);
    return {
        time: common.time,
        self_id: common.selfId,
        post_type: "notice",
        notice_type: "group_ban",
        sub_type: duration > 0 ? "ban" : "lift_ban",
        group_id: common.groupId,
        operator_id: toUin(shutUp?.admin?.uid ?? common.adminUid, ctx),
        user_id: toUin(shutUp?.member?.uid ?? common.memberUid, ctx),
        duration,
    };
}

/**
 * 好友添加（friend_add，）。
 * 数据源 = kernel BuddyCache 快照 diff（Buddy/onBuddyListChange 全量快照对比，
 * 首帧 baseline 不发）——非 grayTip 路径。user_id 取 coreInfo.uin（顶层 uin 兜底）。
 */
export function toFriendAdd(entry: BuddyListEntry, selfUin: string): OB11FriendAddNoticeEvent {
    const uin = entry.coreInfo?.uin ?? entry.uin ?? "";
    return {
        time: Math.floor(Date.now() / MS_TO_SEC),
        self_id: Number(selfUin),
        post_type: "notice",
        notice_type: "friend_add",
        user_id: Number(uin),
    };
}

/**
 * 群文件上传（group_upload，）。
 * 数据源 = 含 fileElement 的群消息（开关 groupUploadAsNotice=true 时替代
 * message 事件报出）。file.id 取 fileUuid（缺省文件名）、size 取 fileSize、
 * busid 固定 102（群文件业务类型，与 kernel GROUP_FILE_BIZ_TYPE 同源语义）。
 */
export function toGroupUpload(msg: RawMessage, selfUin: string): OB11GroupUploadNoticeEvent | null {
    const el = msg.elements.find((e) => e.fileElement != null);
    const file = el?.fileElement;
    if (file === undefined) {
        return null;
    }
    return {
        time: toUnixSeconds(msg.msgTime),
        self_id: Number(selfUin),
        post_type: "notice",
        notice_type: "group_upload",
        group_id: Number(msg.peerUid),
        user_id: Number(msg.senderUin),
        file: {
            id: file.fileUuid ?? file.fileName ?? "",
            name: file.fileName ?? "",
            size: Number(file.fileSize ?? 0),
            busid: GROUP_FILE_BUS_ID,
        },
    };
}

/** 单个 grayTip 元素 → notice 事件（null = 不可翻译；未知子类型打 raw 日志）。 */
function translateGrayTip(
    msg: RawMessage,
    g: GrayTipElement,
    ctx: NoticeTranslateContext,
): OB11Event | null {
    const subType = g.subElementType;
    if (subType === GrayTipSubType.REVOKE) {
        return toRecall(msg, g, ctx);
    }
    if (subType === GrayTipSubType.GROUP) {
        return toGroupChange(msg, g, ctx);
    }
    if (g.aioOpGrayTipElement != null) {
        // poke（aioOp）：subElementType 归属未实证（BUDDY_NOTIFY/GROUP_NOTIFY 载荷），
        // 以元素存在性识别；始终打 raw 日志（toPoke 内）
        return toPoke(msg, g, ctx);
    }
    // 未知/未翻译子类型：raw 日志（JSON/BUDDY/ESSENCE/GROUP_NOTIFY/FILE 等——
    // friend_add/lucky_notify/honor/essence 等翻译的数据源校准入口）
    logUntranslatedGrayTip(msg, ctx);
    return null;
}

// 未知/未翻译子类型 raw 日志（与 Milky notice 同源，core 提取器定位元素）
function logUntranslatedGrayTip(msg: RawMessage, ctx: NoticeTranslateContext): void {
    const untranslated = firstUntranslatedGrayTip(msg);
    if (untranslated !== undefined) {
        ctx.logger?.warn(
            {
                subType: untranslated.subElementType,
                raw: JSON.stringify(untranslated)?.slice(0, 2000),
            },
            "ob11: 未翻译的 grayTip 子类型（raw 校准数据）",
        );
    }
}

/** RawMessage → OB11 notice 事件（无 grayTip 返回 null）。
 * 未知/未翻译子类型打 raw JSON 日志（校准数据积累）。 */
export function toOb11NoticeEvent(msg: RawMessage, ctx: NoticeTranslateContext): OB11Event | null {
    for (const el of msg.elements) {
        const g = el.grayTipElement;
        // Linux 原生对象未命中的变体字段显式置 null（== null 判据）
        if (g == null) {
            continue;
        }
        const event = translateGrayTip(msg, g, ctx);
        if (event !== null) {
            return event;
        }
    }
    return null;
}
