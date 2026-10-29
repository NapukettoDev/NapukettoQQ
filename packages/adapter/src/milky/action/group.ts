/**
 * Milky 群类动作（P1）：群信息 / 群管 / 精华 / 表态 / 通知
 *
 * - 群管（set_group_member_card / set_group_member_admin / set_group_member_mute /
 *   kick_group_member）：user_id(uin) → uid 转换后进 kernel（resolveUidFromUin）。
 * - 精华：seq → msgId 经 seqIndex 反查；列表经 WebApi.getEssenceMsgList（客户端分页）。
 * - 通知实体/应答：seq → getSingleScreenNotifies 匹配（先非可疑后可疑）→
 *   handleGroupRequest；通知类型 7=入群申请 / 5=成员邀请他人 / 8,12,13=管理员变更 /
 *   9,10=踢出 / 11=退群（1=邀请自身无实体变体，不产出）。
 */
import type { EssenceMsgItem, GroupMember, GroupNotify, Peer } from "@napuketto/kernel";
import { ChatType, kernelError, NTGroupRequestOperateTypes } from "@napuketto/kernel";
import { z } from "zod";
import { findGroupNotify, type MilkyApi } from "../api.js";
import { toGroupEntity, toGroupMemberEntity } from "../helper/entities.js";
import { collectNotifyUids } from "../helper/request.js";
import type {
    GetGroupEssenceMessagesOutput,
    GetGroupInfoOutput,
    GetGroupMemberInfoOutput,
    GetGroupMemberListOutput,
    GetGroupNotificationsOutput,
    GroupEssenceMessage,
    GroupNotificationEntity,
    IncomingSegment,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";

const groupIdField = { group_id: z.number().int().min(10001) } as const;
const userIdField = { user_id: z.number().int().min(10001) } as const;
const optBool = z.boolean().nullable().optional();
const optStr = z.string().nullable().optional();

/** get_group_info：获取群信息（GroupCache 详情缓存优先）。 */
export class GetGroupInfoAction extends MilkyApiAction<
    { group_id: number; no_cache?: boolean | null | undefined },
    GetGroupInfoOutput
> {
    readonly name = "get_group_info";
    readonly schema = z.object({ ...groupIdField, no_cache: optBool });

    protected async _handle(payload: {
        group_id: number;
        no_cache?: boolean | null | undefined;
    }): Promise<GetGroupInfoOutput> {
        const groupCode = String(payload.group_id);
        const detail =
            this.api.groupCache !== undefined
                ? await this.api.groupCache.getGroupDetail(groupCode)
                : await this.api.groupApi.getGroupInfo(groupCode);
        return { group: toGroupEntity(detail, groupCode) };
    }
}

/** get_group_member_list：获取群成员列表（GroupCache 惰性回填）。 */
export class GetGroupMemberListAction extends MilkyApiAction<
    { group_id: number; no_cache?: boolean | null | undefined },
    GetGroupMemberListOutput
> {
    readonly name = "get_group_member_list";
    readonly schema = z.object({ ...groupIdField, no_cache: optBool });

    protected async _handle(payload: {
        group_id: number;
        no_cache?: boolean | null | undefined;
    }): Promise<GetGroupMemberListOutput> {
        const members = await membersOf(this.api, String(payload.group_id));
        return {
            members: members.map((m) => toGroupMemberEntity(m, String(payload.group_id), m.uin)),
        };
    }
}

/** get_group_member_info：获取群成员信息（user_id = uin → 成员单查）。 */
export class GetGroupMemberInfoAction extends MilkyApiAction<
    { group_id: number; user_id: number; no_cache?: boolean | null | undefined },
    GetGroupMemberInfoOutput
> {
    readonly name = "get_group_member_info";
    readonly schema = z.object({ ...groupIdField, ...userIdField, no_cache: optBool });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        no_cache?: boolean | null | undefined;
    }): Promise<GetGroupMemberInfoOutput> {
        const member = await memberOf(this.api, payload.group_id, payload.user_id);
        return {
            member: toGroupMemberEntity(member, String(payload.group_id), String(payload.user_id)),
        };
    }
}

/** set_group_name：设置群名。 */
export class SetGroupNameAction extends MilkyApiAction<
    { group_id: number; new_group_name: string },
    Record<string, never>
> {
    readonly name = "set_group_name";
    readonly schema = z.object({ ...groupIdField, new_group_name: z.string() });

    protected async _handle(payload: {
        group_id: number;
        new_group_name: string;
    }): Promise<Record<string, never>> {
        await this.api.groupApi.modifyGroupName(String(payload.group_id), payload.new_group_name);
        return {};
    }
}

/** set_group_member_card：设置群名片。 */
export class SetGroupMemberCardAction extends MilkyApiAction<
    { group_id: number; user_id: number; card: string },
    Record<string, never>
> {
    readonly name = "set_group_member_card";
    readonly schema = z.object({ ...groupIdField, ...userIdField, card: z.string() });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        card: string;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        this.api.groupApi.setMemberCardName(String(payload.group_id), uid, payload.card);
        return {};
    }
}

/** set_group_member_admin：设置/取消管理员（is_set 缺省 true）。 */
export class SetGroupMemberAdminAction extends MilkyApiAction<
    { group_id: number; user_id: number; is_set?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_member_admin";
    readonly schema = z.object({ ...groupIdField, ...userIdField, is_set: optBool });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        is_set?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        this.api.groupApi.setMemberRole(
            String(payload.group_id),
            uid,
            payload.is_set === false ? NTGroupMemberRoleMember : NTGroupMemberRoleAdmin,
        );
        return {};
    }
}

/** set_group_member_mute：禁言成员（duration 秒，0 解除）。 */
export class SetGroupMemberMuteAction extends MilkyApiAction<
    { group_id: number; user_id: number; duration?: number | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_member_mute";
    readonly schema = z.object({
        ...groupIdField,
        ...userIdField,
        duration: z.number().int().min(0).nullable().optional(),
    });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        duration?: number | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.groupApi.setMemberShutUp(String(payload.group_id), [
            { uid, duration: payload.duration ?? 0 },
        ]);
        return {};
    }
}

/** set_group_whole_mute：全员禁言开关（is_mute 缺省 true）。 */
export class SetGroupWholeMuteAction extends MilkyApiAction<
    { group_id: number; is_mute?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_whole_mute";
    readonly schema = z.object({ ...groupIdField, is_mute: optBool });

    protected async _handle(payload: {
        group_id: number;
        is_mute?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        await this.api.groupApi.setGroupShutUp(String(payload.group_id), payload.is_mute !== false);
        return {};
    }
}

/** kick_group_member：移除成员（reject_add_request 默认 false）。 */
export class KickGroupMemberAction extends MilkyApiAction<
    { group_id: number; user_id: number; reject_add_request?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "kick_group_member";
    readonly schema = z.object({
        ...groupIdField,
        ...userIdField,
        reject_add_request: optBool,
    });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        reject_add_request?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.groupApi.kickMember(
            String(payload.group_id),
            [uid],
            payload.reject_add_request === true,
        );
        return {};
    }
}

/** quit_group：退出群聊。 */
export class QuitGroupAction extends MilkyApiAction<{ group_id: number }, Record<string, never>> {
    readonly name = "quit_group";
    readonly schema = z.object({ ...groupIdField });

    protected async _handle(payload: { group_id: number }): Promise<Record<string, never>> {
        await this.api.groupApi.quitGroup(String(payload.group_id));
        return {};
    }
}

/**
 * get_group_essence_messages：获取精华消息列表。
 * WebApi.getEssenceMsgList 全量拉取后按 page_index/page_size 客户端分页
 * （kernel 无分页参数）；message_time 无源取 operation_time 兜底。
 */
export class GetGroupEssenceMessagesAction extends MilkyApiAction<
    { group_id: number; page_index: number; page_size: number },
    GetGroupEssenceMessagesOutput
> {
    readonly name = "get_group_essence_messages";
    readonly schema = z.object({
        ...groupIdField,
        page_index: z.number().int().min(0),
        page_size: z.number().int().min(0),
    });

    protected async _handle(payload: {
        group_id: number;
        page_index: number;
        page_size: number;
    }): Promise<GetGroupEssenceMessagesOutput> {
        const items = await this.api.webApi.getEssenceMsgList(String(payload.group_id));
        const start = payload.page_index * payload.page_size;
        const page = items.slice(start, start + payload.page_size);
        return {
            messages: page.map((item) => essenceToEntity(item, payload.group_id)),
            is_end: start + page.length >= items.length,
        };
    }
}

/** set_group_essence_message：设置/取消精华（seq → msgId 反查）。 */
export class SetGroupEssenceMessageAction extends MilkyApiAction<
    { group_id: number; message_seq: number; is_set?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_essence_message";
    readonly schema = z.object({
        ...groupIdField,
        message_seq: z.number().int().min(0),
        is_set: optBool,
    });

    protected async _handle(payload: {
        group_id: number;
        message_seq: number;
        is_set?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const groupCode = String(payload.group_id);
        const peer: Peer = { chatType: ChatType.GROUP, peerUid: groupCode };
        const msgId = await this.api.resolveMsgIdBySeq(peer, payload.message_seq, ChatType.GROUP);
        if (msgId === undefined) {
            throw kernelError(`消息 ${payload.message_seq} 不存在`, "NOT_FOUND");
        }
        if (payload.is_set === false) {
            await this.api.groupApi.removeGroupEssence(groupCode, msgId);
        } else {
            await this.api.groupApi.addGroupEssence(groupCode, msgId);
        }
        return {};
    }
}

/** send_group_message_reaction：消息表情表态（reaction_type face→"1" / emoji→"2"）。 */
export class SendGroupMessageReactionAction extends MilkyApiAction<
    {
        group_id: number;
        message_seq: number;
        reaction: string;
        reaction_type?: "face" | "emoji" | null | undefined;
        is_add?: boolean | null | undefined;
    },
    Record<string, never>
> {
    readonly name = "send_group_message_reaction";
    readonly schema = z.object({
        ...groupIdField,
        message_seq: z.number().int().min(0),
        reaction: z.string().min(1),
        reaction_type: z.enum(["face", "emoji"]).nullable().optional(),
        is_add: z.boolean().nullable().optional(),
    });

    protected async _handle(payload: {
        group_id: number;
        message_seq: number;
        reaction: string;
        reaction_type?: "face" | "emoji" | null | undefined;
        is_add?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const peer: Peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
        await this.api.msgApi.setMsgEmojiLike(peer, {
            msgSeq: String(payload.message_seq),
            emojiId: payload.reaction,
            emojiType: payload.reaction_type === "emoji" ? "2" : "1",
            like: payload.is_add !== false,
        });
        return {};
    }
}

/**
 * get_group_notifications：获取群通知列表。
 * kernel getSingleScreenNotifies 为单屏快照（无翻页）——start_notification_seq
 * 作客户端过滤（取 seq 更小的记录）；next = 本页最小 seq（仍有余量时）。
 */
export class GetGroupNotificationsAction extends MilkyApiAction<
    {
        start_notification_seq?: number | null | undefined;
        is_filtered?: boolean | null | undefined;
        limit?: number | null | undefined;
    },
    GetGroupNotificationsOutput
> {
    readonly name = "get_group_notifications";
    readonly schema = z.object({
        start_notification_seq: z.number().int().min(0).nullable().optional(),
        is_filtered: optBool,
        limit: z.number().int().min(0).nullable().optional(),
    });

    protected async _handle(payload: {
        start_notification_seq?: number | null | undefined;
        is_filtered?: boolean | null | undefined;
        limit?: number | null | undefined;
    }): Promise<GetGroupNotificationsOutput> {
        const notifies = await this.api.groupNotifyApi.getSingleScreenNotifies(
            payload.is_filtered === true,
            NOTIFY_SEARCH_COUNT,
        );
        const start = payload.start_notification_seq;
        const filtered = notifies.filter(
            (n) => start === undefined || start === null || Number(n.seq) < start,
        );
        // 通知涉及的 uid → uin 批量转换（实体 user 字段都是 uin）
        const uidToUin = await this.collectUidToUin(filtered);
        const entities = filtered
            .map((n) => notifyToEntity(n, payload.is_filtered === true, uidToUin))
            .filter((e): e is GroupNotificationEntity => e !== null);
        const limit = payload.limit ?? NOTIFICATIONS_DEFAULT_LIMIT;
        const page = entities.slice(0, limit);
        const minSeq = page.reduce<number | null>(
            (acc, e) => (acc === null ? e.notification_seq : Math.min(acc, e.notification_seq)),
            null,
        );
        return {
            notifications: page,
            next_notification_seq: entities.length > page.length && minSeq !== null ? minSeq : null,
        };
    }

    /** 通知 user1/user2 uid → uin 批量转换（失败退空 Map，实体 id 兜底 0）。 */
    private async collectUidToUin(notifies: GroupNotify[]): Promise<Map<string, string>> {
        const uids = collectNotifyUids(notifies);
        if (uids.length === 0) {
            return new Map();
        }
        return await this.api.uidToUin(uids).catch(() => new Map<string, string>());
    }
}

/** accept/reject 群请求 / 群邀请公共基类：seq → 通知匹配 → handleGroupRequest。 */
abstract class HandleGroupNotifyBase<TPayload> extends MilkyApiAction<
    TPayload,
    Record<string, never>
> {
    /** 同意/拒绝。 */
    protected abstract readonly approve: boolean;

    protected async respond(seq: number, doubt: boolean): Promise<Record<string, never>> {
        const notify = await findGroupNotify(this.api, String(seq));
        await this.api.groupNotifyApi.handleGroupRequest(
            doubt,
            notify,
            this.approve ? NTGroupRequestOperateTypes.KAGREE : NTGroupRequestOperateTypes.KREFUSE,
            " ",
        );
        return {};
    }
}

/** accept_group_request：同意入群请求（notification_type/group_id 仅 schema 校验）。 */
export class AcceptGroupRequestAction extends HandleGroupNotifyBase<{
    notification_seq: number;
    is_filtered?: boolean | null | undefined;
}> {
    readonly name = "accept_group_request";
    readonly schema = z.object({
        notification_seq: z.number().int().min(0),
        notification_type: z.enum(["join_request", "invited_join_request"]),
        ...groupIdField,
        is_filtered: optBool,
    });
    protected readonly approve = true;

    protected async _handle(payload: {
        notification_seq: number;
        is_filtered?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        return await this.respond(payload.notification_seq, payload.is_filtered === true);
    }
}

/** reject_group_request：拒绝入群请求（reason 无源，kernel postscript 占位空格）。 */
export class RejectGroupRequestAction extends HandleGroupNotifyBase<{
    notification_seq: number;
    is_filtered?: boolean | null | undefined;
}> {
    readonly name = "reject_group_request";
    readonly schema = z.object({
        notification_seq: z.number().int().min(0),
        notification_type: z.enum(["join_request", "invited_join_request"]),
        ...groupIdField,
        is_filtered: optBool,
        reason: optStr,
    });
    protected readonly approve = false;

    protected async _handle(payload: {
        notification_seq: number;
        is_filtered?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        return await this.respond(payload.notification_seq, payload.is_filtered === true);
    }
}

/** accept_group_invitation：接受入群邀请（按 invitation_seq 匹配）。 */
export class AcceptGroupInvitationAction extends HandleGroupNotifyBase<{ invitation_seq: number }> {
    readonly name = "accept_group_invitation";
    readonly schema = z.object({ ...groupIdField, invitation_seq: z.number().int().min(0) });
    protected readonly approve = true;

    protected async _handle(payload: { invitation_seq: number }): Promise<Record<string, never>> {
        return await this.respond(payload.invitation_seq, false);
    }
}

/** reject_group_invitation：拒绝入群邀请。 */
export class RejectGroupInvitationAction extends HandleGroupNotifyBase<{ invitation_seq: number }> {
    readonly name = "reject_group_invitation";
    readonly schema = z.object({ ...groupIdField, invitation_seq: z.number().int().min(0) });
    protected readonly approve = false;

    protected async _handle(payload: { invitation_seq: number }): Promise<Record<string, never>> {
        return await this.respond(payload.invitation_seq, false);
    }
}

/** ---------- 内部辅助 ---------- */

/** 通知查找数量（单屏全量，OB11 DEFAULT_COUNT 同值）。 */
const NOTIFY_SEARCH_COUNT = 100;

/** get_group_notifications 默认 limit（规范 default 20）。 */
const NOTIFICATIONS_DEFAULT_LIMIT = 20;

/** NTGroupMemberRole 数值（ADMIN=3 / MEMBER=2，setMemberRole 入参）。 */
const NTGroupMemberRoleAdmin = 3;
const NTGroupMemberRoleMember = 2;

/** 成员列表（GroupCache 优先，未装配直查）。 */
async function membersOf(api: MilkyApi, groupCode: string): Promise<GroupMember[]> {
    if (api.groupCache !== undefined) {
        return await api.groupCache.getMembers(groupCode);
    }
    return await api.groupApi.getGroupMemberList(groupCode, true);
}

/** 成员单查（user_id = uin；缓存路径经 uid，直查路径按 uin 匹配）。 */
async function memberOf(api: MilkyApi, groupId: number, userId: number): Promise<GroupMember> {
    const groupCode = String(groupId);
    const uin = String(userId);
    if (api.groupCache !== undefined) {
        const uid = await api.resolveUidFromUin(userId).catch(() => uin);
        const member = await api.groupCache.getMember(groupCode, uid);
        if (member === undefined) {
            throw kernelError(`成员 ${uin} 不在群 ${groupCode}`, "NOT_FOUND");
        }
        return member;
    }
    const list = await api.groupApi.getGroupMemberList(groupCode, true);
    const hit = list.find((m) => m.uin === uin);
    if (hit === undefined) {
        throw kernelError(`成员 ${uin} 不在群 ${groupCode}`, "NOT_FOUND");
    }
    return hit;
}

/** 精华项 → GroupEssenceMessage（msg_content 近似翻译：text / image）。 */
function essenceToEntity(item: EssenceMsgItem, groupId: number): GroupEssenceMessage {
    const segments: IncomingSegment[] = [];
    for (const c of item.msg_content) {
        if (c.text !== undefined && c.text !== "") {
            segments.push({ type: "text", data: { text: c.text } });
        } else if (c.image_url !== undefined && c.image_url !== "") {
            segments.push({
                type: "image",
                data: {
                    resource_id: c.image_url,
                    temp_url: c.image_url,
                    width: 0,
                    height: 0,
                    summary: "",
                    sub_type: "normal",
                },
            });
        }
    }
    return {
        group_id: groupId,
        message_seq: item.msg_seq,
        message_time: item.add_digest_time,
        sender_id: Number(item.sender_uin) || 0,
        sender_name: item.sender_nick,
        operator_id: Number(item.add_digest_uin) || 0,
        operator_name: item.add_digest_nick,
        operation_time: item.add_digest_time,
        segments,
    };
}

/**
 * GroupNotify → GroupNotificationEntity（uidToUin 已由调用方批量转换）。
 * 类型→构造器表：7=入群申请 / 5=成员邀请他人 / 8=设管理 / 12,13=取消管理 /
 * 9,10=踢出 / 11=退群；1=邀请自身无实体变体（事件层表达），其余 null。
 */
const NOTIFY_ENTITY_BUILDERS: Partial<
    Record<
        number,
        (notify: GroupNotify, uinOf: (uid: string | undefined) => number) => GroupNotificationEntity
    >
> = {
    7: (n, uinOf) => ({
        type: "join_request",
        group_id: Number(n.group?.groupCode ?? 0),
        notification_seq: Number(n.seq),
        is_filtered: false,
        initiator_id: uinOf(n.user1?.uid),
        state: "pending",
        operator_id: null,
        comment: n.postscript ?? "",
    }),
    5: (n, uinOf) => ({
        type: "invited_join_request",
        group_id: Number(n.group?.groupCode ?? 0),
        notification_seq: Number(n.seq),
        initiator_id: uinOf(n.user1?.uid),
        target_user_id: uinOf(n.user2?.uid),
        state: "pending",
        operator_id: null,
    }),
    8: (n, uinOf) => adminChangeEntity(n, uinOf, true),
    12: (n, uinOf) => adminChangeEntity(n, uinOf, false),
    13: (n, uinOf) => adminChangeEntity(n, uinOf, false),
    9: (n, uinOf) => kickEntity(n, uinOf),
    10: (n, uinOf) => kickEntity(n, uinOf),
    11: (n, uinOf) => ({
        type: "quit",
        group_id: Number(n.group?.groupCode ?? 0),
        notification_seq: Number(n.seq),
        target_user_id: uinOf(n.user1?.uid),
    }),
};

/** admin_change 实体（8/12/13 共用）。 */
function adminChangeEntity(
    n: GroupNotify,
    uinOf: (uid: string | undefined) => number,
    isSet: boolean,
): GroupNotificationEntity {
    return {
        type: "admin_change",
        group_id: Number(n.group?.groupCode ?? 0),
        notification_seq: Number(n.seq),
        target_user_id: uinOf(n.user1?.uid),
        is_set: isSet,
        operator_id: uinOf(n.user2?.uid),
    };
}

/** kick 实体（9/10 共用）。 */
function kickEntity(
    n: GroupNotify,
    uinOf: (uid: string | undefined) => number,
): GroupNotificationEntity {
    return {
        type: "kick",
        group_id: Number(n.group?.groupCode ?? 0),
        notification_seq: Number(n.seq),
        target_user_id: uinOf(n.user1?.uid),
        operator_id: uinOf(n.user2?.uid),
    };
}

/** GroupNotify → 实体（isFiltered 透传给 join_request；未识别类型 null）。 */
function notifyToEntity(
    notify: GroupNotify,
    isFiltered: boolean,
    uidToUin: Map<string, string>,
): GroupNotificationEntity | null {
    const uinOf = (uid: string | undefined): number =>
        uid === undefined || uid === "" ? 0 : Number(uidToUin.get(uid) ?? 0) || 0;
    const builder = NOTIFY_ENTITY_BUILDERS[notify.type];
    if (builder === undefined) {
        return null;
    }
    const entity = builder(notify, uinOf);
    if (entity.type === "join_request") {
        entity.is_filtered = isFiltered;
    }
    return entity;
}
