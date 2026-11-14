/**
 * OB11 翻译辅助（NT 实体 → OB11 结构）
 *
 * 纯函数：只读入参，不调 API、不读缓存。
 * 群成员/群信息等 NT 实体 → OB11 返回结构的薄映射。
 */
import { type Group, GroupApi, type GroupDetailInfo, type GroupMember } from "@napuketto/kernel";
import type { GroupInfo, GroupMemberInfo } from "../types/index.js";

/** NT Group → OB11 GroupInfo。 */
export function toOb11GroupInfo(group: Group): GroupInfo {
    const info: GroupInfo = {
        group_id: Number(group.groupCode),
        group_name: group.groupName,
    };
    if (typeof group.memberCount === "number") {
        info.member_count = group.memberCount;
    }
    if (typeof group.maxMember === "number") {
        info.max_member_count = group.maxMember;
    }
    return info;
}

/** NT GroupDetailInfo → OB11 GroupInfo（getGroupDetailInfo / GroupCache 用）。 */
export function toOb11GroupInfoDetail(detail: GroupDetailInfo): GroupInfo {
    const info: GroupInfo = {
        group_id: Number(detail.groupCode),
        group_name: detail.groupName,
    };
    if (typeof detail.memberNum === "number") {
        info.member_count = detail.memberNum;
    }
    if (typeof detail.maxMemberNum === "number") {
        info.max_member_count = detail.maxMemberNum;
    }
    return info;
}

/** 禁言秒 → 毫秒（shut_up_timestamp 单位）。 */
const SEC_TO_MS = 1000;

/** NT GroupMember → OB11 GroupMemberInfo（uin 由 uidToUin 映射补全）。 */
export function toOb11GroupMemberInfo(
    groupCode: string,
    member: GroupMember,
    uidToUin: Map<string, string>,
): GroupMemberInfo {
    let uinStr = member.uin;
    if (uinStr === "") {
        uinStr = uidToUin.get(member.uid) ?? member.uid;
    }
    const info: GroupMemberInfo = {
        group_id: Number(groupCode),
        user_id: Number(uinStr),
        nickname: member.nick,
        role: GroupApi.roleToString(member.role),
    };
    if (member.cardName !== "") {
        info.card = member.cardName;
    }
    if (member.memberSpecialTitle !== undefined && member.memberSpecialTitle !== "") {
        info.title = member.memberSpecialTitle;
        info.special_title = member.memberSpecialTitle;
    }
    if (member.shutUpTime > 0) {
        info.shut_up_timestamp = member.shutUpTime * SEC_TO_MS;
    }
    if (member.joinTime !== "" && member.joinTime !== "0") {
        info.join_time = Number(member.joinTime);
    }
    if (member.lastSpeakTime !== "" && member.lastSpeakTime !== "0") {
        info.last_sent_time = Number(member.lastSpeakTime);
    }
    if (typeof member.age === "number") {
        info.age = member.age;
    }
    return info;
}
