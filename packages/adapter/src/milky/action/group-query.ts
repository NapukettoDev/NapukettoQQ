/**
 * Milky 群查询域动作（2026-11-14 自 group.ts 拆分，结构重构会话 4/5）
 *
 * 只读取合：群信息（GroupCache 详情缓存优先）、成员列表/单查（缓存惰性回填，
 * 直查路径按 uin 匹配）、群公告列表（bulletin 形状待校准，宽松映射）。
 */
import type { GroupBulletin, GroupMember } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { toGroupEntity, toGroupMemberEntity } from "../helper/message/entities.js";
import type {
    GetGroupAnnouncementsOutput,
    GetGroupInfoOutput,
    GetGroupMemberInfoOutput,
    GetGroupMemberListOutput,
    GroupAnnouncementEntity,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";

const groupIdField = { group_id: z.number().int().min(10001) } as const;
const userIdField = { user_id: z.number().int().min(10001) } as const;
const optBool = z.boolean().nullable().optional();

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

/** get_group_announcements：获取群公告列表（bulletin 形状待校准，宽松映射）。 */
export class GetGroupAnnouncementsAction extends MilkyApiAction<
    { group_id: number },
    GetGroupAnnouncementsOutput
> {
    readonly name = "get_group_announcements";
    readonly schema = z.object({ ...groupIdField });

    protected async _handle(payload: { group_id: number }): Promise<GetGroupAnnouncementsOutput> {
        const groupCode = String(payload.group_id);
        const bulletins = await this.api.groupApi.getGroupAnnouncements(groupCode);
        const announcements = await Promise.all(
            bulletins.map((b) => bulletinToEntity(b, payload.group_id, this.api)),
        );
        return { announcements };
    }
}

/** ---------- 内部辅助 ---------- */

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

/** GroupBulletin → 群公告实体（senderUid → uin 反查；无源字段兜底，待校准）。 */
async function bulletinToEntity(
    b: GroupBulletin,
    groupId: number,
    api: MilkyApi,
): Promise<GroupAnnouncementEntity> {
    return {
        group_id: groupId,
        announcement_id: b.announcementId ?? "",
        user_id: await senderUinOf(b, api),
        time: Number(b.publishTime) || 0,
        content: b.content ?? "",
        image_url: picUrlOf(b),
    };
}

/** 公告发送者 uid → uin（缺省/转换失败 0 兜底）。 */
async function senderUinOf(b: GroupBulletin, api: MilkyApi): Promise<number> {
    const uid = b.senderUid;
    if (typeof uid !== "string" || uid === "") {
        return 0;
    }
    const uins = await api.uidToUin([uid]).catch(() => undefined);
    return Number(uins?.get(uid)) || 0;
}

/** 公告图片 url（缺省 null）。 */
function picUrlOf(b: GroupBulletin): string | null {
    const url = b.pic?.url;
    return typeof url === "string" && url !== "" ? url : null;
}
