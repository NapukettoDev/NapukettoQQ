/**
 * Milky 群查询域动作：get_group_info / get_group_member_list /
 * get_group_member_info / get_group_announcements。
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
import { defineMilkyAction, type MilkyAction } from "./base-action.js";

/** 群域共入参（群号 / 成员 uin / 可选布尔；群管理 / 通知 / 精华 / 文件域复用）。 */
export const groupIdField = { group_id: z.number().int().min(10001) } as const;
export const userIdField = { user_id: z.number().int().min(10001) } as const;
export const optBool = z.boolean().nullable().optional();

/** 群查询域动作工厂（群信息 / 成员列表 / 成员单查 / 公告列表）。 */
export function createGroupQueryActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_group_info",
            schema: z.object({ ...groupIdField, no_cache: optBool }),
            // GroupCache 详情缓存优先
            handle: async (payload: {
                group_id: number;
                no_cache?: boolean | null | undefined;
            }): Promise<GetGroupInfoOutput> => {
                const groupCode = String(payload.group_id);
                const detail =
                    api.groupCache !== undefined
                        ? await api.groupCache.getGroupDetail(groupCode)
                        : await api.groupApi.getGroupInfo(groupCode);
                return { group: toGroupEntity(detail, groupCode) };
            },
        }),
        defineMilkyAction({
            name: "get_group_member_list",
            schema: z.object({ ...groupIdField, no_cache: optBool }),
            // GroupCache 惰性回填
            handle: async (payload: {
                group_id: number;
                no_cache?: boolean | null | undefined;
            }): Promise<GetGroupMemberListOutput> => {
                const members = await membersOf(api, String(payload.group_id));
                return {
                    members: members.map((m) =>
                        toGroupMemberEntity(m, String(payload.group_id), m.uin),
                    ),
                };
            },
        }),
        defineMilkyAction({
            name: "get_group_member_info",
            schema: z.object({ ...groupIdField, ...userIdField, no_cache: optBool }),
            // user_id = uin → 成员单查
            handle: async (payload: {
                group_id: number;
                user_id: number;
                no_cache?: boolean | null | undefined;
            }): Promise<GetGroupMemberInfoOutput> => {
                const member = await memberOf(api, payload.group_id, payload.user_id);
                return {
                    member: toGroupMemberEntity(
                        member,
                        String(payload.group_id),
                        String(payload.user_id),
                    ),
                };
            },
        }),
        defineMilkyAction({
            name: "get_group_announcements",
            schema: z.object({ ...groupIdField }),
            // bulletin 形状待校准，宽松映射
            handle: async (payload: { group_id: number }): Promise<GetGroupAnnouncementsOutput> => {
                const groupCode = String(payload.group_id);
                const bulletins = await api.groupApi.getGroupAnnouncements(groupCode);
                const announcements = await Promise.all(
                    bulletins.map((b) => bulletinToEntity(b, payload.group_id, api)),
                );
                return { announcements };
            },
        }),
    ];
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
        const uid = await api.resolveUidFromUin(userId).catch((err) => {
            // uin→uid 失败退 uin 查缓存（大概率 NOT_FOUND，debug 留痕）
            api.logger?.debug(
                { group: groupCode, uin, error: err instanceof Error ? err.message : String(err) },
                "milky: 成员 uin→uid 失败，退用 uin 查缓存",
            );
            return uin;
        });
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
    const uins = await api.uidToUin([uid]).catch((err) => {
        api.logger?.debug(
            { uid, error: err instanceof Error ? err.message : String(err) },
            "milky: 公告发送者 uid→uin 失败，兜底 0",
        );
        return undefined;
    });
    return Number(uins?.get(uid)) || 0;
}

/** 公告图片 url（缺省 null）。 */
function picUrlOf(b: GroupBulletin): string | null {
    const url = b.pic?.url;
    return typeof url === "string" && url !== "" ? url : null;
}
