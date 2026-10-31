/**
 * NodeIKernelGroupService：群服务接口面（自研描述，非移植）
 *
 * 依据：getGroupService() 运行时反射 + wrapper 外部契约（接口签名是 QQ 的外部事实，
 * 自研描述其形状，零复制实现）。
 * 只收录 apis/group 当前需要的方法；其余按需探测后补齐。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** 群成员角色（QQ wrapper 契约）。 */
export const NTGroupMemberRole = {
    UNSPECIFIED: 0,
    STRANGER: 1,
    MEMBER: 2,
    ADMIN: 3,
    OWNER: 4,
} as const;
export type NTGroupMemberRole = (typeof NTGroupMemberRole)[keyof typeof NTGroupMemberRole];

/** 踢人请求项（KickMemberV2Req.kickList 成员，说明书参考，字段值待探测校准）。 */
export interface KickMemberInfo {
    optFlag: number;
    optOperate: number;
    optMemberUid: string;
    optBytesMsg: string;
}

/** 踢人请求（set_group_kick 的 kickMemberV2 参数，说明书参考）。 */
export interface KickMemberV2Req {
    groupCode: string;
    kickFlag: number;
    kickList: KickMemberInfo[];
    kickListUids: string[];
    kickMsg: string;
}

/** @all 剩余次数（getGroupRemainAtTimes 返回）。 */
export interface GroupRemainAtTimes {
    canAtAll: boolean;
    remainAtAllCountForUin: number;
    remainAtAllCountForGroup: number;
    atTimesMsg: string;
    canNotAtAllMsg: string;
}

/** 群通知类型（GroupNotifyMsgType，说明书参考）。 */
export const GroupNotifyMsgType = {
    UN_SPECIFIED: 0,
    INVITED_BY_MEMBER: 1, // 邀请入群
    REFUSE_INVITED: 2,
    REFUSED_BY_ADMINI_STRATOR: 3,
    AGREED_TOJOIN_DIRECT: 4,
    INVITED_NEED_ADMINI_STRATOR_PASS: 5,
    AGREED_TO_JOIN_BY_ADMINI_STRATOR: 6,
    REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS: 7, // 申请入群
    SET_ADMIN: 8,
    KICK_MEMBER_NOTIFY_ADMIN: 9,
    KICK_MEMBER_NOTIFY_KICKED: 10,
    MEMBER_LEAVE_NOTIFY_ADMIN: 11,
    CANCEL_ADMIN_NOTIFY_CANCELED: 12,
    CANCEL_ADMIN_NOTIFY_ADMIN: 13,
    TRANSFER_GROUP_NOTIFY_OLDOWNER: 14,
    TRANSFER_GROUP_NOTIFY_ADMIN: 15,
} as const;
export type GroupNotifyMsgType = (typeof GroupNotifyMsgType)[keyof typeof GroupNotifyMsgType];

/** 群通知处理状态（GroupNotifyMsgStatus，说明书参考）。 */
export const GroupNotifyMsgStatus = {
    KINIT: 0,
    KUNHANDLE: 1, // 未处理
    KAGREED: 2,
    KREFUSED: 3,
    KIGNORED: 4,
} as const;
export type GroupNotifyMsgStatus = (typeof GroupNotifyMsgStatus)[keyof typeof GroupNotifyMsgStatus];

/** 群请求操作类型（NTGroupRequestOperateTypes，说明书参考）。 */
export const NTGroupRequestOperateTypes = {
    KUNSPECIFIED: 0,
    KAGREE: 1,
    KREFUSE: 2,
    KIGNORE: 3,
    KDELETE: 4,
} as const;
export type NTGroupRequestOperateTypes =
    (typeof NTGroupRequestOperateTypes)[keyof typeof NTGroupRequestOperateTypes];

/** 群通知（getSingleScreenNotifies 返回项，说明书参考，待探测校准）。 */
export interface GroupNotify {
    seq: string;
    type: GroupNotifyMsgType;
    status: GroupNotifyMsgStatus;
    group?: { groupCode: string; groupName: string };
    user1?: { uid: string; nickName: string };
    user2?: { uid: string; nickName: string };
    actionTime?: string;
    postscript?: string;
    warningTips?: string;
}

/** 禁言成员（getGroupShutUpMemberList 返回项，说明书参考，待探测校准）。 */
export interface ShutUpGroupMember {
    uid: string;
    qid: string;
    uin: string;
    nick: string;
    remark: string;
    cardName: string;
    shutUpTime: number;
    memberSpecialTitle?: string;
}

/** 群列表项（Group 实体，说明书参考）。 */
export interface Group {
    groupCode: string;
    groupName: string;
    memberCount: number;
    maxMember: number;
    remarkName?: string;
    groupOwnerId?: { memberUin: string; memberUid: string };
    memberRole?: number;
    isTop?: boolean;
    [key: string]: unknown;
}

/** 群详情（getGroupDetailInfo 返回，说明书参考）。 */
export interface GroupDetailInfo {
    groupCode: string;
    groupUin: string;
    ownerUin: string;
    ownerUid?: string;
    groupName: string;
    memberNum: number;
    maxMemberNum: number;
    remarkName?: string;
    isTop?: boolean;
    groupCreateTime?: number;
    [key: string]: unknown;
}

/** 群成员（getAllMemberList result.infos 的 value，说明书参考）。 */
export interface GroupMember {
    uid: string;
    uin: string;
    nick: string;
    cardName: string;
    remark: string;
    role: NTGroupMemberRole;
    shutUpTime: number; // 禁言秒数
    joinTime: string;
    lastSpeakTime: string;
    memberSpecialTitle?: string;
    sex?: number;
    age?: number;
    isRobot?: boolean;
    [key: string]: unknown;
}

/** 群公告（getGroupBulletin 返回项，说明书参考，待探测校准）。 */
export interface GroupBulletin {
    /** 公告 id（delete_group_announcement 的 announcement_id）。 */
    announcementId?: string;
    /** 发送者 uid。 */
    senderUid?: string;
    /** 发送时间（秒）。 */
    publishTime?: number;
    /** 文本内容。 */
    content?: string;
    /** 公告图片（url 待实机确认）。 */
    pic?: { url?: string; width?: number; height?: number; id?: string };
    [key: string]: unknown;
}

/** 群服务：apis/group 用到的核心方法面。 */
export interface NodeIKernelGroupService {
    addKernelGroupListener(listener: unknown): number;
    removeKernelGroupListener(listenerId: number): void;
    getGroupList(force: boolean): Promise<GeneralCallResult>;
    getGroupDetailInfo(groupCode: string, groupInfoSource: number): Promise<GeneralCallResult>;
    getAllMemberList(
        groupCode: string,
        forceFetch: boolean,
    ): Promise<{
        errCode: number;
        errMsg: string;
        result: {
            ids: Array<{ uid: string; index: number }>;
            infos: Map<string, GroupMember>;
            finish: boolean;
        };
    }>;
    getMemberInfo(
        groupCode: string,
        uids: string[],
        forceFetch: boolean,
    ): Promise<GeneralCallResult>;
    /** uin → uid（私聊发送等需要，说明书参考）。 */
    getUidByUins(
        uins: string[],
    ): Promise<{ errCode: number; errMsg: string; uids: Map<string, string> }>;
    /** uid → uin。 */
    getUinByUids(
        uids: string[],
    ): Promise<{ errCode: number; errMsg: string; uins: Map<string, string> }>;
    /** 踢人（set_group_kick）。 */
    kickMemberV2(param: KickMemberV2Req): Promise<GeneralCallResult>;
    /** 成员禁言（set_group_ban；timeStamp=0 解除禁言）。 */
    setMemberShutUp(
        groupCode: string,
        memberTimes: Array<{ uid: string; timeStamp: number }>,
    ): Promise<GeneralCallResult>;
    /** 全员禁言（set_group_whole_ban）。 */
    setGroupShutUp(groupCode: string, shutUp: boolean): Promise<GeneralCallResult>;
    /** 设置管理员（set_group_admin；void 语义，乐观处理）。 */
    modifyMemberRole(groupCode: string, uid: string, role: NTGroupMemberRole): void;
    /** 设置群名片（set_group_card；void 语义）。 */
    modifyMemberCardName(groupCode: string, uid: string, cardName: string): void;
    /** 修改群名（set_group_name）。 */
    modifyGroupName(
        groupCode: string,
        groupName: string,
        isNormalMember: boolean,
    ): Promise<GeneralCallResult>;
    /** 退群（set_group_leave）。 */
    quitGroupV2(param: {
        groupCode: string;
        needDeleteLocalMsg: boolean;
    }): Promise<GeneralCallResult>;
    /** 设置精华消息（msgSeq/msgRandom 取自消息本体）。 */
    addGroupEssence(param: {
        groupCode: string;
        msgRandom: number;
        msgSeq: number;
    }): Promise<unknown>;
    /** 取消精华消息。 */
    removeGroupEssence(param: {
        groupCode: string;
        msgRandom: number;
        msgSeq: number;
    }): Promise<unknown>;
    /** @all 剩余次数（get_group_at_all_remain）。 */
    getGroupRemainAtTimes(groupCode: string): Promise<
        Omit<GeneralCallResult, "result"> & {
            errCode: number;
            atInfo: GroupRemainAtTimes;
        }
    >;
    /** 单屏通知列表（get_group_system_msg / set_group_add_request 共用；列表可能走 listener，宽松解包）。 */
    getSingleScreenNotifies(
        doubt: boolean,
        startSeq: string,
        count: number,
    ): Promise<GeneralCallResult & { result?: unknown }>;
    /** 禁言成员列表（get_group_shut_list；同 listener 风格，宽松解包）。 */
    getGroupShutUpMemberList(groupCode: string): Promise<GeneralCallResult & { result?: unknown }>;
    /** 处理群请求（set_group_add_request 应答；postscript 空值可能导致失败，默认空格）。 */
    operateSysNotify(
        doubt: boolean,
        operateMsg: {
            operateType: NTGroupRequestOperateTypes;
            targetMsg: {
                seq: string;
                type: GroupNotifyMsgType;
                groupCode: string;
                postscript: string;
            };
        },
    ): Promise<void>;
    /** 群公告列表（get_group_announcements；返回形状待探测校准）。 */
    getGroupBulletin(groupCode: string): Promise<GeneralCallResult & { result?: unknown }>;
    /** 发群公告（send_group_announcement；参数形状待探测校准）。 */
    publishGroupBulletin(param: {
        groupCode: string;
        content: string;
        picId?: string;
    }): Promise<unknown>;
    /** 上传公告图片（image_uri 落盘后调用；返回 picId 待校准）。 */
    uploadGroupBulletinPic(groupCode: string, imagePath: string): Promise<unknown>;
    /** 删群公告（delete_group_announcement；参数待校准）。 */
    deleteGroupBulletin(groupCode: string, announcementId: string): Promise<unknown>;
    /** 专属头衔（set_group_member_special_title；待校准，备选 setGroupIdentitySpec）。 */
    setIdentityTitleInfo(groupCode: string, uid: string, title: string): Promise<unknown>;
    /** 群头像（set_group_avatar；参数待校准；Profile setHeader 同名方法）。 */
    setHeader(groupCode: string, imagePath: string): Promise<unknown>;
}
