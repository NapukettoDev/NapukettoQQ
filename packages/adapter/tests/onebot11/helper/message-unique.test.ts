/**
 * MessageUnique 测试：OB11 message_id ↔ NT msgId 双向映射、peer 反查、
 * release 槽位复用（释放池优先）、resolveMsgIdAndPeer 两类 NOT_FOUND。
 * 「槽位耗尽」抛错需占满整个 int32 空间，不可行，不在覆盖范围。
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { MessageUnique, resolveMsgIdAndPeer } from "../../../src/onebot11/helper/message-unique.js";

describe("MessageUnique", () => {
    it("alloc 递增分配；同一 msgId 幂等", () => {
        const unique = new MessageUnique();
        expect(unique.alloc("nt-a")).toBe(1);
        expect(unique.alloc("nt-b")).toBe(2);
        expect(unique.alloc("nt-a")).toBe(1);
    });

    it("alloc 带 peer → getPeer 反查；重复 alloc 更新 peer", () => {
        const unique = new MessageUnique();
        const peer1 = { chatType: ChatType.GROUP, peerUid: "808" };
        const peer2 = { chatType: ChatType.GROUP, peerUid: "909" };
        expect(unique.alloc("nt-a", peer1)).toBe(1);
        expect(unique.getPeer("nt-a")).toEqual(peer1);
        unique.alloc("nt-a", peer2);
        expect(unique.getPeer("nt-a")).toEqual(peer2);
    });

    it("双向映射：getMsgId / getMessageId；未登记返回 undefined", () => {
        const unique = new MessageUnique();
        unique.alloc("nt-a");
        expect(unique.getMsgId(1)).toBe("nt-a");
        expect(unique.getMessageId("nt-a")).toBe(1);
        expect(unique.getMsgId(999)).toBeUndefined();
        expect(unique.getMessageId("nt-miss")).toBeUndefined();
    });

    it("release → 双向映射清空、释放池记录；释放池优先复用", () => {
        const unique = new MessageUnique();
        unique.alloc("nt-a"); // id 1
        unique.alloc("nt-b"); // id 2
        unique.release("nt-a");
        expect(unique.getMsgId(1)).toBeUndefined();
        expect(unique.getMessageId("nt-a")).toBeUndefined();
        expect(unique.getPeer("nt-a")).toBeUndefined();
        // 下一次分配优先复用释放池里的 id 1
        expect(unique.alloc("nt-c")).toBe(1);
        expect(unique.getMsgId(1)).toBe("nt-c");
        expect(unique.alloc("nt-d")).toBe(3);
    });

    it("release 未登记的 msgId → 无副作用", () => {
        const unique = new MessageUnique();
        unique.release("nt-miss");
        expect(unique.alloc("nt-a")).toBe(1);
    });

    it("release 后再 alloc 同 msgId → 新分配（不复用旧映射）", () => {
        const unique = new MessageUnique();
        unique.alloc("nt-a");
        unique.release("nt-a");
        const id = unique.alloc("nt-a");
        expect(id).toBe(1);
        expect(unique.getMessageId("nt-a")).toBe(1);
    });
});

describe("resolveMsgIdAndPeer", () => {
    it("number / string message_id → msgId + peer", () => {
        const unique = new MessageUnique();
        const peer = { chatType: ChatType.GROUP, peerUid: "808" };
        unique.alloc("nt-1", peer);
        expect(resolveMsgIdAndPeer(1, unique)).toEqual({ msgId: "nt-1", peer });
        expect(resolveMsgIdAndPeer("1", unique)).toEqual({ msgId: "nt-1", peer });
    });

    it("message_id 未登记 → NOT_FOUND（消息不存在）", () => {
        expect(() => resolveMsgIdAndPeer(999, new MessageUnique())).toThrowError("消息 999 不存在");
    });

    it("msgId 已登记但无 peer → NOT_FOUND（无会话记录）", () => {
        const unique = new MessageUnique();
        unique.alloc("nt-1");
        expect(() => resolveMsgIdAndPeer(1, unique)).toThrowError("消息 1 无会话记录");
    });
});
