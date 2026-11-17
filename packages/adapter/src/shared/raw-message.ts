/**
 * RawMessage 工具（跨协议共用）：onRecvMsg 参数规范化 + msgTime 单位归一 +
 * 启动前历史消息拦截。
 *
 * onRecvMsg 回调参数运行时实证为消息数组，但兼容单条对象传入——统一规范化
 * 为数组并过滤无效项后逐条回调。
 *
 * 启动前历史消息（issue #122）：登录 / 重连时 QQNT 会把离线与历史消息全量同步进
 * 回调，直接上报会让下游误回复几天前甚至几周前的消息。订阅时取一次基准时刻
 * （`startupBaselineSec`），早于基准的视为历史积压丢弃。
 */
import type { MsgEventChannel, RawMessage } from "@napuketto/kernel";
import { hasNumberProp, hasStringProp, isRecord } from "@napuketto/kernel";
import type { AdapterLoggerLike } from "./log.js";
import { startupBaselineSec } from "./startup-cutoff.js";
import { firstNonEmptyString } from "./text.js";

/**
 * 发送者显示名（跨平台字段名不同，Linux 原生 wrapper 实测）：
 *  - Windows：`sendNickName` = 昵称，`sendMemberName` = 群名片（可空）；
 *  - Linux：`sendNickName` 为空串，显示名放在 `sendMemberName`。
 * 优先昵称，空则回退群名片——否则 Linux 入站 `sender.nickname` 恒为空。
 */
export function senderNickname(msg: RawMessage): string {
    return firstNonEmptyString(msg.sendNickName, msg.sendMemberName) ?? "";
}

/**
 * RawMessage 形状守卫（onRecvMsg 参数是不可信的原生回调载荷）：
 * msgId / peerUid 为字符串、chatType 为有限数字、elements 为数组。
 */
export function isRawMessage(val: unknown): val is RawMessage {
    return (
        isRecord(val) &&
        hasStringProp(val, "msgId") &&
        hasStringProp(val, "peerUid") &&
        hasNumberProp(val, "chatType") &&
        Array.isArray(val["elements"])
    );
}

/** 逐条处理消息（自动规范化数组 + 逐项过 isRawMessage 过滤）。 */
export function forEachRawMessage(msgs: unknown, handler: (msg: RawMessage) => void): void {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    for (const msg of list) {
        if (!isRawMessage(msg)) {
            continue;
        }
        handler(msg);
    }
}

/** 订阅 Msg/onRecvMsg 选项。 */
export interface SubscribeRawMessagesOptions {
    /** 日志出口（缺省静默）：拦截条数按 debug 留痕。 */
    logger?: AdapterLoggerLike | undefined;
}

/**
 * 订阅 Msg/onRecvMsg（回调参数数组规范化为逐条 + 启动前历史消息拦截；
 * 返回退订函数，各协议适配器共用同一入口）。
 *
 * 基准时刻在订阅时算一次（含 5s 容差），因此 stop → start / 重连后退订重订会自然
 * 刷新基准，不会因进程跑得久而把新消息当历史。
 */
export function subscribeRawMessages(
    channel: MsgEventChannel,
    handler: (msg: RawMessage) => void,
    options: SubscribeRawMessagesOptions = {},
): () => void {
    const minMsgTimeSec = startupBaselineSec();
    return channel.on("Msg/onRecvMsg", (msgs) => {
        let skipped = 0;
        forEachRawMessage(msgs, (msg) => {
            if (!isLiveMessage(msg, minMsgTimeSec)) {
                skipped++;
                return;
            }
            handler(msg);
        });
        if (skipped > 0) {
            options.logger?.debug(
                { skipped, minMsgTimeSec },
                "adapter: 启动前历史消息已拦截（不计入收链路）",
            );
        }
    });
}

/** 毫秒阈值：1e12 秒 ≈ 公元 33658 年，真实毫秒时间戳必然大于它。 */
const MS_THRESHOLD = 1e12;

/**
 * msgTime → Unix 秒（按量级自动识别秒 / 毫秒）。
 * `RawMessage.msgTime` 的单位随平台 / wrapper 版本不一致：Windows QQNT 是
 * 毫秒字符串（13 位），Linux 3.2.x 原生 wrapper 是秒字符串（10 位）——不归一
 * 会让 Linux 事件时间再除一次 1000 退化成 1970。非法 / 空 / 非正 → 0
 * （调用方自行决定兜底策略）。
 */
export function toUnixSeconds(raw: string | number | undefined): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return 0;
    }
    return n >= MS_THRESHOLD ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * 消息是否为实时数据（早于基准 = 启动前历史积压）。
 * `msgTime` 缺失 / 非法（0）时放行：宁可多报一条，也不错杀实时消息。
 */
export function isLiveMessage(msg: RawMessage, minMsgTimeSec: number): boolean {
    const msgTimeSec = toUnixSeconds(msg.msgTime);
    return msgTimeSec === 0 || msgTimeSec >= minMsgTimeSec;
}
