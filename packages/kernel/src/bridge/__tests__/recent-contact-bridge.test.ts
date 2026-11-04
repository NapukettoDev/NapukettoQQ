/**
 * recent-contact-bridge.ts 单测：注册/注销/事件透传。
 *
 * 覆盖目标：RecentContactBridge 两个录制实证回调 → `RecentContact/*` 通道
 * 透传（onRecentContactListChangedVer2 数组载荷 / onRecentContactNotification
 * 快照数组）、register/unregister 幂等、session 未 init 抛 INVALID_STATE。
 */
import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import type { RecentContactListener } from "../../types/index.js";
import { RecentContactBridge } from "../recent-contact-bridge.js";
import { makeCapturedService, makeSession } from "../test-support.js";

/** 构造 RecentContactBridge + 桩 service/channel。 */
function makeBridge() {
    const channel = new NTEventChannel<RecentContactListener, "RecentContact">("RecentContact");
    const { service, listener } = makeCapturedService<RecentContactListener>(
        "addKernelRecentContactListener",
        "removeKernelRecentContactListener",
    );
    const bridge = new RecentContactBridge(
        makeSession("getRecentContactService", service) as never,
        channel,
    );
    return { bridge, channel, service, listener };
}

describe("RecentContactBridge", () => {
    it("session 未 init（getRecentContactService 返回 null）抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<RecentContactListener, "RecentContact">("RecentContact");
        expect(() => {
            new RecentContactBridge(makeSession("getRecentContactService", null) as never, channel);
        }).toThrow(/getRecentContactService\(\) 返回空/);
    });

    it("getRecentContactService 返回 undefined 同样抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<RecentContactListener, "RecentContact">("RecentContact");
        expect(() => {
            new RecentContactBridge(
                makeSession("getRecentContactService", undefined) as never,
                channel,
            );
        }).toThrow(/getRecentContactService\(\) 返回空/);
    });

    it("register 注册原生监听且幂等", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.register();
        expect(service["addKernelRecentContactListener"]).toHaveBeenCalledTimes(1);
    });

    it("unregister 注销且幂等（传入 register 返回的 listenerId）", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.unregister();
        expect(service["removeKernelRecentContactListener"]).toHaveBeenCalledTimes(1);
        expect(service["removeKernelRecentContactListener"]).toHaveBeenCalledWith(42);
    });

    it("未 register 直接 unregister 不产生注销调用", () => {
        const { bridge, service } = makeBridge();
        bridge.unregister();
        expect(service["removeKernelRecentContactListener"]).not.toHaveBeenCalled();
    });

    it("onRecentContactListChangedVer2 → RecentContact/onRecentContactListChangedVer2", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("RecentContact/onRecentContactListChangedVer2", handler);
        bridge.register();
        // 录制实证载荷：{listType, sortedContactList, changedList} 数组
        const lists = [
            {
                listType: 1,
                sortedContactList: ["c1"],
                changedList: [
                    { chatType: 1, peerUin: "10001", topFlag: 1, topFlagTime: "9" } as never,
                ],
            },
        ];
        listener()?.onRecentContactListChangedVer2(lists);
        expect(handler).toHaveBeenCalledWith(lists);
    });

    it("onRecentContactNotification → RecentContact/onRecentContactNotification", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("RecentContact/onRecentContactNotification", handler);
        bridge.register();
        const contacts = [{ chatType: 7, peerUid: "" } as never];
        listener()?.onRecentContactNotification(contacts);
        expect(handler).toHaveBeenCalledWith(contacts);
    });
});
