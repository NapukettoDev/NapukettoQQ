/**
 * Milky 群通知域动作：get_group_notifications / accept_group_request /
 * reject_group_request / accept_group_invitation / reject_group_invitation。
 * - 通知列表：kernel getSingleScreenNotifies 为单屏快照（无翻页）——
 *   start_notification_seq 作客户端过滤；实体类型 7=入群申请 / 5=成员邀请他人 /
 *   8,12,13=管理员变更 / 9,10=踢出 / 11=退群（1=邀请自身无实体变体，不产出）。
 * - 应答：seq → getSingleScreenNotifies 匹配（先非可疑后可疑）→ handleGroupRequest。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { NTGroupRequestOperateTypes } from "@napuketto/kernel";
import { z } from "zod";
import { findGroupNotify, type MilkyApi } from "../api.js";
import { collectNotifyUids } from "../helper/event/request.js";
import type { GetGroupNotificationsOutput, GroupNotificationEntity } from "../types.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";
import { groupIdField, optBool } from "./group-query.js";

const optStr = z.string().nullable().optional();

/** 通知查找数量（单屏全量，OB11 DEFAULT_COUNT 同值）。 */
const NOTIFY_SEARCH_COUNT = 100;

/** get_group_notifications 默认 limit（规范 default 20）。 */
const NOTIFICATIONS_DEFAULT_LIMIT = 20;

/** 群通知域动作工厂（通知列表 + 应答四动作）。 */
export function createGroupNoticeActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_group_notifications",
            schema: z.object({
                start_notification_seq: z.number().int().min(0).nullable().optional(),
                is_filtered: optBool,
                limit: z.number().int().min(0).nullable().optional(),
            }),
            // kernel getSingleScreenNotifies 为单屏快照（无翻页）——start_notification_seq
            // 作客户端过滤（取 seq 更小的记录）；next = 本页最小 seq（仍有余量时）。
            handle: async (payload: {
                start_notification_seq?: number | null | undefined;
                is_filtered?: boolean | null | undefined;
                limit?: number | null | undefined;
            }): Promise<GetGroupNotificationsOutput> => {
                const notifies = await api.groupNotifyApi.getSingleScreenNotifies(
                    payload.is_filtered === true,
                    NOTIFY_SEARCH_COUNT,
                );
                const start = payload.start_notification_seq;
                const filtered = notifies.filter(
                    (n) => start === undefined || start === null || Number(n.seq) < start,
                );
                // 通知涉及的 uid → uin 批量转换（实体 user 字段都是 uin）
                const uidToUin = await collectUidToUin(api, filtered);
                const entities = filtered
                    .map((n) => notifyToEntity(n, payload.is_filtered === true, uidToUin))
                    .filter((e): e is GroupNotificationEntity => e !== null);
                const limit = payload.limit ?? NOTIFICATIONS_DEFAULT_LIMIT;
                const page = entities.slice(0, limit);
                const minSeq = page.reduce<number | null>(
                    (acc, e) =>
                        acc === null ? e.notification_seq : Math.min(acc, e.notification_seq),
                    null,
                );
                return {
                    notifications: page,
                    next_notification_seq:
                        entities.length > page.length && minSeq !== null ? minSeq : null,
                };
            },
        }),
        defineMilkyAction({
            name: "accept_group_request",
            schema: respondRequestSchema,
            // notification_type/group_id 仅 schema 校验
            handle: async (payload: {
                notification_seq: number;
                is_filtered?: boolean | null | undefined;
            }) =>
                respondGroupNotify(
                    api,
                    payload.notification_seq,
                    payload.is_filtered === true,
                    true,
                ),
        }),
        defineMilkyAction({
            name: "reject_group_request",
            schema: rejectRequestSchema,
            // reason 无源，kernel postscript 占位空格
            handle: async (payload: {
                notification_seq: number;
                is_filtered?: boolean | null | undefined;
            }) =>
                respondGroupNotify(
                    api,
                    payload.notification_seq,
                    payload.is_filtered === true,
                    false,
                ),
        }),
        defineMilkyAction({
            name: "accept_group_invitation",
            schema: invitationSchema,
            // 按 invitation_seq 匹配
            handle: async (payload: { invitation_seq: number }) =>
                respondGroupNotify(api, payload.invitation_seq, false, true),
        }),
        defineMilkyAction({
            name: "reject_group_invitation",
            schema: invitationSchema,
            handle: async (payload: { invitation_seq: number }) =>
                respondGroupNotify(api, payload.invitation_seq, false, false),
        }),
    ];
}

/** accept_group_request 入参（notification_type 仅 schema 校验）。 */
const respondRequestSchema = z.object({
    notification_seq: z.number().int().min(0),
    notification_type: z.enum(["join_request", "invited_join_request"]),
    ...groupIdField,
    is_filtered: optBool,
});

/** reject_group_request 入参（reason 无源）。 */
const rejectRequestSchema = z.object({
    notification_seq: z.number().int().min(0),
    notification_type: z.enum(["join_request", "invited_join_request"]),
    ...groupIdField,
    is_filtered: optBool,
    reason: optStr,
});

/** accept/reject_group_invitation 入参。 */
const invitationSchema = z.object({
    ...groupIdField,
    invitation_seq: z.number().int().min(0),
});

/** 应答公共路径：seq → 通知匹配 → handleGroupRequest。 */
async function respondGroupNotify(
    api: MilkyApi,
    seq: number,
    doubt: boolean,
    approve: boolean,
): Promise<Record<string, never>> {
    const notify = await findGroupNotify(api, String(seq));
    await api.groupNotifyApi.handleGroupRequest(
        doubt,
        notify,
        approve ? NTGroupRequestOperateTypes.KAGREE : NTGroupRequestOperateTypes.KREFUSE,
        " ",
    );
    return {};
}

/** 通知 user1/user2 uid → uin 批量转换（失败退空 Map，实体 id 兜底 0）。 */
async function collectUidToUin(
    api: MilkyApi,
    notifies: GroupNotify[],
): Promise<Map<string, string>> {
    const uids = collectNotifyUids(notifies);
    if (uids.length === 0) {
        return new Map();
    }
    return await api.uidToUin(uids).catch((err) => {
        api.logger?.warn(
            { count: uids.length, error: err instanceof Error ? err.message : String(err) },
            "milky: 通知 uid→uin 失败，实体 id 兜底 0",
        );
        return new Map<string, string>();
    });
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
