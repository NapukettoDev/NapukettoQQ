/**
 * MessageUnique 测试：OB11 message_id ↔ NT msgId 双向映射、peer 反查、
 * release 槽位复用（释放池优先）、resolveMsgIdAndPeer 两类 NOT_FOUND、
 * 溢出线性扫描（cursor > int32 max 后从 1 找空洞；经白盒注入 cursor 模拟，
 * 2^31 条逐条分配超出单测可行域）。「槽位耗尽」抛错需占满整个 int32 空间，
 * 不可行，不在覆盖范围。
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { MessageUnique, resolveMsgIdAndPeer } from "../message-unique.js";

/** 白盒句柄：TS private 在运行时是普通属性，注入 cursor / 映射表模拟溢出。 */
interface MessageUniqueInternals {
    cursor: number;
    intToMsgId: Map<number, string>;
    freed: Set<number>;
}

/** 溢出后的线性扫描（L85 起）：cursor 越过 int32 max → 从 INT32_MIN 找空洞。 */
describe("MessageUnique（溢出线性扫描，白盒注入 cursor）", () => {
    const Int32Max = 0x7f_ff_ff_ff;

    it("cursor 越界后从 1 起扫描：空洞 id 直接复用，cursor 前移到空洞+1", () => {
        const unique = new MessageUnique();
        const inner = unique as unknown as MessageUniqueInternals;
        // 预置 id 1 已被占用（模拟历史分配），释放池为空 → 扫描跳过 1 命中 2
        inner.intToMsgId.set(1, "nt-occupied");
        inner.cursor = Int32Max + 1;
        expect(unique.alloc("nt-after-overflow")).toBe(2);
        expect(inner.cursor).toBe(3);
        // 双向映射照常登记
        expect(unique.getMsgId(2)).toBe("nt-after-overflow");
        expect(unique.getMessageId("nt-after-overflow")).toBe(2);
    });

    it("cursor 越界且首 id 空闲 → 返回 1（空洞扫描首个命中）", () => {
        const unique = new MessageUnique();
        const inner = unique as unknown as MessageUniqueInternals;
        inner.cursor = Int32Max + 1;
        expect(unique.alloc("nt-first-hole")).toBe(1);
        expect(inner.cursor).toBe(2);
    });
});

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
