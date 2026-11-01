/**
 * Listener 接口层（运行时探测产物 + 公开资料作说明书，ADR-003 / ADR-006）
 *
 * ⚠️ 部分方法签名为自研描述（wrapper 外部契约作依据理解 QQ），
 * 待下一次进程内探测（probe.ts）校准。事件名约定 `${Service}/${method}`，
 * 由 event-channel 从本接口编译期推导。
 */
import type { RawMessage } from "../entities.js";

/** 消息已读上报（peer + 已读 seq）。 */
export interface MsgReadReportItem {
    peer: unknown;
    readSeq: string;
}

/** 消息回执（msgId + 已读 seq）。 */
export interface MsgReceipt {
    msgId: string;
    readSeq: string;
}

/** 消息服务（MsgService）的原生回调监听接口。
 * 用 type 别名（非 interface）：需满足 ListenerShape（Record<string, unknown>）
 * 约束——interface 无隐式索引签名不兼容；type 对象类型天然满足。
 *
 * ⚠️ 2026-08-07 运行时探测实证（自建宿主，QQ 9.9.33）：onRecvMsg 回调参数是
 * **消息数组**（多条批量推送），非单条 RawMessage——此前单条签名错误（收到数组后
 * msg.msgId/elements 全 undefined）。信号链：原生回调 → MsgBridge 透传数组 →
 * 事件通道 → 订阅方遍历处理。 */
export type MsgListener = {
    /** 收到新消息（批量数组，运行时实证）。 */
    onRecvMsg: (msgs: RawMessage[]) => void;
    /** 消息已读上报。 */
    onRecvMsgReadReport: (reports: MsgReadReportItem[]) => void;
    /** 消息回执。 */
    onRecvMsgReceipt: (receipts: MsgReceipt[]) => void;
    /** 消息列表更新（含发送状态变化：sendStatus 0=失败 1=发送中 2=成功 3=成功无seq）。
     *  2026-08-11 补齐：sendMsg 发送结果以此事件为准（NapCat 同款），
     *  sendMsg 返回值 result 可能非 0 但实际发送成功（异步确认）。 */
    onMsgInfoListUpdate: (msgs: RawMessage[]) => void;
    /**
     * 收到离线文件消息（OB11 offline_file 事件源，2026-09-10 接线）。
     * 证据：wrapper.node 9.9.33-52230 字符串——小写名位于 listener 反射字符串簇
     * （与 onRecvMsg 同页，offset 差 ~7KB）+ RTTI
     * `OnRecvOfflineFileMsg@KernelMsgService@wrapper@nt`；API 族旁证
     * getNewOfflineFileList。2026-11-01 录制实证：参数 = RawMessage 数组
     * （chatType=1，fileElement 携带 fileUuid/file10MMd5 等）。
     */
    onRecvOfflineFileMsg: (msgs: RawMessage[]) => void;
    /**
     * 收到文件消息（onRecvOfflineFileMsg 同族；2026-11-01 录制实证：与
     * onRecvOfflineFileMsg 同载荷（RawMessage 数组）——friend_file_upload
     * 第二源，订阅方按 msgId 去重）。
     */
    onFileMsgCome: (msgs: RawMessage[]) => void;
    /**
     * 收到在线文件消息（onRecvOfflineFileMsg 同族，字符串簇相邻；
     * OB11 无对应通知类型，仅作校准观测）。参数形状待校准。
     */
    onRecvOnlineFileMsg: (arg: unknown) => void;
    /**
     * 收到系统消息（sys msg 总闸，2026-09-10 接线）：群名片/头衔/精华/荣誉等
     * 系统事件的根载体（二进制 55 个 OnSysMsg* 处理器；另有请求式
     * registerSysMsgNotification(type, subType, ids, callback) 需 3 参）。
     * 证据：小写名与 onRecvMsg 相邻（offset 差 ~1.4KB）+ 日志
     * `OnRecvSysMsg msg_type=0x{:x} sub_type=0x{:x} is_online={}`。
     * ⚠️ 参数形状待真实事件校准（unknown 透传，订阅方 raw 日志观测）。
     */
    onRecvSysMsg: (arg: unknown) => void;
};
