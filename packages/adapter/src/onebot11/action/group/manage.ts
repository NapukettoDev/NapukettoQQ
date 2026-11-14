/**
 * 群管理域动作
 *
 * 踢人 / 单人与全员禁言 / 管理员 / 名片 / 群名 / 退群，均接 kernel GroupApi；
 * user_id（uin）→ uid 经 resolveUid。
 */
import { NTGroupMemberRole } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { defineOb11Action, type Ob11Action, resolveUid } from "../base-action.js";

/** 默认禁言时长（秒）。 */
const DEFAULT_BAN_DURATION = 30;

/** 群管理域动作工厂（kick / ban / whole_ban / admin / card / name / leave）。 */
/** uin → uid（groupApi.uinToUid 绑定视图；kernel 方法非箭头绑定）。 */
function memberUidOf(api: OneBotApi, uin: number): Promise<string> {
    return resolveUid(String(uin), (uins) => api.groupApi.uinToUid(uins));
}

export function createGroupManageActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "set_group_kick",
            schema: z.object({
                group_id: z.number(),
                user_id: z.number(),
                /** 是否拒绝加群请求（拉黑）。 */
                reject_add_request: z.boolean().optional(),
                /** 踢人理由。 */
                kick_reason: z.string().optional(),
            }),
            handle: async (payload) => {
                const uid = await memberUidOf(api, payload.user_id);
                await api.groupApi.kickMember(
                    String(payload.group_id),
                    [uid],
                    payload.reject_add_request === true,
                    payload.kick_reason ?? "",
                );
                return null;
            },
        }),
        defineOb11Action({
            name: "set_group_ban",
            schema: z.object({
                group_id: z.number(),
                user_id: z.number(),
                /** 禁言时长（秒），0 解除。 */
                duration: z.number().default(DEFAULT_BAN_DURATION),
            }),
            handle: async (payload) => {
                const uid = await memberUidOf(api, payload.user_id);
                await api.groupApi.setMemberShutUp(String(payload.group_id), [
                    { uid, duration: payload.duration },
                ]);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_group_whole_ban",
            schema: z.object({
                group_id: z.number(),
                /** 是否开启全员禁言。 */
                enable: z.boolean().default(true),
            }),
            handle: async (payload) => {
                await api.groupApi.setGroupShutUp(String(payload.group_id), payload.enable);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_group_admin",
            schema: z.object({
                group_id: z.number(),
                user_id: z.number(),
                /** 是否设为管理员。 */
                enable: z.boolean().default(true),
            }),
            handle: async (payload) => {
                const uid = await memberUidOf(api, payload.user_id);
                let role: NTGroupMemberRole = NTGroupMemberRole.MEMBER;
                if (payload.enable) {
                    role = NTGroupMemberRole.ADMIN;
                }
                api.groupApi.setMemberRole(String(payload.group_id), uid, role);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_group_card",
            schema: z.object({
                group_id: z.number(),
                user_id: z.number(),
                /** 群名片（空串清除）。 */
                card: z.string().optional().default(""),
            }),
            handle: async (payload) => {
                const uid = await memberUidOf(api, payload.user_id);
                api.groupApi.setMemberCardName(String(payload.group_id), uid, payload.card);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_group_name",
            schema: z.object({ group_id: z.number(), group_name: z.string() }),
            handle: async (payload) => {
                await api.groupApi.modifyGroupName(String(payload.group_id), payload.group_name);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_group_leave",
            schema: z.object({
                group_id: z.number(),
                /** 是否解散群（仅群主可用）。 */
                is_dismiss: z.boolean().optional().default(false),
            }),
            handle: async (payload) => {
                await api.groupApi.quitGroup(String(payload.group_id), payload.is_dismiss);
                return null;
            },
        }),
    ];
}
