/**
 * GroupApi：群语义化 API（ADR-009 统一错误语义）
 *
 * 内部解包原生返回：成功返回纯业务值，失败抛 KernelError。
 * 方法面（P2-4 + P2-10）：群列表 / 群详情 / 成员列表 / 成员详情 / uin↔uid +
 * 群管操作（踢人 / 禁言 / 管理员 / 名片 / 群名 / 退群 / 精华消息 / @all 剩余）。
 */
import { errorMessage, isKernelError, kernelError } from "../infra/index.js";
import type {
    Group,
    GroupBulletin,
    GroupDetailInfo,
    GroupMember,
    KickMemberV2Req,
    NodeIKernelGroupService,
    NodeIKernelMsgService,
    NodeIQQNTWrapperSession,
} from "../types/index.js";
import { ChatType, NTGroupMemberRole } from "../types/index.js";
import {
    hasBooleanProp,
    hasNumberProp,
    hasStringProp,
    isRecord,
    requireKernelService,
} from "../utils/type-guards.js";
import { checkLooseResult, unwrap } from "./result.js";

/** 群 API：从 session 拿 group service，包装成语义化方法。 */
export class GroupApi {
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
     * 2026-08-07 修复：成功（result=0）时不再把 {result:0,errMsg} 原样当详情返回，
     * 而是提取详情字段；形状异常抛 UNKNOWN 而非静默返回垃圾数据。 */
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
     * kickMemberV2 的 kickFlag/kickList 字段值待探测校准（TODO P3 联调）。
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
    }

    /** 设置精华消息（msgId 经 msgService 取 msgSeq/msgRandom）。 */
    async addGroupEssence(groupCode: string, msgId: string): Promise<void> {
        await this.setEssence(groupCode, msgId, true);
    }

    /** 取消精华消息。 */
    async removeGroupEssence(groupCode: string, msgId: string): Promise<void> {
        await this.setEssence(groupCode, msgId, false);
    }

    /** 精华消息公共流程：按 msgId 拉消息 → add/removeGroupEssence。 */
    private async setEssence(groupCode: string, msgId: string, add: boolean): Promise<void> {
        const peer = { chatType: ChatType.GROUP, peerUid: groupCode };
        const raw = await this.msgService.getMsgsByMsgId(peer, [msgId]);
        unwrap("getMsgsByMsgId", raw.result, raw.errMsg);
        const msg = raw.msgList?.[0];
        if (msg === undefined) {
            throw kernelError(`消息 ${msgId} 不存在`, "NOT_FOUND");
        }
        const param = {
            groupCode,
            msgRandom: Number(msg.msgRandom ?? 0),
            msgSeq: Number(msg.msgSeq),
        };
        let label = "removeGroupEssence";
        let res: unknown;
        if (add) {
            label = "addGroupEssence";
            res = await this.service.addGroupEssence(param);
        } else {
            res = await this.service.removeGroupEssence(param);
        }
        checkLooseResult(label, res);
    }

    /**
     * 群公告列表（get_group_announcements；getGroupBulletin 返回形状待探测校准，
     * 兼容 result 数组 / result.bulletins 等宽松提取）。
     */
    async getGroupAnnouncements(groupCode: string): Promise<GroupBulletin[]> {
        let raw: unknown;
        try {
            raw = await this.service.getGroupBulletin(groupCode);
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`getGroupBulletin 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
        const result = isRecord(raw) ? raw["result"] : undefined;
        const errMsg = isRecord(raw) ? toOptionalString(raw["errMsg"]) : undefined;
        unwrap("getGroupBulletin", toResultNumber(result), errMsg);
        return extractBulletins(result);
    }

    /**
     * 发群公告（send_group_announcement；imagePath 提供时先 uploadGroupBulletinPic
     * 再带 picId 发布——两步参数形状均待探测校准）。
     */
    async publishGroupAnnouncement(
        groupCode: string,
        content: string,
        imagePath?: string,
    ): Promise<void> {
        let picId: string | undefined;
        if (imagePath !== undefined && imagePath !== "") {
            picId = await this.uploadBulletinPic(groupCode, imagePath);
        }
        try {
            checkLooseResult(
                "publishGroupBulletin",
                await this.service.publishGroupBulletin({
                    groupCode,
                    content,
                    ...(picId !== undefined ? { picId } : {}),
                }),
            );
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`publishGroupBulletin 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
    }

    /** 删群公告（delete_group_announcement；参数待探测校准）。 */
    async deleteGroupAnnouncement(groupCode: string, announcementId: string): Promise<void> {
        try {
            checkLooseResult(
                "deleteGroupBulletin",
                await this.service.deleteGroupBulletin(groupCode, announcementId),
            );
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`deleteGroupBulletin 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
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

    /** 公告图片上传（uploadGroupBulletinPic 返回 picId 待校准，失败原样上抛）。 */
    private async uploadBulletinPic(groupCode: string, imagePath: string): Promise<string> {
        const res = await this.service.uploadGroupBulletinPic(groupCode, imagePath);
        checkLooseResult("uploadGroupBulletinPic", res);
        return isRecord(res) && typeof res["picId"] === "string" ? res["picId"] : "";
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

/** result 字段宽松取数（数字直接用，缺省 0 = 成功语义）。 */
function toResultNumber(result: unknown): number {
    return typeof result === "number" ? result : 0;
}

/** 未知值 → string | undefined（非字符串一律丢弃）。 */
function toOptionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** 字符串键值 Map 收窄（非 Map / 非 string 项丢弃，不做元素级强转）。 */
function toStringMap(value: unknown): Map<string, string> {
    const out = new Map<string, string>();
    if (!(value instanceof Map)) {
        return out;
    }
    for (const [key, val] of value) {
        if (typeof key === "string" && typeof val === "string") {
            out.set(key, val);
        }
    }
    return out;
}

/** 可选字段：缺失（undefined/null）放行，存在时必须是 string。 */
function isOptionalString(rec: Record<string, unknown>, key: string): boolean {
    const v = rec[key];
    return v === undefined || v === null || typeof v === "string";
}

/** 可选字段：缺失（undefined/null）放行，存在时必须是有限 number。 */
function isOptionalNumber(rec: Record<string, unknown>, key: string): boolean {
    const v = rec[key];
    return v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));
}

/** 群成员形状判定（uid + uin 必备；展示 / 角色字段缺失即合法，存在则须类型正确）。 */
function isGroupMember(val: unknown): val is GroupMember {
    return (
        isRecord(val) &&
        hasStringProp(val, "uid") &&
        hasStringProp(val, "uin") &&
        isOptionalString(val, "nick") &&
        isOptionalString(val, "cardName") &&
        isOptionalString(val, "remark") &&
        isOptionalString(val, "joinTime") &&
        isOptionalString(val, "lastSpeakTime") &&
        isOptionalNumber(val, "role") &&
        isOptionalNumber(val, "shutUpTime") &&
        isOptionalNumber(val, "sex") &&
        isOptionalNumber(val, "age")
    );
}

/** infos Map → 成员数组（逐项形状校验，非成员项丢弃）。 */
function memberListOf(infos: Map<unknown, unknown>): GroupMember[] {
    const out: GroupMember[] = [];
    for (const value of infos.values()) {
        if (isGroupMember(value)) {
            out.push(value);
        }
    }
    return out;
}

/** 群详情形状判定（标识 / 名称 / 成员数四要素齐备；群号标识字段可选校验）。 */
function isGroupDetailInfo(val: unknown): val is GroupDetailInfo {
    return (
        isRecord(val) &&
        hasStringProp(val, "groupCode") &&
        hasStringProp(val, "groupName") &&
        hasNumberProp(val, "memberNum") &&
        hasNumberProp(val, "maxMemberNum") &&
        isOptionalString(val, "groupUin") &&
        isOptionalString(val, "ownerUin")
    );
}

/**
 * 从 getAllMemberList 返回结构取出 infos Map。
 * 兼容 `{ infos }` 与 `{ result: { infos } }` 两种形状（探测期二者都出现过）；
 * 错误码非 0 抛 UNKNOWN，缺 infos 抛 INVALID_PARAM。
 */
function extractMemberInfos(raw: unknown): Map<unknown, unknown> {
    if (!isRecord(raw)) {
        throw kernelError("getAllMemberList 返回格式无效（非对象）", "INVALID_PARAM");
    }
    const code = toResultNumber(raw["errCode"]);
    if (code !== 0) {
        const msg = toOptionalString(raw["errMsg"]) ?? "未知错误";
        throw kernelError(`getAllMemberList 失败 (code=${code}): ${msg}`, "UNKNOWN");
    }
    const infos = raw["infos"];
    if (infos instanceof Map) {
        return infos;
    }
    const nested = raw["result"];
    if (isRecord(nested)) {
        const nestedInfos = nested["infos"];
        if (nestedInfos instanceof Map) {
            return nestedInfos;
        }
    }
    throw kernelError("getAllMemberList 返回结果缺失 infos Map", "INVALID_PARAM");
}

/** 公告列表宽松提取（result 数组 / { bulletins } / { result: 数组 } 兼容，形状待校准）。 */
function extractBulletins(result: unknown): GroupBulletin[] {
    const candidates: unknown[] = [result];
    if (isRecord(result)) {
        for (const key of ["bulletins", "announcementList", "result", "list"] as const) {
            candidates.push(result[key]);
        }
    }
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate.filter(isRecord);
        }
    }
    return [];
}

/**
 * 从 getGroupDetailInfo 返回提取群详情（兼容三种形状）：
 *  - result 为详情对象 → 直接返回
 *  - result 为 0/空 → 从 raw.groupInfo / detailInfo / info 提取
 * 提取不到（含数组 / 空对象 / 缺字段）返回 null，由调用方抛 KernelError。导出供单测。
 */
export function extractGroupDetail(result: unknown, raw: unknown): GroupDetailInfo | null {
    if (isGroupDetailInfo(result)) {
        return result;
    }
    if (!isRecord(raw)) {
        return null;
    }
    const candidate = raw["groupInfo"] ?? raw["detailInfo"] ?? raw["info"];
    return isGroupDetailInfo(candidate) ? candidate : null;
}
