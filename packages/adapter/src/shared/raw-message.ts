/**
 * RawMessage 工具（跨协议共用）：onRecvMsg 参数规范化 + msgTime 单位归一。
 *
 * onRecvMsg 回调参数运行时实证为消息数组，但兼容单条对象传入——统一规范化
 * 为数组并过滤无效项后逐条回调。
 */
import type { MsgEventChannel, RawMessage } from "@napuketto/kernel";

/** 空串视为缺失（Linux 原生对象常给 "" 而不是省略字段）。 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
    for (const value of values) {
        if (value !== undefined && value !== "") {
            return value;
        }
    }
    return undefined;
}

/**
 * 发送者显示名（跨平台字段名不同，Linux 原生 wrapper 实测）：
 *  - Windows：`sendNickName` = 昵称，`sendMemberName` = 群名片（可空）；
 *  - Linux：`sendNickName` 为空串，显示名放在 `sendMemberName`。
 * 优先昵称，空则回退群名片——否则 Linux 入站 `sender.nickname` 恒为空。
 */
export function senderNickname(msg: RawMessage): string {
    return firstNonEmpty(msg.sendNickName, msg.sendMemberName) ?? "";
}

/** 逐条处理消息（自动规范化数组 + 过滤非对象项）。 */
export function forEachRawMessage(msgs: unknown, handler: (msg: RawMessage) => void): void {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    for (const msg of list) {
        if (!msg || typeof msg !== "object") {
            continue;
        }
        handler(msg as RawMessage);
    }
}

/** 订阅 Msg/onRecvMsg（回调参数数组规范化为逐条；返回退订函数，各协议适配器共用）。 */
export function subscribeRawMessages(
    channel: MsgEventChannel,
    handler: (msg: RawMessage) => void,
): () => void {
    return channel.on("Msg/onRecvMsg", (msgs) => {
        forEachRawMessage(msgs, handler);
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
