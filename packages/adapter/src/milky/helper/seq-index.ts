/**
 * MessageSeqIndex：message_seq ↔ msgId 双向映射（docs/protocols/milky.md §5 方案二）
 *
 * Milky 对外用会话内 message_seq（kernel RawMessage.msgSeq），NT 撤回/取消息入口
 * 是 msgId——两套 ID 空间都要用，这层跳不掉。接收链路 record（双向写入），
 * 动作侧 resolveMsgId 反查；反查不到由动作做历史扫描兜底（fetchMessages 近段匹配）。
 *
 * 容量封顶（FIFO 淘汰，Map 插入序 = 时间序）：映射只服务近期消息操作
 * （撤回 2 分钟窗口 / get_message 最近引用），不做全量持久索引。
 */
import type { ChatType, RawMessage } from "@napuketto/kernel";

/** 单方向最大条目数（测试用例引用容量语义）。 */
export const MAX_ENTRIES = 4096;

/** msgId → seq 元信息（collectReplyMeta 回填用）。 */
interface SeqMeta {
    seq: number;
    senderUin: string;
    timeSec: number;
}

/** 合并转发 resId → 定位信息（get_forwarded_messages 取 peer 用）。 */
export interface ForwardEntry {
    chatType: ChatType;
    peerUid: string;
    msgId: string;
}

export class MessageSeqIndex {
    /** `${chatType}:${peerUid}:${seq}` → msgId。 */
    private readonly seqToMsg = new Map<string, string>();
    /** msgId → seq 元信息。 */
    private readonly msgToMeta = new Map<string, SeqMeta>();
    /** 合并转发 resId → 定位信息（P1：get_forwarded_messages）。 */
    private readonly forwards = new Map<string, ForwardEntry>();

    /** 接收链路登记（一条消息双向写入；重复 msgId 覆盖）。 */
    record(msg: RawMessage): void {
        const seq = Number(msg.msgSeq);
        if (!Number.isFinite(seq) || seq < 0) {
            return;
        }
        this.seqToMsg.set(this.key(msg.chatType, msg.peerUid, seq), msg.msgId);
        this.msgToMeta.set(msg.msgId, {
            seq,
            senderUin: msg.senderUin,
            timeSec: Math.floor(Number(msg.msgTime) / 1000),
        });
        this.evict();
    }

    /** seq → msgId（反查；未登记返回 undefined）。 */
    resolveMsgId(chatType: ChatType, peerUid: string, seq: number): string | undefined {
        return this.seqToMsg.get(this.key(chatType, peerUid, seq));
    }

    /**
     * 批量回填 reply 引用元信息（msgId → Milky reply 段 data 所需三元组）。
     * 未命中的 id 不进表（翻译层按 0 兜底）。
     */
    collectReplyMeta(
        msgIds: string[],
    ): Map<string, { messageSeq: number; senderId: number; time: number }> {
        const out = new Map<string, { messageSeq: number; senderId: number; time: number }>();
        for (const id of msgIds) {
            const m = this.msgToMeta.get(id);
            if (m !== undefined) {
                out.set(id, {
                    messageSeq: m.seq,
                    senderId: Number(m.senderUin) || 0,
                    time: m.timeSec,
                });
            }
        }
        return out;
    }

    /** key 规则（chatType 数值 + peerUid + seq；peerUid 群聊=群号，C2C=uid）。 */
    private key(chatType: ChatType, peerUid: string, seq: number): string {
        return `${chatType}:${peerUid}:${seq}`;
    }

    /**
     * 登记合并转发（接收链路：消息含 multiForwardMsgElement 时调用）。
     * resId 是 Milky forward_id 的来源；同一 resId 重复覆盖。
     */
    recordForward(resId: string, entry: ForwardEntry): void {
        if (resId === "") {
            return;
        }
        this.forwards.set(resId, entry);
        while (this.forwards.size > MAX_ENTRIES) {
            const oldest = this.forwards.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.forwards.delete(oldest);
        }
    }

    /** resId → 转发定位（get_forwarded_messages；未登记返回 undefined）。 */
    resolveForward(resId: string): ForwardEntry | undefined {
        return this.forwards.get(resId);
    }

    /** FIFO 淘汰到容量上限内。 */
    private evict(): void {
        while (this.seqToMsg.size > MAX_ENTRIES) {
            const oldest = this.seqToMsg.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.seqToMsg.delete(oldest);
        }
        while (this.msgToMeta.size > MAX_ENTRIES) {
            const oldest = this.msgToMeta.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.msgToMeta.delete(oldest);
        }
    }
}
