/**
 * 群管理域动作（2026-11-14 自 set-group-kick / set-group-ban / set-group-whole-ban /
 * set-group-admin / set-group-card / set-group-name / set-group-leave 合并）
 *
 * 踢人 / 单人与全员禁言 / 管理员 / 名片 / 群名 / 退群，均接 kernel GroupApi；
 * user_id（uin）→ uid 经 resolveUid。
 */

import { type GroupApi, kernelError, NTGroupMemberRole } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { resolveUid } from "../resolve-uid.js";

const setGroupKickSchema = z.object({
    group_id: z.number(),
    user_id: z.number(),
    /** 是否拒绝加群请求（拉黑）。 */
    reject_add_request: z.boolean().optional(),
    /** 踢人理由。 */
    kick_reason: z.string().optional(),
});

type SetGroupKickPayload = z.infer<typeof setGroupKickSchema>;

/** 群组踢人（P2-10 接 kernel kickMember）。 */
export class SetGroupKickAction extends BaseAction<SetGroupKickPayload, null> {
    readonly name = "set_group_kick";
    readonly schema = setGroupKickSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupKickPayload): Promise<null> {
        const uid = await this.resolveUid(payload.user_id);
        await this.groupApi.kickMember(
            String(payload.group_id),
            [uid],
            payload.reject_add_request === true,
            payload.kick_reason ?? "",
        );
        return null;
    }

    /** user_id（uin）→ uid。 */
    private async resolveUid(userId: number): Promise<string> {
        const uidMap = await this.groupApi.uinToUid([String(userId)]);
        const uid = uidMap.get(String(userId));
        if (uid === undefined) {
            throw kernelError(`用户 ${userId} 的 uid 解析失败`, "INVALID_PARAM");
        }
        return uid;
    }
}

/** 默认禁言时长（秒）。 */
const DEFAULT_BAN_DURATION = 30;

const setGroupBanSchema = z.object({
    group_id: z.number(),
    user_id: z.number(),
    /** 禁言时长（秒），0 解除。 */
    duration: z.number().default(DEFAULT_BAN_DURATION),
});

type SetGroupBanPayload = z.infer<typeof setGroupBanSchema>;

/** 群组单人禁言（P2-10 接 kernel setMemberShutUp）。 */
export class SetGroupBanAction extends BaseAction<SetGroupBanPayload, null> {
    readonly name = "set_group_ban";
    readonly schema = setGroupBanSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupBanPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), (uins) =>
            this.groupApi.uinToUid(uins),
        );
        await this.groupApi.setMemberShutUp(String(payload.group_id), [
            { uid, duration: payload.duration },
        ]);
        return null;
    }
}

const setGroupWholeBanSchema = z.object({
    group_id: z.number(),
    /** 是否开启全员禁言。 */
    enable: z.boolean().default(true),
});

type SetGroupWholeBanPayload = z.infer<typeof setGroupWholeBanSchema>;

/** 群组全员禁言（P2-10 接 kernel setGroupShutUp）。 */
export class SetGroupWholeBanAction extends BaseAction<SetGroupWholeBanPayload, null> {
    readonly name = "set_group_whole_ban";
    readonly schema = setGroupWholeBanSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupWholeBanPayload): Promise<null> {
        await this.groupApi.setGroupShutUp(String(payload.group_id), payload.enable);
        return null;
    }
}

const setGroupAdminSchema = z.object({
    group_id: z.number(),
    user_id: z.number(),
    /** 是否设为管理员。 */
    enable: z.boolean().default(true),
});

type SetGroupAdminPayload = z.infer<typeof setGroupAdminSchema>;

/** 设置群管理员（P2-10 接 kernel setMemberRole）。 */
export class SetGroupAdminAction extends BaseAction<SetGroupAdminPayload, null> {
    readonly name = "set_group_admin";
    readonly schema = setGroupAdminSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupAdminPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), (uins) =>
            this.groupApi.uinToUid(uins),
        );
        let role: NTGroupMemberRole = NTGroupMemberRole.MEMBER;
        if (payload.enable) {
            role = NTGroupMemberRole.ADMIN;
        }
        this.groupApi.setMemberRole(String(payload.group_id), uid, role);
        return null;
    }
}

const setGroupCardSchema = z.object({
    group_id: z.number(),
    user_id: z.number(),
    /** 群名片（空串清除）。 */
    card: z.string().optional().default(""),
});

type SetGroupCardPayload = z.infer<typeof setGroupCardSchema>;

/** 设置群名片（P2-10 接 kernel setMemberCardName）。 */
export class SetGroupCardAction extends BaseAction<SetGroupCardPayload, null> {
    readonly name = "set_group_card";
    readonly schema = setGroupCardSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupCardPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), (uins) =>
            this.groupApi.uinToUid(uins),
        );
        this.groupApi.setMemberCardName(String(payload.group_id), uid, payload.card);
        return null;
    }
}

const setGroupNameSchema = z.object({
    group_id: z.number(),
    group_name: z.string(),
});

type SetGroupNamePayload = z.infer<typeof setGroupNameSchema>;

/** 修改群名（P2-10 接 kernel modifyGroupName）。 */
export class SetGroupNameAction extends BaseAction<SetGroupNamePayload, null> {
    readonly name = "set_group_name";
    readonly schema = setGroupNameSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupNamePayload): Promise<null> {
        await this.groupApi.modifyGroupName(String(payload.group_id), payload.group_name);
        return null;
    }
}

const setGroupLeaveSchema = z.object({
    group_id: z.number(),
    /** 是否解散群（仅群主可用）。 */
    is_dismiss: z.boolean().optional().default(false),
});

type SetGroupLeavePayload = z.infer<typeof setGroupLeaveSchema>;

/** 退出群聊（P2-10 接 kernel quitGroup）。 */
export class SetGroupLeaveAction extends BaseAction<SetGroupLeavePayload, null> {
    readonly name = "set_group_leave";
    readonly schema = setGroupLeaveSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: SetGroupLeavePayload): Promise<null> {
        await this.groupApi.quitGroup(String(payload.group_id), payload.is_dismiss);
        return null;
    }
}

/**
 * 群管理域动作工厂（kick / ban / whole_ban / admin / card / name / leave）。
 */
export function createGroupManageActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new SetGroupKickAction(api.groupApi),
        new SetGroupBanAction(api.groupApi),
        new SetGroupWholeBanAction(api.groupApi),
        new SetGroupAdminAction(api.groupApi),
        new SetGroupCardAction(api.groupApi),
        new SetGroupNameAction(api.groupApi),
        new SetGroupLeaveAction(api.groupApi),
    ];
}
