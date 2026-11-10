/**
 * RawMessage 数组规范化（OB11 / Satori 共用，2026-08-08 克隆合并）
 *
 * onRecvMsg 回调参数运行时实证为消息数组（2026-08-07），但兼容单条对象
 * 传入——统一规范化为数组并过滤无效项后逐条回调。
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
 * 发送者显示名（跨平台字段名不同，2026-11-10 Linux 原生 wrapper 实测）：
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
