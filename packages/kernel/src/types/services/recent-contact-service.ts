/**
 * NodeIKernelRecentContactService：会话列表服务接口面（自研描述，非移植）
 *
 * 依据：getRecentContactService() 运行时反射（2026-10-31 实机探测方法面）+
 * wrapper 外部契约（接口签名是 QQ 的外部事实，自研描述其形状，零复制实现）。
 * 只收录 apis/recent-contact 当前需要的方法；其余按需探测后补齐。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** 会话联系人（getRecentContactList 项，说明书参考，待探测校准）。 */
export interface RecentContact {
    /** 会话 id（群场景 = 群号，好友场景 = uid）。 */
    peerUid: string;
    /** 会话类型（ChatType 值域）。 */
    chatType: number;
    /** 置顶标记（get_peer_pins 数据源；listener 实测字段名为 topFlag，1 = 置顶）。 */
    topFlag?: number;
    /** 置顶标记（布尔别名形态，兼容探测取值）。 */
    isTop?: boolean;
    /** 置顶时间（topFlag=1 时携带；2026-11-01 置顶实验实证为秒级 unix 字符串）。 */
    topFlagTime?: string;
    /** 对端 uin（部分返回形态带）。 */
    peerUin?: string;
    [key: string]: unknown;
}

/** 会话列表拉取参数（getRecentContactList，字段值待探测校准）。 */
export interface RecentContactFetchParam {
    /** 拉取条数（缺省覆盖置顶集合足够大）。 */
    count: number;
}

/** 会话列表服务：apis/recent-contact 与 RecentContactBridge 用到的核心方法面。 */
export interface NodeIKernelRecentContactService {
    /** 会话列表（get_peer_pins 数据源；返回形状待探测校准）。 */
    getRecentContactList(
        param: RecentContactFetchParam,
    ): Promise<GeneralCallResult & { result?: unknown }>;
    /** 注册会话列表监听（RecentContactBridge；录制实证方法名，listener 为普通 JS 对象）。 */
    addKernelRecentContactListener(listener: unknown): number;
    /** 注销会话列表监听。 */
    removeKernelRecentContactListener(listenerId: number): void;
}
