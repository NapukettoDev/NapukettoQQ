/**
 * NodeIKernelBuddyService：好友服务接口面（自研描述，非移植）。
 * 依据 getBuddyService() 运行时反射 + wrapper 外部契约（接口签名是 QQ 的外部事实，零复制）；
 * 只收录 apis/friend 当前需要的方法，其余按需探测后补齐。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** 好友核心信息（BuddyListEntry.coreInfo，实测）。 */
export interface BuddyCoreInfo {
    uid: string;
    uin: string;
    nick?: string;
    remark?: string;
    [key: string]: unknown;
}

/** 好友列表明细（BuddyCategory.buddyList 成员，实测快照）。 */
export interface BuddyListEntry {
    uid: string;
    /** 顶层 uin（coreInfo.uin 同值；缺失时回退 coreInfo）。 */
    uin?: string;
    coreInfo?: BuddyCoreInfo;
    baseInfo?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * 好友列表分类（getBuddyListV2 返回 / onBuddyListChange 全量快照载荷）。
 * ⚠️ 实测：onBuddyListChange 载荷 = BuddyCategory[]，分类项含 buddyList 明细
 * （uid/uin/coreInfo/baseInfo）；实测样本无 buddyUids——两字段均按 optional 防御。
 */
export interface BuddyCategory {
    categoryId: number;
    categorySortId: number;
    categroyName: string;
    categroyMbCount: number;
    onlineCount: number;
    buddyUids?: string[];
    /** 好友明细（onBuddyListChange 快照，实测）。 */
    buddyList?: BuddyListEntry[];
}

/** 好友申请（getBuddyReq 返回的 buddyReqs 成员，说明书参考，待探测校准）。 */
export interface BuddyReq {
    reqTime: string;
    friendUid: string;
    friendNick?: string;
    sourceId?: number;
    sourceName?: string;
    [key: string]: unknown;
}

/** 可疑好友申请（getDoubtBuddyReq 返回的 doubtList 成员，说明书参考）。 */
export interface DoubtBuddyReq {
    uid: string;
    nick?: string;
    source?: string;
    reason?: string;
    msg?: string;
    groupCode?: string;
    reqTime?: string;
    [key: string]: unknown;
}

/** 好友服务：apis/friend 用到的核心方法面。 */
export interface NodeIKernelBuddyService {
    addKernelBuddyListener(listener: unknown): number;
    removeKernelBuddyListener(listenerId: number): void;
    getBuddyListV2(
        callFrom: string,
        isPullRefresh: boolean,
        reqType: number,
    ): Promise<GeneralCallResult & { data: BuddyCategory[] }>;
    getBuddyListFromCache(reqType: number): Promise<BuddyCategory[]>;
    getBuddyNick(uid: string): string;
    getBuddyRemark(uid: string): string;
    isBuddy(uid: string): boolean;
    /** 好友申请列表（set_friend_add_request 应答前查找匹配项）。 */
    getBuddyReq(): Promise<GeneralCallResult & { buddyReqs?: BuddyReq[] }>;
    /** 同意/拒绝加好友请求（set_friend_add_request）。 */
    approvalFriendRequest(arg: {
        friendUid: string;
        reqTime: string;
        accept: boolean;
    }): Promise<void>;
    /** 设置好友备注（set_friend_remark；void 语义乐观处理）。 */
    setBuddyRemark(param: { uid: string; remark: string }): void;
    /** 删除好友（delete_friend）。 */
    delBuddy(param: {
        friendUid: string;
        tempBlock: boolean;
        tempBothDel: boolean;
    }): Promise<unknown>;
    /** 可疑好友申请列表（get_doubt_friends_add_request；reqId 作回执匹配）。 */
    getDoubtBuddyReq(
        reqId: string,
        num: number,
        uk: string,
    ): Promise<GeneralCallResult & { doubtList?: DoubtBuddyReq[] }>;
    /** 处理可疑好友申请（set_doubt_friends_add_request；str1/str2 语义未知，传空串）。 */
    approvalDoubtBuddyReq(uid: string, str1: string, str2: string): void;
}
