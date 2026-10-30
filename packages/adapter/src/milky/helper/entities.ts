/**
 * kernel 实体 → Milky 实体翻译（纯函数，ADR-008）
 *
 * Milky 事件/查询输出要求完整实体（GroupEntity/GroupMemberEntity/FriendEntity
 * 的全部字段 required）；kernel 实体字段是超集的子集，缺失字段按最小合法值兜底
 * （0 / 空串 / unknown），实触样本到位后逐步补真实值。
 */

import type { Friend } from "@napuketto/kernel";
import { GroupApi, type GroupDetailInfo, type GroupMember } from "@napuketto/kernel";
import type { FriendEntity, GroupEntity, GroupMemberEntity } from "../types.js";

/** GroupDetailInfo / Group → GroupEntity（detail 缺失时全兜底）。 */
export function toGroupEntity(detail: GroupDetailInfo | undefined, groupCode: string): GroupEntity {
    return {
        group_id: Number(groupCode),
        group_name: detail?.groupName ?? "",
        member_count: detail?.memberNum ?? 0,
        max_member_count: detail?.maxMemberNum ?? 0,
        remark: detail?.remarkName ?? "",
        created_time: detail?.groupCreateTime ?? 0,
        description: "",
        question: "",
        announcement: "",
    };
}

/** 群列表项（GroupCache Group）→ GroupEntity。 */
export function groupListToEntity(group: {
    groupCode: string;
    groupName: string;
    memberCount: number;
    maxMember: number;
}): GroupEntity {
    return {
        group_id: Number(group.groupCode),
        group_name: group.groupName,
        member_count: group.memberCount,
        max_member_count: group.maxMember,
        remark: "",
        created_time: 0,
        description: "",
        question: "",
        announcement: "",
    };
}

/** GroupMember → GroupMemberEntity（member 缺失时按 uin 兜底最小实体）。 */
export function toGroupMemberEntity(
    member: GroupMember | undefined,
    groupCode: string,
    uin: string,
): GroupMemberEntity {
    const shutUpSeconds = member?.shutUpTime ?? 0;
    return {
        user_id: Number(member?.uin !== undefined && member.uin !== "" ? member.uin : uin),
        nickname: member?.nick ?? "",
        sex: "unknown",
        group_id: Number(groupCode),
        card: member?.cardName ?? "",
        title: member?.memberSpecialTitle ?? "",
        level: 0,
        role: GroupApi.roleToString(member?.role ?? 2),
        join_time: Number(member?.joinTime) || 0,
        last_sent_time: Number(member?.lastSpeakTime) || 0,
        shut_up_end_time: shutUpSeconds > 0 ? Math.floor(Date.now() / 1000) + shutUpSeconds : null,
    };
}

/** Friend → FriendEntity（kernel 无 qid/分类挂载，按最小实体兜底）。 */
export function toFriendEntity(
    friend: Friend | undefined,
    uin: string,
    nick: string,
): FriendEntity {
    return {
        user_id: Number(friend?.uin !== undefined && friend.uin !== "" ? friend.uin : uin),
        nickname: friend?.nickname ?? nick,
        sex: "unknown",
        qid: "",
        remark: friend?.remark ?? "",
        category: { category_id: 0, category_name: "" },
    };
}
