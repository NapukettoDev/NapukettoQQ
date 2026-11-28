/**
 * GroupApi：群语义化 API（ADR-009 统一错误语义），内部解包原生返回，失败抛 KernelError。
 * 方法面：群列表 / 详情 / 成员 / uin↔uid + 群管（踢人 / 禁言 / 管理员 / 名片 / 群名 / 退群 / 精华 / @all）。
 */
import { NTEventChannel } from "../../infra/event-channel.js";
import {
    errorMessage,
    hasBooleanProp,
    hasNumberProp,
    isKernelError,
    isRecord,
    kernelError,
    requireKernelService,
} from "../../infra/index.js";
import type {
    Group,
    GroupBulletin,
    GroupDetailInfo,
    GroupMember,
    KickMemberV2Req,
    NodeIKernelGroupService,
    NodeIKernelMsgService,
    NodeIQQNTWrapperSession,
} from "../../types/index.js";
import { NTGroupMemberRole } from "../../types/index.js";
import { checkLooseResult, unwrap } from "../result.js";
import {
    deleteGroupAnnouncement,
    getGroupAnnouncements,
    publishGroupAnnouncement,
} from "./group-bulletin.js";
import { setGroupEssence } from "./group-essence.js";
import {
    extractGroupDetail,
    extractMemberInfos,
    memberListOf,
    toOptionalString,
    toResultNumber,
    toStringMap,
} from "./group-parsers.js";

/** 群 API：从 session 拿 group service，包装成语义化方法。 */
export class GroupApi {
    private readonly membershipEvents = new NTEventChannel<
        { quit: (groupCode: string) => void },
        "GroupMembership"
    >("GroupMembership");
    private readonly service: NodeIKernelGroupService;
    /** 精华消息需要 msg service（按 msgId 拉消息取 msgSeq/msgRandom）。 */
    private readonly msgService: NodeIKernelMsgService;

    constructor(session: NodeIQQNTWrapperSession) {
        this.service = requireKernelService(session.getGroupService(), "getGroupService", [
            "getGroupList",
            "getGroupDetailInfo",
            "getAllMemberList",
        ]);
        this.msgService = requireKernelService(session.getMsgService(), "getMsgService", [
            "getMsgsByMsgId",
        ]);
    }

    /**
     * 群列表（force=true 触发原生刷新）。
     *
     * @remarks
     * ⚠️ 本方法**只触发底层事件推送，返回值恒为 `[]`**——原生 getGroupList
     * 返回仅 `{ result, errMsg }`，列表数据经 onGroupListUpdate 事件推送。
     * 需要群列表数组请改用 `GroupCache.listGroups()`（缓存快照）或
     * `GroupCache.listGroupsRefreshed()`（触发刷新并等待事件落地）。
     * @see GroupCache.listGroupsRefreshed
     */
    async getGroupList(force = false): Promise<Group[]> {
        const raw = await this.service.getGroupList(force);
        if (raw.result !== 0) {
            unwrap("getGroupList", raw.result, raw.errMsg);
        }
        return [];
    }

    /** 群详情（groupCode 为群号字符串）。
     * getGroupDetailInfo 返回形状：失败 result=错误码；成功详情可能直接在 result
     * 对象里，也可能在 groupInfo/detailInfo 字段——三种形状都兼容（探测校准）。
     * result=0 时提取详情字段而非把 {result:0,errMsg} 当详情返回；形状异常抛 UNKNOWN。 */
    async getGroupInfo(groupCode: string): Promise<GroupDetailInfo> {
        const raw: unknown = await this.service.getGroupDetailInfo(groupCode, 0);
        if (!isRecord(raw)) {
            throw kernelError("getGroupDetailInfo 返回非对象结果", "INVALID_PARAM");
        }
        const result = raw["result"];
        const errMsg = typeof raw["errMsg"] === "string" ? raw["errMsg"] : "未知错误";
        if (typeof result === "number" && result !== 0) {
            unwrap("getGroupDetailInfo", result, errMsg);
        }
        const detail = extractGroupDetail(result, raw);
        if (detail === null) {
            throw kernelError(`getGroupDetailInfo 未返回群详情: ${errMsg}`, "INVALID_PARAM");
        }
        return detail;
    }

    /** 群成员列表（forceFetch=true 强制拉取，默认缓存优先）。 */
    async getGroupMemberList(groupCode: string, forceFetch = false): Promise<GroupMember[]> {
        const raw: unknown = await this.service.getAllMemberList(groupCode, forceFetch);
        return memberListOf(extractMemberInfos(raw));
    }

    /** 群成员详情（uids 为空返回空数组）。 */
    async getGroupMemberInfo(groupCode: string, uids: string[]): Promise<GroupMember[]> {
        if (uids.length === 0) {
            return [];
        }
        const raw: unknown = await this.service.getMemberInfo(groupCode, uids, true);
        if (!isRecord(raw)) {
            throw kernelError("getMemberInfo 返回非对象结果", "INVALID_PARAM");
        }
        unwrap("getMemberInfo", toResultNumber(raw["result"]), toOptionalString(raw["errMsg"]));
        // 返回形状待探测校准：infos Map<uid, GroupMember>（缺失按空列表兜底）
        const infos = raw["infos"];
        return infos instanceof Map ? memberListOf(infos) : [];
    }

    /** uin → uid（私聊发送等需要）。 */
    async uinToUid(uins: string[]): Promise<Map<string, string>> {
        if (uins.length === 0) {
            return new Map();
        }
        const raw: unknown = await this.service.getUidByUins(uins);
        if (!isRecord(raw)) {
            throw kernelError("getUidByUins 返回非对象结果", "INVALID_PARAM");
        }
        const errCode = toResultNumber(raw["errCode"]);
        if (errCode !== 0) {
            throw kernelError(
                `getUidByUins 失败: ${toOptionalString(raw["errMsg"]) ?? ""}`,
                "UNKNOWN",
            );
        }
        return toStringMap(raw["uids"]);
    }

    /** uid → uin。 */
    async uidToUin(uids: string[]): Promise<Map<string, string>> {
        if (uids.length === 0) {
            return new Map();
        }
        const raw: unknown = await this.service.getUinByUids(uids);
        if (!isRecord(raw)) {
            throw kernelError("getUinByUids 返回非对象结果", "INVALID_PARAM");
        }
        const errCode = toResultNumber(raw["errCode"]);
        if (errCode !== 0) {
            throw kernelError(
                `getUinByUids 失败: ${toOptionalString(raw["errMsg"]) ?? ""}`,
                "UNKNOWN",
            );
        }
        return toStringMap(raw["uins"]);
    }

    /** 群成员角色 → OB11 role 字符串。 */
    static roleToString(role: NTGroupMemberRole): "owner" | "admin" | "member" {
        if (role === NTGroupMemberRole.OWNER) {
            return "owner";
        }
        if (role === NTGroupMemberRole.ADMIN) {
            return "admin";
        }
        return "member";
    }

    /**
     * 踢人（set_group_kick）。memberUids 为成员 uid；refuseForever=true 拉黑拒绝再次入群。
     * kickMemberV2 的 kickFlag/kickList 字段值待实机校准。
     */
    async kickMember(
        groupCode: string,
        memberUids: string[],
        refuseForever: boolean,
        reason = "",
    ): Promise<void> {
        if (memberUids.length === 0) {
            throw kernelError("kickMember 需要至少一个成员 uid", "INVALID_PARAM");
        }
        // refuseForever=true 拒绝再次入群（optFlag 字段值待探测校准）
        let optFlag = 1;
        if (refuseForever) {
            optFlag = 0;
        }
        const req: KickMemberV2Req = {
            groupCode,
            kickFlag: 0,
            kickList: memberUids.map((uid) => ({
                optFlag,
                optOperate: 0,
                optMemberUid: uid,
                optBytesMsg: "",
            })),
            kickListUids: memberUids,
            kickMsg: reason,
        };
        const raw = await this.service.kickMemberV2(req);
        unwrap("kickMemberV2", raw.result, raw.errMsg);
    }

    /**
     * 成员禁言。
     *
     * @param members 每项 `duration` 单位为**秒（s）**，`0` 表示解除禁言。
     * @throws {KernelError} 成员列表为空（INVALID_PARAM）或原生调用失败。
     */
    async setMemberShutUp(
        groupCode: string,
        members: Array<{ uid: string; duration: number }>,
    ): Promise<void> {
        if (members.length === 0) {
            throw kernelError("setMemberShutUp 需要至少一个成员", "INVALID_PARAM");
        }
        if (members.some(({ duration }) => !Number.isSafeInteger(duration) || duration < 0)) {
            throw kernelError("禁言时长必须是非负整数秒，0 表示解除", "INVALID_PARAM");
        }
        const raw = await this.service.setMemberShutUp(
            groupCode,
            members.map((m) => ({ uid: m.uid, timeStamp: m.duration })),
        );
        unwrap("setMemberShutUp", raw.result, raw.errMsg);
    }

    /** 全员禁言（enable=true 开启全群禁言）。 */
    async setGroupShutUp(groupCode: string, enable: boolean): Promise<void> {
        const raw = await this.service.setGroupShutUp(groupCode, enable);
        unwrap("setGroupShutUp", raw.result, raw.errMsg);
    }

    /** 设置管理员（role=ADMIN 设管理，MEMBER 取消；void 语义乐观处理）。 */
    setMemberRole(groupCode: string, uid: string, role: NTGroupMemberRole): void {
        this.service.modifyMemberRole(groupCode, uid, role);
    }

    /** 设置群名片（void 语义乐观处理）。 */
    setMemberCardName(groupCode: string, uid: string, cardName: string): void {
        this.service.modifyMemberCardName(groupCode, uid, cardName);
    }

    /** 修改群名。 */
    async modifyGroupName(groupCode: string, groupName: string): Promise<void> {
        const raw = await this.service.modifyGroupName(groupCode, groupName, false);
        unwrap("modifyGroupName", raw.result, raw.errMsg);
    }

    /** 退群（needDeleteLocalMsg=is_dismiss：是否解散群，仅群主）。 */
    async quitGroup(groupCode: string, needDeleteLocalMsg = false): Promise<void> {
        const raw = await this.service.quitGroupV2({ groupCode, needDeleteLocalMsg });
        unwrap("quitGroupV2", raw.result, raw.errMsg);
        this.membershipEvents.emit("GroupMembership/quit", groupCode);
    }

    /** 订阅本实例成功完成的主动退群。 */
    onGroupQuit(listener: (groupCode: string) => void): () => void {
        return this.membershipEvents.on("GroupMembership/quit", listener);
    }

    /** 设置精华消息（msgId 经 msgService 取 msgSeq/msgRandom）。 */
    async addGroupEssence(groupCode: string, msgId: string): Promise<void> {
        await setGroupEssence(this.msgService, this.service, groupCode, msgId, true);
    }

    /** 取消精华消息。 */
    async removeGroupEssence(groupCode: string, msgId: string): Promise<void> {
        await setGroupEssence(this.msgService, this.service, groupCode, msgId, false);
    }

    /** 群公告列表（get_group_announcements）。 */
    async getGroupAnnouncements(groupCode: string): Promise<GroupBulletin[]> {
        return getGroupAnnouncements(this.service, groupCode);
    }

    /** 发群公告（send_group_announcement；imagePath 提供时先上传再带 picId 发布）。 */
    async publishGroupAnnouncement(
        groupCode: string,
        content: string,
        imagePath?: string,
    ): Promise<void> {
        return publishGroupAnnouncement(this.service, groupCode, content, imagePath);
    }

    /** 删群公告（delete_group_announcement）。 */
    async deleteGroupAnnouncement(groupCode: string, announcementId: string): Promise<void> {
        return deleteGroupAnnouncement(this.service, groupCode, announcementId);
    }

    /** 专属头衔（set_group_member_special_title；setIdentityTitleInfo 参数待校准）。 */
    async setMemberSpecialTitle(groupCode: string, uid: string, title: string): Promise<void> {
        try {
            checkLooseResult(
                "setIdentityTitleInfo",
                await this.service.setIdentityTitleInfo(groupCode, uid, title),
            );
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`setIdentityTitleInfo 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
    }

    /** 群头像（set_group_avatar；GroupService.setHeader 参数待校准）。 */
    async setGroupAvatar(groupCode: string, imagePath: string): Promise<void> {
        try {
            checkLooseResult("setHeader", await this.service.setHeader(groupCode, imagePath));
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`setHeader(group) 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
    }

    /** @all 剩余次数（get_group_at_all_remain）。 */
    async getGroupRemainAtTimes(groupCode: string): Promise<{
        canAtAll: boolean;
        remainAtAllCountForUin: number;
        remainAtAllCountForGroup: number;
    }> {
        const raw: unknown = await this.service.getGroupRemainAtTimes(groupCode);
        if (!isRecord(raw)) {
            throw kernelError("getGroupRemainAtTimes 返回非对象结果", "INVALID_PARAM");
        }
        const errCode = raw["errCode"];
        if (typeof errCode === "number" && errCode !== 0) {
            const msg = typeof raw["errMsg"] === "string" ? raw["errMsg"] : "未知错误";
            throw kernelError(`getGroupRemainAtTimes 失败: ${msg}`, "UNKNOWN");
        }
        const atInfo = raw["atInfo"];
        if (!isRecord(atInfo)) {
            throw kernelError("getGroupRemainAtTimes 未返回 atInfo", "INVALID_PARAM");
        }
        if (
            !hasBooleanProp(atInfo, "canAtAll") ||
            !hasNumberProp(atInfo, "remainAtAllCountForUin") ||
            !hasNumberProp(atInfo, "remainAtAllCountForGroup")
        ) {
            throw kernelError("getGroupRemainAtTimes 的 atInfo 字段不完整", "INVALID_PARAM");
        }
        return {
            canAtAll: atInfo["canAtAll"],
            remainAtAllCountForUin: atInfo["remainAtAllCountForUin"],
            remainAtAllCountForGroup: atInfo["remainAtAllCountForGroup"],
        };
    }
}
