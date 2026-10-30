/**
 * MessageSeqIndex 基线测试（Milky seq↔msgId 双向映射，2026-10-28）
 *
 * 锁定：双向登记/反查、FIFO 容量淘汰、collectReplyMeta 批量回填
 * （未命中不进表）。
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { MAX_ENTRIES, MessageSeqIndex } from "./seq-index.js";

/** 构造 RawMessage（最小合法值）。 */
function makeMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "100",
        msgTime: "1760000000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "90001",
        peerName: "测试群",
        sendNickName: "小明",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
        ...overrides,
    };
}

describe("MessageSeqIndex", () => {
    it("record → 双向反查（seq→msgId / collectReplyMeta）", () => {
        const index = new MessageSeqIndex();
        index.record(makeMsg());
        expect(index.resolveMsgId(ChatType.GROUP, "10001", 100)).toBe("m1");
        const meta = index.collectReplyMeta(["m1"]);
        expect(meta.get("m1")).toEqual({
            messageSeq: 100,
            senderId: 90001,
            time: 1760000000,
        });
    });

    it("peer 隔离：同 seq 不同会话不串", () => {
        const index = new MessageSeqIndex();
        index.record(makeMsg());
        index.record(makeMsg({ msgId: "m2", peerUid: "10002" }));
        expect(index.resolveMsgId(ChatType.GROUP, "10001", 100)).toBe("m1");
        expect(index.resolveMsgId(ChatType.GROUP, "10002", 100)).toBe("m2");
    });

    it("未命中：resolveMsgId undefined / collectReplyMeta 不进表", () => {
        const index = new MessageSeqIndex();
        expect(index.resolveMsgId(ChatType.GROUP, "10001", 999)).toBeUndefined();
        expect(index.collectReplyMeta(["nope"]).size).toBe(0);
    });

    it("非法 seq（非有限数）忽略", () => {
        const index = new MessageSeqIndex();
        index.record(makeMsg({ msgSeq: "abc" }));
        expect(index.resolveMsgId(ChatType.GROUP, "10001", Number.NaN)).toBeUndefined();
    });

    it("容量封顶：超限 FIFO 淘汰最旧", () => {
        const index = new MessageSeqIndex();
        for (let i = 0; i < MAX_ENTRIES + 10; i++) {
            index.record(makeMsg({ msgId: `m${i}`, msgSeq: String(i) }));
        }
        expect(index.resolveMsgId(ChatType.GROUP, "10001", 0)).toBeUndefined();
        expect(index.resolveMsgId(ChatType.GROUP, "10001", MAX_ENTRIES + 9)).toBe(
            `m${MAX_ENTRIES + 9}`,
        );
    });
});
