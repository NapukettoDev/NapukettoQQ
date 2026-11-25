/**
 * 发送确认状态机 + msgId 时间戳生成。
 * sendMsg 的返回值不可信（result 可能为 5 但事件仍成功），发送结果以
 * `Msg/onMsgInfoListUpdate` 事件的 sendStatus 为准。
 */
import { kernelError } from "../../infra/index.js";
import type { MsgEventChannel } from "../../native/bridge/index.js";
import type { Peer, RawMessage } from "../../types/index.js";

/** 发送状态（onMsgInfoListUpdate 事件 msg.sendStatus）。 */
const SEND_STATUS = { FAILED: 0, SENDING: 1, SUCCESS: 2, SUCCESS_NO_SEQ: 3 } as const;

/** 发送确认超时（毫秒）。 */
const SEND_CONFIRM_TIMEOUT_MS = 15_000;

/**
 * msgId 时间戳生成器（单调递增）。
 * generateMsgUniqueId(chatType, time) 以 time 区分消息——同毫秒并发发送
 * （机器人群发/多会话同时回复）Date.now() 会碰撞，msgId 相同导致 wrapper
 * 拒绝或覆盖。严格单调递增保证进程内唯一。
 */
export class MsgIdSequencer {
    /** 上次生成 msgId 的时间（单调递增，防同毫秒并发碰撞）。 */
    private lastMsgTime = 0;

    next(): string {
        const now = Date.now();
        if (now > this.lastMsgTime) {
            this.lastMsgTime = now;
        } else {
            this.lastMsgTime += 1;
        }
        return String(this.lastMsgTime);
    }
}

/**
 * 注册 onMsgInfoListUpdate 确认监听。
 * resolve 时返回命中的那条消息（sendStatus 成功），发送失败/超时 reject。
 * channel 由调用方传入（sendMessage 已在无通道时提前返回，这里不做空判）。
 */
export function confirmSend(
    channel: MsgEventChannel,
    msgId: string,
    target: Peer,
): Promise<RawMessage> {
    return new Promise((resolve, reject) => {
        // 统一清理：退订 + 清定时器（三态终局都走这里，避免 15s 定时器泄漏）。
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = (): void => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            off();
        };
        const off = channel.on("Msg/onMsgInfoListUpdate", (list) => {
            const mine = list.find((m) => m.guildId === msgId);
            if (mine === undefined) {
                return; // 不是本次消息
            }
            if (
                mine.sendStatus === SEND_STATUS.SUCCESS ||
                mine.sendStatus === SEND_STATUS.SUCCESS_NO_SEQ
            ) {
                cleanup();
                resolve(mine);
            } else if (mine.sendStatus === SEND_STATUS.FAILED) {
                cleanup();
                reject(kernelError(`sendMsg 失败: sendStatus=${mine.sendStatus}`, "SEND_FAILED"));
            }
            // SENDING：继续等
        });
        // 超时兜底（不阻塞进程自然退出）
        timer = setTimeout(() => {
            cleanup();
            reject(
                kernelError(
                    `sendMsg 等待确认超时（msgId=${msgId}, target=${JSON.stringify(target)}）`,
                    "SEND_FAILED",
                ),
            );
        }, SEND_CONFIRM_TIMEOUT_MS);
        timer.unref?.();
    });
}
