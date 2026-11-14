/**
 * Satori 群组动作：guild.get / guild.list / guild.approve
 * + guild.member.get / list / kick / mute / approve
 * （role.set / role.unset / guild.role.*：501，见 registry）
 */
import type { GroupMember, GroupNotify } from "@napuketto/kernel";
import { NTGroupRequestOperateTypes } from "@napuketto/kernel";
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toGuild, toUser } from "../helper/index.js";
import type { Guild, GuildMember, List } from "../types/index.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type GuildActionDeps = Pick<
    SatoriApi,
    "groupApi" | "groupNotifyApi" | "uinToUid" | "uidToUin" | "groupCache"
>;

/** 成员列表默认条数。 */
const DEFAULT_MEMBER_LIMIT = 100;

/** guild.approve / guild.member.approve 共入参（处理群邀请与加群申请）。 */
const groupApproveSchema = z.object({
    message_id: z.string(),
    approve: z.boolean(),
    comment: z.string().optional(),
});

/** 群组动作工厂（guild.get / list / approve + member 五动作）。 */
export function createGuildActions(deps: GuildActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "guild.get",
            schema: z.object({ guild_id: z.string() }),
            handle: async (payload): Promise<Guild> => {
                const { guild_id: guildId } = payload;
                const detail = await deps.groupApi.getGroupInfo(guildId);
                return toGuild(detail.groupCode, detail.groupName);
            },
        }),
        defineSatoriAction({
            name: "guild.list",
            schema: z.object({ next: z.string().optional() }),
            // 实测校准：原生 getGroupList 返回值无数据，列表经
            // onGroupListUpdate 事件推送 → GroupCache 维护；缓存为空时主动刷新回填。
            handle: async (): Promise<List<Guild>> => {
                const groups =
                    deps.groupCache === undefined
                        ? await deps.groupApi.getGroupList(true)
                        : await deps.groupCache.listGroupsRefreshed();
                const data: Guild[] = groups.map((g) => toGuild(g.groupCode, g.groupName));
                return { data };
            },
        }),
        defineSatoriAction({
            name: "guild.approve",
            schema: groupApproveSchema,
            // 处理群邀请（message_id = 群通知 seq）
            handle: async (payload): Promise<void> => {
                const { message_id: messageId, approve, comment } = payload;
                await respondGroupRequest(deps, messageId, approve, comment);
            },
        }),
        defineSatoriAction({
            name: "guild.member.get",
            schema: z.object({
                guild_id: z.string(),
                user_id: z.string(),
            }),
            handle: async (payload): Promise<GuildMember> => {
                const { guild_id: guildId, user_id: userId } = payload;
                const uidMap = await deps.uinToUid([userId]);
                const uid = uidMap.get(userId) ?? userId;
                const member = await deps.groupCache?.getMember(guildId, uid);
                if (member !== undefined) {
                    return toGuildMember(member, userId);
                }
                // 缓存未命中：直查原生（整群拉取后单查）
                const list = await deps.groupApi.getGroupMemberInfo(guildId, [uid]);
                const found = list.find((m) => m.uid === uid);
                if (found === undefined) {
                    throw new Error("群成员不存在");
                }
                return toGuildMember(found, userId);
            },
        }),
        defineSatoriAction({
            name: "guild.member.list",
            schema: z.object({
                guild_id: z.string(),
                next: z.string().optional(),
            }),
            handle: async (payload): Promise<List<GuildMember>> => {
                const { guild_id: guildId } = payload;
                let members: GroupMember[];
                const cached = await deps.groupCache?.getMembers(guildId);
                if (cached !== undefined && cached.length > 0) {
                    members = cached;
                } else {
                    members = await deps.groupApi.getGroupMemberList(guildId, true);
                }
                const limited = members.slice(0, DEFAULT_MEMBER_LIMIT);
                // 批量 uid → uin（user.id 规范为 uin）
                const uids = limited.map((m) => m.uid);
                const uinMap = await deps.uidToUin(uids);
                const data: GuildMember[] = limited.map((m) =>
                    toGuildMember(m, uinMap.get(m.uid) ?? m.uin),
                );
                const out: List<GuildMember> = { data };
                if (members.length > DEFAULT_MEMBER_LIMIT) {
                    out.next = String(DEFAULT_MEMBER_LIMIT);
                }
                return out;
            },
        }),
        defineSatoriAction({
            name: "guild.member.kick",
            schema: z.object({
                guild_id: z.string(),
                user_id: z.string(),
                /** 是否永久踢出（无法再次加入）。 */
                permanent: z.boolean().optional(),
            }),
            handle: async (payload): Promise<void> => {
                const { guild_id: guildId, user_id: userId, permanent } = payload;
                const uidMap = await deps.uinToUid([userId]);
                const uid = uidMap.get(userId) ?? userId;
                await deps.groupApi.kickMember(guildId, [uid], permanent === true);
            },
        }),
        defineSatoriAction({
            name: "guild.member.mute",
            schema: z.object({
                guild_id: z.string(),
                user_id: z.string(),
                /** 禁言时长（毫秒，Satori 规范）；0 解除禁言。 */
                duration: z.number(),
            }),
            // Satori duration 毫秒 → kernel setMemberShutUp 秒
            handle: async (payload): Promise<void> => {
                const { guild_id: guildId, user_id: userId, duration } = payload;
                const uidMap = await deps.uinToUid([userId]);
                const uid = uidMap.get(userId) ?? userId;
                await deps.groupApi.setMemberShutUp(guildId, [
                    { uid, duration: msToSeconds(duration) },
                ]);
            },
        }),
        defineSatoriAction({
            name: "guild.member.approve",
            schema: groupApproveSchema,
            // 处理加群申请（message_id = 群通知 seq）
            handle: async (payload): Promise<void> => {
                const { message_id: messageId, approve, comment } = payload;
                await respondGroupRequest(deps, messageId, approve, comment);
            },
        }),
    ];
}

/** 处理群请求（guild.approve / guild.member.approve 共用实现）。 */
async function respondGroupRequest(
    deps: GuildActionDeps,
    messageId: string,
    approve: boolean,
    comment: string | undefined,
): Promise<void> {
    const notify = await findGroupNotify(deps, messageId);
    const operateType = approve
        ? NTGroupRequestOperateTypes.KAGREE
        : NTGroupRequestOperateTypes.KREFUSE;
    await deps.groupNotifyApi.handleGroupRequest(false, notify, operateType, comment ?? "");
}

/** 毫秒 → 秒（QQ setMemberShutUp 单位；向下取整，0 解除禁言）。 */
function msToSeconds(ms: number): number {
    return Math.max(0, Math.floor(ms / 1000));
}

/** 按 message_id（通知 seq）查找群通知（单屏非可疑快照）。 */
async function findGroupNotify(deps: GuildActionDeps, messageId: string): Promise<GroupNotify> {
    const found = (await deps.groupNotifyApi.getSingleScreenNotifies(false, 50)).find(
        (item) => item.seq === messageId,
    );
    if (found === undefined) {
        throw new Error("群通知不存在");
    }
    return found;
}

/** GroupMember → Satori GuildMember（user.id = uin；nick = 群名片优先）。 */
function toGuildMember(member: GroupMember, uin: string): GuildMember {
    const nick = member.cardName !== "" ? member.cardName : member.nick;
    const out: GuildMember = {
        user: toUser(uin, member.nick),
    };
    if (nick !== "" && nick !== member.nick) {
        out.nick = nick;
    }
    return out;
}
