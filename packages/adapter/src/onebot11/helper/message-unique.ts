/**
 * MessageUnique：OneBot message_id ↔ NT msgId 双向映射（协议相关）
 *
 * OB11 的 message_id 是 int32；NT msgId 是雪花字符串（如 "3071303571-1234567890"）。
 * 本类提供稳定双向映射：新消息分配递增 int32，消息事件翻译与 send_msg 返回都走这里，
 * 保证同一 NT 消息在协议侧拿到一致 message_id。
 *
 * 溢出（>2^31-1）后从头分配：优先复用已 release 的槽位（先检查释放池，再线性扫描）。
 */
import type { Peer } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";

/** OB11 message_id 上限（int32 max = 0x7FFF_FFFF）。 */
const INT32_MAX = 0x7f_ff_ff_ff;

/** int32 下限。 */
const INT32_MIN = 1;

export class MessageUnique {
    /** NT msgId → OB11 message_id。 */
    private readonly msgIdToInt = new Map<string, number>();
    /** OB11 message_id → NT msgId。 */
    private readonly intToMsgId = new Map<number, string>();
    /** NT msgId → Peer（delete_msg / get_msg 等只有 message_id 时反查用）。 */
    private readonly msgIdToPeer = new Map<string, Peer>();
    /** 递增计数器。 */
    private cursor = 1;
    /** 已释放的槽位（可复用）。 */
    private readonly freed = new Set<number>();

    /**
     * 为新 NT 消息分配 OB11 message_id（幂等：同一 msgId 返回同一 id）。
     * peer 可选：传入则记录，供 message_id → peer 反查。
     */
    alloc(msgId: string, peer?: Peer): number {
        const existing = this.msgIdToInt.get(msgId);
        if (existing !== undefined) {
            if (peer !== undefined) {
                this.msgIdToPeer.set(msgId, peer);
            }
            return existing;
        }
        const id = this.nextFreeId();
        this.msgIdToInt.set(msgId, id);
        this.intToMsgId.set(id, msgId);
        if (peer !== undefined) {
            this.msgIdToPeer.set(msgId, peer);
        }
        this.freed.delete(id);
        return id;
    }

    /** OB11 message_id → NT msgId。 */
    getMsgId(messageId: number): string | undefined {
        return this.intToMsgId.get(messageId);
    }

    /** NT msgId → OB11 message_id（未分配返回 undefined）。 */
    getMessageId(msgId: string): number | undefined {
        return this.msgIdToInt.get(msgId);
    }

    /** NT msgId → Peer（alloc 时未记录返回 undefined）。 */
    getPeer(msgId: string): Peer | undefined {
        return this.msgIdToPeer.get(msgId);
    }

    /** 释放 NT msgId 占用的槽位（消息过期/删除时调用，可选）。 */
    release(msgId: string): void {
        const id = this.msgIdToInt.get(msgId);
        if (id === undefined) {
            return;
        }
        this.msgIdToInt.delete(msgId);
        this.intToMsgId.delete(id);
        this.msgIdToPeer.delete(msgId);
        this.freed.add(id);
    }

    /** 取下一个可用 id：优先释放池，否则递增（溢出后线性扫描空洞）。 */
    private nextFreeId(): number {
        for (const id of this.freed) {
            return id;
        }
        if (this.cursor > INT32_MAX) {
            // 溢出：从头找空洞（O(n)，消息量级下可接受）
            for (let i = INT32_MIN; i <= INT32_MAX; i += 1) {
                if (!this.intToMsgId.has(i)) {
                    this.cursor = i + 1;
                    return i;
                }
            }
            throw kernelError("MessageUnique 槽位耗尽（>2^31 条消息）", "INVALID_STATE");
        }
        const id = this.cursor;
        this.cursor += 1;
        return id;
    }
}

/**
 * 从 OB11 message_id 反查 NT msgId + Peer。
 * delete_msg / get_msg / set_msg_emoji_like / fetch_ptt_text / 精华消息等
 * 只有 message_id 参数的动作共用（消息不存在抛 KernelError NOT_FOUND）。
 */
export function resolveMsgIdAndPeer(
    messageId: number | string,
    unique: MessageUnique,
): { msgId: string; peer: Peer } {
    let shortId: number;
    if (typeof messageId === "number") {
        shortId = messageId;
    } else {
        shortId = Number(messageId);
    }
    const msgId = unique.getMsgId(shortId);
    if (msgId === undefined) {
        throw kernelError(`消息 ${messageId} 不存在`, "NOT_FOUND");
    }
    const peer = unique.getPeer(msgId);
    if (peer === undefined) {
        throw kernelError(`消息 ${messageId} 无会话记录`, "NOT_FOUND");
    }
    return { msgId, peer };
}
