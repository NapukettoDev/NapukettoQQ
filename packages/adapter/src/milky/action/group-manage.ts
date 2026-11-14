/**
 * Milky 群管理域动作（2026-11-14 自 group.ts 拆分，结构重构会话 4/5）
 *
 * 写操作合：群名/名片/管理员/禁言/踢出/退群 + 群头像/专属头衔/公告发布与
 * 删除/群戳一戳（P2 批次二）。成员类操作 user_id(uin) → uid 转换后进 kernel
 * （resolveUidFromUin）；公告 image_uri / 头像 image_uri 落盘后进 kernel。
 */
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { resolveUriToPath } from "../helper/message/media-uri.js";
import { MilkyApiAction } from "./base-action.js";

const groupIdField = { group_id: z.number().int().min(10001) } as const;
const userIdField = { user_id: z.number().int().min(10001) } as const;
const optBool = z.boolean().nullable().optional();
const optStr = z.string().nullable().optional();

/** NTGroupMemberRole 数值（ADMIN=3 / MEMBER=2，setMemberRole 入参）。 */
const NTGroupMemberRoleAdmin = 3;
const NTGroupMemberRoleMember = 2;

/** send_group_nudge：发送群戳一戳（self.uid 缺失报 INVALID_PARAM）。 */
export class SendGroupNudgeAction extends MilkyApiAction<
    { group_id: number; user_id: number },
    Record<string, never>
> {
    readonly name = "send_group_nudge";
    readonly schema = z.object({ ...groupIdField, ...userIdField });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
    }): Promise<Record<string, never>> {
        const receiverUid = await this.api.resolveUidFromUin(payload.user_id);
        const peer = await this.api.resolvePeer("group", payload.group_id);
        await this.api.msgApi.sendNudge(peer, {
            receiverUid,
            callerUid: requireSelfUid(this.api),
        });
        return {};
    }
}

/** set_group_name：设置群名。 */
export class SetGroupNameAction extends MilkyApiAction<
    { group_id: number; new_group_name: string },
    Record<string, never>
> {
    readonly name = "set_group_name";
    readonly schema = z.object({ ...groupIdField, new_group_name: z.string() });

    protected async _handle(payload: {
        group_id: number;
        new_group_name: string;
    }): Promise<Record<string, never>> {
        await this.api.groupApi.modifyGroupName(String(payload.group_id), payload.new_group_name);
        return {};
    }
}

/** set_group_member_card：设置群名片。 */
export class SetGroupMemberCardAction extends MilkyApiAction<
    { group_id: number; user_id: number; card: string },
    Record<string, never>
> {
    readonly name = "set_group_member_card";
    readonly schema = z.object({ ...groupIdField, ...userIdField, card: z.string() });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        card: string;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        this.api.groupApi.setMemberCardName(String(payload.group_id), uid, payload.card);
        return {};
    }
}

/** set_group_member_admin：设置/取消管理员（is_set 缺省 true）。 */
export class SetGroupMemberAdminAction extends MilkyApiAction<
    { group_id: number; user_id: number; is_set?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_member_admin";
    readonly schema = z.object({ ...groupIdField, ...userIdField, is_set: optBool });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        is_set?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        this.api.groupApi.setMemberRole(
            String(payload.group_id),
            uid,
            payload.is_set === false ? NTGroupMemberRoleMember : NTGroupMemberRoleAdmin,
        );
        return {};
    }
}

/** set_group_member_mute：禁言成员（duration 秒，0 解除）。 */
export class SetGroupMemberMuteAction extends MilkyApiAction<
    { group_id: number; user_id: number; duration?: number | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_member_mute";
    readonly schema = z.object({
        ...groupIdField,
        ...userIdField,
        duration: z.number().int().min(0).nullable().optional(),
    });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        duration?: number | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.groupApi.setMemberShutUp(String(payload.group_id), [
            { uid, duration: payload.duration ?? 0 },
        ]);
        return {};
    }
}

/** set_group_whole_mute：全员禁言开关（is_mute 缺省 true）。 */
export class SetGroupWholeMuteAction extends MilkyApiAction<
    { group_id: number; is_mute?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_whole_mute";
    readonly schema = z.object({ ...groupIdField, is_mute: optBool });

    protected async _handle(payload: {
        group_id: number;
        is_mute?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        await this.api.groupApi.setGroupShutUp(String(payload.group_id), payload.is_mute !== false);
        return {};
    }
}

/** kick_group_member：移除成员（reject_add_request 默认 false）。 */
export class KickGroupMemberAction extends MilkyApiAction<
    { group_id: number; user_id: number; reject_add_request?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "kick_group_member";
    readonly schema = z.object({
        ...groupIdField,
        ...userIdField,
        reject_add_request: optBool,
    });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        reject_add_request?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.groupApi.kickMember(
            String(payload.group_id),
            [uid],
            payload.reject_add_request === true,
        );
        return {};
    }
}

/** quit_group：退出群聊。 */
export class QuitGroupAction extends MilkyApiAction<{ group_id: number }, Record<string, never>> {
    readonly name = "quit_group";
    readonly schema = z.object({ ...groupIdField });

    protected async _handle(payload: { group_id: number }): Promise<Record<string, never>> {
        await this.api.groupApi.quitGroup(String(payload.group_id));
        return {};
    }
}

/** set_group_avatar：设置群头像（image_uri → 本地路径）。 */
export class SetGroupAvatarAction extends MilkyApiAction<
    { group_id: number; image_uri: string },
    Record<string, never>
> {
    readonly name = "set_group_avatar";
    readonly schema = z.object({ ...groupIdField, image_uri: z.string().min(1) });

    protected async _handle(payload: {
        group_id: number;
        image_uri: string;
    }): Promise<Record<string, never>> {
        const imagePath = await resolveUriToPath(payload.image_uri, this.api.mediaDir);
        await this.api.groupApi.setGroupAvatar(String(payload.group_id), imagePath);
        return {};
    }
}

/** set_group_member_special_title：设置专属头衔（uin → uid）。 */
export class SetGroupMemberSpecialTitleAction extends MilkyApiAction<
    { group_id: number; user_id: number; special_title: string },
    Record<string, never>
> {
    readonly name = "set_group_member_special_title";
    readonly schema = z.object({
        ...groupIdField,
        ...userIdField,
        special_title: z.string(),
    });

    protected async _handle(payload: {
        group_id: number;
        user_id: number;
        special_title: string;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.groupApi.setMemberSpecialTitle(
            String(payload.group_id),
            uid,
            payload.special_title,
        );
        return {};
    }
}

/** send_group_announcement：发群公告（image_uri 落盘后经上传+发布两步）。 */
export class SendGroupAnnouncementAction extends MilkyApiAction<
    { group_id: number; content: string; image_uri?: string | null | undefined },
    Record<string, never>
> {
    readonly name = "send_group_announcement";
    readonly schema = z.object({ ...groupIdField, content: z.string().min(1), image_uri: optStr });

    protected async _handle(payload: {
        group_id: number;
        content: string;
        image_uri?: string | null | undefined;
    }): Promise<Record<string, never>> {
        const groupCode = String(payload.group_id);
        let imagePath: string | undefined;
        if (
            payload.image_uri !== undefined &&
            payload.image_uri !== null &&
            payload.image_uri !== ""
        ) {
            imagePath = await resolveUriToPath(payload.image_uri, this.api.mediaDir);
        }
        await this.api.groupApi.publishGroupAnnouncement(groupCode, payload.content, imagePath);
        return {};
    }
}

/** delete_group_announcement：删除群公告。 */
export class DeleteGroupAnnouncementAction extends MilkyApiAction<
    { group_id: number; announcement_id: string },
    Record<string, never>
> {
    readonly name = "delete_group_announcement";
    readonly schema = z.object({ ...groupIdField, announcement_id: z.string().min(1) });

    protected async _handle(payload: {
        group_id: number;
        announcement_id: string;
    }): Promise<Record<string, never>> {
        await this.api.groupApi.deleteGroupAnnouncement(
            String(payload.group_id),
            payload.announcement_id,
        );
        return {};
    }
}

/** ---------- 内部辅助 ---------- */

/** self.uid 必备（nudge 发送的 callerUid；缺配置报 INVALID_PARAM）。 */
function requireSelfUid(api: MilkyApi): string {
    const uid = api.self.uid;
    if (uid === undefined || uid === "") {
        throw kernelError("登录身份缺 uid（无法发起戳一戳）", "INVALID_PARAM");
    }
    return uid;
}
