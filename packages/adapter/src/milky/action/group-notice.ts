/**
 * Milky 群通知域动作（2026-11-14 自 group.ts 拆分，结构重构会话 4/5）
 *
 * - 通知列表：kernel getSingleScreenNotifies 为单屏快照（无翻页）——
 *   start_notification_seq 作客户端过滤；实体类型 7=入群申请 / 5=成员邀请他人 /
 *   8,12,13=管理员变更 / 9,10=踢出 / 11=退群（1=邀请自身无实体变体，不产出）。
 * - 应答：seq → getSingleScreenNotifies 匹配（先非可疑后可疑）→ handleGroupRequest。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { NTGroupRequestOperateTypes } from "@napuketto/kernel";
import { z } from "zod";
import { findGroupNotify } from "../api.js";
import { collectNotifyUids } from "../helper/event/request.js";
import type { GetGroupNotificationsOutput, GroupNotificationEntity } from "../types.js";
import { MilkyApiAction } from "./base-action.js";

const groupIdField = { group_id: z.number().int().min(10001) } as const;
const optBool = z.boolean().nullable().optional();
const optStr = z.string().nullable().optional();

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
