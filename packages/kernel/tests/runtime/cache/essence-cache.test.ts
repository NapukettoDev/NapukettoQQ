import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { EssenceMsgItem } from "../../../src/apis/web.js";
import { NTEventChannel } from "../../../src/infra/event-channel.js";
import { EssenceListSync } from "../../../src/runtime/cache/essence-cache.js";
import type { GroupListener } from "../../../src/types/index.js";
import { GroupListUpdateType } from "../../../src/types/index.js";

const item = (msgSeq: number): EssenceMsgItem => ({
    msg_seq: msgSeq,
    sender_uin: "123",
    msg_content: [],
});

function fixture() {
    const channel = new NTEventChannel<GroupListener, "Group">("Group");
    const fetchList = vi.fn<(code: string) => Promise<EssenceMsgItem[]>>().mockResolvedValue([]);
    const added = vi.fn();
    const removed = vi.fn();
    const onQueueFull = vi.fn();
    const onNotifyError = vi.fn();
    const sync = new EssenceListSync({
        fetchList,
        onAdded: added,
        onRemoved: removed,
        onQueueFull,
        onNotifyError,
    });
    sync.start(channel);
    return { channel, fetchList, added, removed, onQueueFull, onNotifyError, sync };
}

describe("EssenceListSync 请求生命周期", () => {
    it("等待中的同群事件合并，运行中同群事件只追加一次刷新", async () => {
        const { fetchList, added, removed, sync } = fixture();
        const baseline = Promise.withResolvers<EssenceMsgItem[]>();
        fetchList.mockReturnValueOnce(baseline.promise).mockResolvedValueOnce([item(2)]);
        sync.enqueue("100");
        sync.enqueue("100");
        await setImmediate();
        expect(fetchList.mock.calls).toEqual([["100"]]);
        sync.enqueue("100");
        sync.enqueue("100");
        baseline.resolve([item(1)]);
        await setImmediate();

        expect(fetchList.mock.calls).toEqual([["100"], ["100"]]);
        expect(added).toHaveBeenCalledWith(
            "100",
            [expect.objectContaining({ messageSeq: 2 })],
            expect.any(AbortSignal),
        );
        expect(removed).toHaveBeenCalledWith(
            "100",
            [1],
            new Map([[1, { senderUin: "123", operatorUin: null, addDigestTime: null }]]),
            expect.any(AbortSignal),
        );
    });

    it("队列最多等待 64 个群，释放容量后再触发即可补拉", async () => {
        const { fetchList, onQueueFull, sync } = fixture();
        const slow = Promise.withResolvers<EssenceMsgItem[]>();
        fetchList.mockReturnValueOnce(slow.promise);
        sync.enqueue("100");
        await setImmediate();
        const waiting = Array.from({ length: 64 }, (_, index) => String(index + 101));
        for (const groupCode of waiting) {
            sync.enqueue(groupCode);
        }
        sync.enqueue(waiting[0] ?? "");
        sync.enqueue("999");
        expect(onQueueFull.mock.calls).toEqual([["999"]]);
        expect(fetchList.mock.calls).toEqual([["100"]]);
        slow.resolve([]);
        await setImmediate();
        expect(fetchList.mock.calls.flat()).toEqual(["100", ...waiting]);
        sync.enqueue("999");
        await setImmediate();
        expect(fetchList).toHaveBeenLastCalledWith("999");
    });

    it.each(["leave", "stop"] as const)(
        "失效后丢弃迟到结果与等待任务，恢复时从新基线开始 (%s)",
        async (reason) => {
            const { channel, fetchList, added, removed, sync } = fixture();
            const old = Promise.withResolvers<EssenceMsgItem[]>();
            fetchList.mockResolvedValueOnce([item(1)]).mockReturnValueOnce(old.promise);
            sync.enqueue("100");
            await setImmediate();
            sync.enqueue("100");
            await setImmediate();
            sync.enqueue("100");
            sync.enqueue("200");

            if (reason === "leave") {
                channel.emit("Group/onGroupListInited", true);
            } else {
                sync.stop();
            }
            sync.enqueue("100");
            old.resolve([item(2)]);
            await setImmediate();
            expect(fetchList.mock.calls).toEqual([["100"], ["100"]]);
            expect(added).not.toHaveBeenCalled();
            expect(removed).not.toHaveBeenCalled();

            sync.start(channel);
            channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [
                { groupCode: "100", groupName: "rejoined", memberCount: 1, maxMember: 100 },
            ]);
            fetchList.mockResolvedValueOnce([item(3)]).mockResolvedValueOnce([item(3), item(4)]);
            sync.enqueue("100");
            await setImmediate();
            expect(added).not.toHaveBeenCalled();
            sync.enqueue("100");
            await setImmediate();
            expect(added).toHaveBeenCalledWith(
                "100",
                [expect.objectContaining({ messageSeq: 4 })],
                expect.any(AbortSignal),
            );
        },
    );

    it("广播失败不会跳过下一群的同步", async () => {
        const { fetchList, added, onNotifyError, sync } = fixture();
        const error = new Error("test notification");
        fetchList.mockResolvedValueOnce([item(1)]);
        sync.enqueue("100");
        await setImmediate();
        added.mockRejectedValueOnce(error);
        sync.enqueue("100");
        sync.enqueue("200");
        await setImmediate();
        expect(onNotifyError).toHaveBeenCalledWith("100", error);
        expect(fetchList).toHaveBeenLastCalledWith("200");
    });
});
