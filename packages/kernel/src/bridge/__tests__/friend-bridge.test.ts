/**
 * friend-bridge.ts 单测：注册/注销/事件透传。
 *
 * 原生 service 以桩注入（addKernelBuddyListener 捕获 listener 对象后手动触发，
 * 验证回调 → channel 透传链路）。
 */
import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import type { BuddyListener } from "../../types/index.js";
import type { BuddyEventChannel } from "../friend-bridge.js";
import { FriendBridge } from "../friend-bridge.js";

/** 桩 buddy service（记录注册/注销调用，返回可控 listenerId）。 */
function makeService(): {
    service: {
        addKernelBuddyListener: ReturnType<typeof vi.fn>;
        removeKernelBuddyListener: ReturnType<typeof vi.fn>;
    };
    listener: () => BuddyListener | undefined;
} {
    let captured: BuddyListener | undefined;
    const service = {
        addKernelBuddyListener: vi.fn((l: BuddyListener) => {
            captured = l;
            return 42;
        }),
        removeKernelBuddyListener: vi.fn(),
    };
    return { service, listener: () => captured };
}

function makeBridge(): {
    bridge: FriendBridge;
    channel: BuddyEventChannel;
    service: ReturnType<typeof makeService>["service"];
    listener: () => BuddyListener | undefined;
} {
    const channel = new NTEventChannel<BuddyListener, "Buddy">("Buddy");
    const { service, listener } = makeService();
    const bridge = new FriendBridge(
        { getBuddyService: () => service } as unknown as ConstructorParameters<
            typeof FriendBridge
        >[0],
        channel,
    );
    return { bridge, channel, service, listener };
}

describe("FriendBridge", () => {
    it("session 未 init（getBuddyService 空）抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<BuddyListener, "Buddy">("Buddy");
        expect(() => {
            new FriendBridge(
                { getBuddyService: () => null } as unknown as ConstructorParameters<
                    typeof FriendBridge
                >[0],
                channel,
            );
        }).toThrow();
    });

    it("getBuddyService 返回 undefined 同样抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<BuddyListener, "Buddy">("Buddy");
        expect(() => {
            new FriendBridge(
                { getBuddyService: () => undefined } as unknown as ConstructorParameters<
                    typeof FriendBridge
                >[0],
                channel,
            );
        }).toThrow(/getBuddyService\(\) 返回空/);
    });

    it("register 注册原生监听（幂等），回调透传到 Buddy/* 通道", () => {
        const { bridge, channel, service, listener } = makeBridge();
        const onReq = vi.fn();
        const onList = vi.fn();
        channel.on("Buddy/onBuddyReqChange", onReq);
        channel.on("Buddy/onBuddyListChange", onList);
        bridge.register();
        // 幂等：重复 register 不重复注册
        bridge.register();
        expect(service.addKernelBuddyListener).toHaveBeenCalledTimes(1);
        const l = listener();
        expect(l).toBeDefined();
        l?.onBuddyReqChange({ buddyReqs: [] });
        expect(onReq).toHaveBeenCalledWith({ buddyReqs: [] });
        l?.onBuddyListChange([{ categoryId: 1 }]);
        expect(onList).toHaveBeenCalledWith([{ categoryId: 1 }]);
    });

    it("onBuddyListChangedV2 → Buddy/onBuddyListChangedV2 透传", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Buddy/onBuddyListChangedV2", handler);
        bridge.register();
        const arg = { selfUid: "u1" };
        listener()?.onBuddyListChangedV2(arg);
        expect(handler).toHaveBeenCalledWith(arg);
    });

    it("onBuddyDeleted → Buddy/onBuddyDeleted 透传", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Buddy/onBuddyDeleted", handler);
        bridge.register();
        const arg = { uin: "10002" };
        listener()?.onBuddyDeleted(arg);
        expect(handler).toHaveBeenCalledWith(arg);
    });

    it("未 register 直接 unregister 不产生注销调用", () => {
        const { bridge, service } = makeBridge();
        bridge.unregister();
        expect(service.addKernelBuddyListener).not.toHaveBeenCalled();
        expect(service.removeKernelBuddyListener).not.toHaveBeenCalled();
    });

    it("unregister 注销（幂等）", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.unregister();
        expect(service.removeKernelBuddyListener).toHaveBeenCalledTimes(1);
        expect(service.removeKernelBuddyListener).toHaveBeenCalledWith(42);
    });
});
