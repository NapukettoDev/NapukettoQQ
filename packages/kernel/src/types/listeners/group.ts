/**
 * GroupListener：群服务（GroupService）的原生回调监听接口（运行时探测产物 + 公开资料作说明书，
 * ADR-003 / ADR-006）。签名依据 wrapper 外部契约自研描述（零复制）；事件名约定
 * `${Service}/${method}` 由 event-channel 编译期推导，用 type 别名以满足 ListenerShape 约束。
 */
import type {
    Group,
    GroupDetailInfo,
    GroupMember,
    GroupNotify,
    ShutUpGroupMember,
} from "../services/index.js";

/** 群列表更新类型（说明书参考，值待探测校准）。 */
export const GroupListUpdateType = {
    /** 全量更新（groupList 为完整列表）。 */
    ALL: 0,
    /** 增量更新（合并到现有缓存）。 */
    PARTIAL: 1,
} as const;
export type GroupListUpdateType = (typeof GroupListUpdateType)[keyof typeof GroupListUpdateType];

/** 成员数据来源（onMemberInfoChange 第二参，说明书参考）。 */
export const GroupMemberDataSource = {
    /** 本地缓存。 */
    CACHE: 0,
    /** 网络拉取。 */
    NETWORK: 1,
} as const;
export type GroupMemberDataSource =
    (typeof GroupMemberDataSource)[keyof typeof GroupMemberDataSource];

/** onMemberListChange 参数（sceneId 为群号 groupCode）。 */
export interface GroupMemberListChange {
    sceneId: string;
    ids: string[];
    /** uid → GroupMember。 */
    infos: Map<string, GroupMember>;
    hasPrev: boolean;
    hasNext: boolean;
    hasRobot: boolean;
}

/** 群服务（GroupService）的原生回调监听接口。 */
export type GroupListener = {
    /** 群列表初始化完成（listEmpty：是否无群）。 */
    onGroupListInited: (listEmpty: boolean) => void;
    /** 群列表更新。 */
    onGroupListUpdate: (updateType: GroupListUpdateType, groupList: Group[]) => void;
    /** 群详情变化。 */
    onGroupDetailInfoChange: (detailInfo: GroupDetailInfo) => void;
    /** 群成员列表变化（sceneId=groupCode）。 */
    onMemberListChange: (arg: GroupMemberListChange) => void;
    /** 群成员信息变化（dataSource 区分本地缓存/网络）。 */
    onMemberInfoChange: (
        groupCode: string,
        dataSource: GroupMemberDataSource,
        members: Map<string, GroupMember>,
    ) => void;
    /** 群通知更新（doubt：是否可疑/忽略列表）。 */
    onGroupNotifiesUpdated: (doubt: boolean, notifies: GroupNotify[]) => void;
    /** 群通知单屏（分页 seq）。 */
    onGroupSingleScreenNotifies: (doubt: boolean, seq: string, notifies: GroupNotify[]) => void;
    /** 群禁言成员列表变化。 */
    onShutUpMemberListChanged: (groupCode: string, members: ShutUpGroupMember[]) => void;
    /**
     * 群精华列表变化（OB11 group_essence 候选源）。
     * 证据：wrapper.node 9.9.33-52230 字符串——小写名位于 listener 反射字符串簇，
     * 与已知 onMemberListChange/onBuddyReqChange 交错（同一字符串表页）；
     * API 族旁证 addGroupEssence/getGroupLatestEssenceList。
     * ⚠️ 参数形状待真实事件校准（unknown 透传，订阅方 raw 日志观测）。
     */
    onGroupEssenceListChange: (arg: unknown) => void;
};
