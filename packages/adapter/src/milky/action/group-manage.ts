/**
 * Milky 群管理域动作：send_group_nudge / set_group_name / set_group_member_card /
 * set_group_member_admin / set_group_member_mute / set_group_whole_mute /
 * kick_group_member / quit_group / set_group_avatar /
 * set_group_member_special_title / send_group_announcement / delete_group_announcement。
 * 写操作合：成员类操作 user_id(uin) → uid 转换后进 kernel（resolveUidFromUin）；
 * 公告 image_uri / 头像 image_uri 落盘后进 kernel。
 */
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { resolveUriToPath } from "../helper/message/media-uri.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";
import { groupIdField, optBool, userIdField } from "./group-query.js";

const optStr = z.string().nullable().optional();

/** NTGroupMemberRole 数值（ADMIN=3 / MEMBER=2，setMemberRole 入参）。 */
const NTGroupMemberRoleAdmin = 3;
const NTGroupMemberRoleMember = 2;

/** 群管理域动作工厂（群设置 / 成员管理 / 公告 / 戳一戳）。 */
export function createGroupManageActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "send_group_nudge",
            schema: z.object({ ...groupIdField, ...userIdField }),
            // self.uid 缺失报 INVALID_PARAM
            handle: async (payload: { group_id: number; user_id: number }) => {
                const receiverUid = await api.resolveUidFromUin(payload.user_id);
                const peer = await api.resolvePeer("group", payload.group_id);
                await api.msgApi.sendNudge(peer, {
                    receiverUid,
                    callerUid: requireSelfUid(api),
                });
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_name",
            schema: z.object({ ...groupIdField, new_group_name: z.string() }),
            handle: async (payload: { group_id: number; new_group_name: string }) => {
                await api.groupApi.modifyGroupName(
                    String(payload.group_id),
                    payload.new_group_name,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_member_card",
            schema: z.object({ ...groupIdField, ...userIdField, card: z.string() }),
            handle: async (payload: { group_id: number; user_id: number; card: string }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                api.groupApi.setMemberCardName(String(payload.group_id), uid, payload.card);
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_member_admin",
            schema: z.object({ ...groupIdField, ...userIdField, is_set: optBool }),
            // is_set 缺省 true
            handle: async (payload: {
                group_id: number;
                user_id: number;
                is_set?: boolean | null | undefined;
            }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                api.groupApi.setMemberRole(
                    String(payload.group_id),
                    uid,
                    payload.is_set === false ? NTGroupMemberRoleMember : NTGroupMemberRoleAdmin,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_member_mute",
            schema: z.object({
                ...groupIdField,
                ...userIdField,
                duration: z.number().int().min(0).nullable().optional(),
            }),
            // duration 秒，0 解除
            handle: async (payload: {
                group_id: number;
                user_id: number;
                duration?: number | null | undefined;
            }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                await api.groupApi.setMemberShutUp(String(payload.group_id), [
                    { uid, duration: payload.duration ?? 0 },
                ]);
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_whole_mute",
            schema: z.object({ ...groupIdField, is_mute: optBool }),
            // is_mute 缺省 true
            handle: async (payload: { group_id: number; is_mute?: boolean | null | undefined }) => {
                await api.groupApi.setGroupShutUp(
                    String(payload.group_id),
                    payload.is_mute !== false,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "kick_group_member",
            schema: z.object({
                ...groupIdField,
                ...userIdField,
                reject_add_request: optBool,
            }),
            // reject_add_request 默认 false
            handle: async (payload: {
                group_id: number;
                user_id: number;
                reject_add_request?: boolean | null | undefined;
            }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                await api.groupApi.kickMember(
                    String(payload.group_id),
                    [uid],
                    payload.reject_add_request === true,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "quit_group",
            schema: z.object({ ...groupIdField }),
            handle: async (payload: { group_id: number }) => {
                await api.groupApi.quitGroup(String(payload.group_id));
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_avatar",
            schema: z.object({ ...groupIdField, image_uri: z.string().min(1) }),
            // image_uri → 本地路径
            handle: async (payload: { group_id: number; image_uri: string }) => {
                const imagePath = await resolveUriToPath(payload.image_uri, api.mediaDir);
                await api.groupApi.setGroupAvatar(String(payload.group_id), imagePath);
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_group_member_special_title",
            schema: z.object({
                ...groupIdField,
                ...userIdField,
                special_title: z.string(),
            }),
            // uin → uid
            handle: async (payload: {
                group_id: number;
                user_id: number;
                special_title: string;
            }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                await api.groupApi.setMemberSpecialTitle(
                    String(payload.group_id),
                    uid,
                    payload.special_title,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "send_group_announcement",
            schema: z.object({ ...groupIdField, content: z.string().min(1), image_uri: optStr }),
            // image_uri 落盘后经上传+发布两步
            handle: async (payload: {
                group_id: number;
                content: string;
                image_uri?: string | null | undefined;
            }) => {
                const groupCode = String(payload.group_id);
                let imagePath: string | undefined;
                if (
                    payload.image_uri !== undefined &&
                    payload.image_uri !== null &&
                    payload.image_uri !== ""
                ) {
                    imagePath = await resolveUriToPath(payload.image_uri, api.mediaDir);
                }
                await api.groupApi.publishGroupAnnouncement(groupCode, payload.content, imagePath);
                return {};
            },
        }),
        defineMilkyAction({
            name: "delete_group_announcement",
            schema: z.object({ ...groupIdField, announcement_id: z.string().min(1) }),
            handle: async (payload: { group_id: number; announcement_id: string }) => {
                await api.groupApi.deleteGroupAnnouncement(
                    String(payload.group_id),
                    payload.announcement_id,
                );
                return {};
            },
        }),
    ];
}

/** self.uid 必备（nudge 发送的 callerUid；缺配置报 INVALID_PARAM）。 */
function requireSelfUid(api: MilkyApi): string {
    const uid = api.self.uid;
    if (uid === undefined || uid === "") {
        throw kernelError("登录身份缺 uid（无法发起戳一戳）", "INVALID_PARAM");
    }
    return uid;
}
