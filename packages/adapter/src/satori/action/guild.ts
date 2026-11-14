/**
 * Satori 群组动作：guild.get / guild.list / guild.approve
 * + guild.member.get / list / kick / mute / approve
 * （role.set / role.unset / guild.role.*：501，见 registry）
 */
import type { GroupMember, GroupNotify } from "@napuketto/kernel";
import { NTGroupRequestOperateTypes } from "@napuketto/kernel";
import { z } from "zod";
import { findFirstMatch } from "../../core/shared/lookup.js";
import type { SatoriApi } from "../api/satori-api.js";
import { toGuild, toUser } from "../helper/index.js";
import type { Guild, GuildMember, List } from "../types/index.js";
import { BaseSatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type GuildActionDeps = Pick<
    SatoriApi,
    "groupApi" | "groupNotifyApi" | "uinToUid" | "uidToUin" | "groupCache"
>;

/** 成员列表默认条数。 */
const DEFAULT_MEMBER_LIMIT = 100;

/** guild.get 参数。 */
const guildGetSchema = z.object({
    guild_id: z.string(),
});

/** 获取群组。 */
export class GuildGetAction extends BaseSatoriAction<z.infer<typeof guildGetSchema>, Guild> {
    readonly name = "guild.get";
    readonly schema = guildGetSchema;
    private readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof guildGetSchema>): Promise<Guild> {
        const { guild_id: guildId } = payload;
        const detail = await this.deps.groupApi.getGroupInfo(guildId);
        return toGuild(detail.groupCode, detail.groupName);
    }
}

/** guild.list 参数。 */
const guildListSchema = z.object({
    next: z.string().optional(),
});

/** 获取群组列表。 */
export class GuildListAction extends BaseSatoriAction<
    z.infer<typeof guildListSchema>,
    List<Guild>
> {
    readonly name = "guild.list";
    readonly schema = guildListSchema;
    private readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: z.infer<typeof guildListSchema>): Promise<List<Guild>> {
        // 实测校准（2026-08-08）：原生 getGroupList 返回值无数据，列表经
        // onGroupListUpdate 事件推送 → GroupCache 维护；缓存为空时主动刷新回填。
        const groups =
            this.deps.groupCache === undefined
                ? await this.deps.groupApi.getGroupList(true)
                : await this.deps.groupCache.listGroupsRefreshed();
        const data: Guild[] = groups.map((g) => toGuild(g.groupCode, g.groupName));
        return { data };
    }
}

/** guild.approve 参数（处理入群邀请）。 */
const guildApproveSchema = z.object({
    message_id: z.string(),
    approve: z.boolean(),
    comment: z.string().optional(),
});

/** 群请求 approve 基类（guild.approve / guild.member.approve 共用实现）。 */
abstract class GroupRequestApproveBase extends BaseSatoriAction<
    z.infer<typeof guildApproveSchema>,
    void
> {
    readonly schema = guildApproveSchema;
    protected readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof guildApproveSchema>): Promise<void> {
        const { message_id: messageId, approve, comment } = payload;
        const notify = await findGroupNotify(this.deps, messageId);
        const operateType = approve
            ? NTGroupRequestOperateTypes.KAGREE
            : NTGroupRequestOperateTypes.KREFUSE;
        await this.deps.groupNotifyApi.handleGroupRequest(
            false,
            notify,
            operateType,
            comment ?? "",
        );
    }
}

/** 处理群邀请（message_id = 群通知 seq）。 */
export class GuildApproveAction extends GroupRequestApproveBase {
    readonly name = "guild.approve";
}

/** guild.member.get 参数。 */
const guildMemberGetSchema = z.object({
    guild_id: z.string(),
    user_id: z.string(),
});

/** 获取群成员。 */
export class GuildMemberGetAction extends BaseSatoriAction<
    z.infer<typeof guildMemberGetSchema>,
    GuildMember
> {
    readonly name = "guild.member.get";
    readonly schema = guildMemberGetSchema;
    private readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof guildMemberGetSchema>): Promise<GuildMember> {
        const { guild_id: guildId, user_id: userId } = payload;
        const uidMap = await this.deps.uinToUid([userId]);
        const uid = uidMap.get(userId) ?? userId;
        const member = await this.deps.groupCache?.getMember(guildId, uid);
        if (member !== undefined) {
            return toGuildMember(member, userId);
        }
        // 缓存未命中：直查原生（整群拉取后单查）
        const list = await this.deps.groupApi.getGroupMemberInfo(guildId, [uid]);
        const found = list.find((m) => m.uid === uid);
        if (found === undefined) {
            throw new Error("群成员不存在");
        }
        return toGuildMember(found, userId);
    }
}

/** guild.member.list 参数。 */
const guildMemberListSchema = z.object({
    guild_id: z.string(),
    next: z.string().optional(),
});

/** 获取群成员列表。 */
export class GuildMemberListAction extends BaseSatoriAction<
    z.infer<typeof guildMemberListSchema>,
    List<GuildMember>
> {
    readonly name = "guild.member.list";
    readonly schema = guildMemberListSchema;
    private readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(
        payload: z.infer<typeof guildMemberListSchema>,
    ): Promise<List<GuildMember>> {
        const { guild_id: guildId } = payload;
        let members: GroupMember[];
        const cached = await this.deps.groupCache?.getMembers(guildId);
        if (cached !== undefined && cached.length > 0) {
            members = cached;
        } else {
            members = await this.deps.groupApi.getGroupMemberList(guildId, true);
        }
        const limited = members.slice(0, DEFAULT_MEMBER_LIMIT);
        // 批量 uid → uin（user.id 规范为 uin）
        const uids = limited.map((m) => m.uid);
        const uinMap = await this.deps.uidToUin(uids);
        const data: GuildMember[] = limited.map((m) =>
            toGuildMember(m, uinMap.get(m.uid) ?? m.uin),
        );
        const out: List<GuildMember> = { data };
        if (members.length > DEFAULT_MEMBER_LIMIT) {
            out.next = String(DEFAULT_MEMBER_LIMIT);
        }
        return out;
    }
}

/** guild.member.kick 参数。 */
const guildMemberKickSchema = z.object({
    guild_id: z.string(),
    user_id: z.string(),
    /** 是否永久踢出（无法再次加入）。 */
    permanent: z.boolean().optional(),
});

/** 踢出群成员。 */
export class GuildMemberKickAction extends BaseSatoriAction<
    z.infer<typeof guildMemberKickSchema>,
    void
> {
    readonly name = "guild.member.kick";
    readonly schema = guildMemberKickSchema;
    private readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof guildMemberKickSchema>): Promise<void> {
        const { guild_id: guildId, user_id: userId, permanent } = payload;
        const uidMap = await this.deps.uinToUid([userId]);
        const uid = uidMap.get(userId) ?? userId;
        await this.deps.groupApi.kickMember(guildId, [uid], permanent === true);
    }
}

/** 毫秒 → 秒（QQ setMemberShutUp 单位；向下取整，0 解除禁言）。 */
function msToSeconds(ms: number): number {
    return Math.max(0, Math.floor(ms / 1000));
}

/** guild.member.mute 参数。 */
const guildMemberMuteSchema = z.object({
    guild_id: z.string(),
    user_id: z.string(),
    /** 禁言时长（毫秒，Satori 规范）；0 解除禁言。 */
    duration: z.number(),
});

/** 群成员禁言（Satori duration 毫秒 → kernel setMemberShutUp 秒）。 */
export class GuildMemberMuteAction extends BaseSatoriAction<
    z.infer<typeof guildMemberMuteSchema>,
    void
> {
    readonly name = "guild.member.mute";
    readonly schema = guildMemberMuteSchema;
    private readonly deps: GuildActionDeps;

    constructor(deps: GuildActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof guildMemberMuteSchema>): Promise<void> {
        const { guild_id: guildId, user_id: userId, duration } = payload;
        const uidMap = await this.deps.uinToUid([userId]);
        const uid = uidMap.get(userId) ?? userId;
        await this.deps.groupApi.setMemberShutUp(guildId, [
            { uid, duration: msToSeconds(duration) },
        ]);
    }
}

/** guild.member.approve 参数（处理加群申请）。 */
const guildMemberApproveSchema = z.object({
    message_id: z.string(),
    approve: z.boolean(),
    comment: z.string().optional(),
});

/** 处理加群申请（message_id = 群通知 seq）。 */
export class GuildMemberApproveAction extends GroupRequestApproveBase {
    readonly name = "guild.member.approve";
    override readonly schema = guildMemberApproveSchema;
}

/** 按 message_id（通知 seq）查找群通知（单屏非可疑；骨架走 core findFirstMatch）。 */
async function findGroupNotify(deps: GuildActionDeps, messageId: string): Promise<GroupNotify> {
    const found = await findFirstMatch(
        [() => deps.groupNotifyApi.getSingleScreenNotifies(false, 50)],
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
