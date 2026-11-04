/**
 * group-bridge.ts 单测：注册/注销/事件透传。
 *
 * 覆盖目标：GroupBridge 全部 9 个原生回调 → `Group/*` 通道透传（含多参
 * onGroupListUpdate/onMemberInfoChange/onGroupNotifiesUpdated/onGroupSingleScreenNotifies/
 * onShutUpMemberListChanged 的参数顺序保持）、register/unregister 幂等、
 * session 未 init 抛 INVALID_STATE。
 */
import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import type { GroupListener } from "../../types/index.js";
import { GroupBridge } from "../group-bridge.js";
import { makeCapturedService, makeSession } from "../test-support.js";

/** 构造 GroupBridge + 桩 service/channel。 */
function makeBridge() {
    const channel = new NTEventChannel<GroupListener, "Group">("Group");
    const { service, listener } = makeCapturedService<GroupListener>(
        "addKernelGroupListener",
        "removeKernelGroupListener",
    );
    const bridge = new GroupBridge(makeSession("getGroupService", service) as never, channel);
    return { bridge, channel, service, listener };
}

describe("GroupBridge", () => {
    it("session 未 init（getGroupService 返回 null）抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<GroupListener, "Group">("Group");
        expect(() => {
            new GroupBridge(makeSession("getGroupService", null) as never, channel);
        }).toThrow(/getGroupService\(\) 返回空/);
    });

    it("getGroupService 返回 undefined 同样抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<GroupListener, "Group">("Group");
        expect(() => {
            new GroupBridge(makeSession("getGroupService", undefined) as never, channel);
        }).toThrow(/getGroupService\(\) 返回空/);
    });

    it("register 注册原生监听且幂等", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.register();
        expect(service["addKernelGroupListener"]).toHaveBeenCalledTimes(1);
    });

    it("unregister 注销且幂等（传入 register 返回的 listenerId）", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.unregister();
        expect(service["removeKernelGroupListener"]).toHaveBeenCalledTimes(1);
        expect(service["removeKernelGroupListener"]).toHaveBeenCalledWith(42);
    });

    it("未 register 直接 unregister 不产生注销调用", () => {
        const { bridge, service } = makeBridge();
        bridge.unregister();
        expect(service["removeKernelGroupListener"]).not.toHaveBeenCalled();
    });

    it("onGroupListInited → Group/onGroupListInited", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onGroupListInited", handler);
        bridge.register();
        listener()?.onGroupListInited(true);
        expect(handler).toHaveBeenCalledWith(true);
    });

    it("onGroupListUpdate → Group/onGroupListUpdate（两参顺序保持）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onGroupListUpdate", handler);
        bridge.register();
        listener()?.onGroupListUpdate(1, [{ groupCode: "123" } as never]);
        expect(handler).toHaveBeenCalledWith(1, [{ groupCode: "123" }]);
    });

    it("onGroupDetailInfoChange → Group/onGroupDetailInfoChange", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onGroupDetailInfoChange", handler);
        bridge.register();
        const detail = { groupCode: "123", groupName: "g" } as never;
        listener()?.onGroupDetailInfoChange(detail);
        expect(handler).toHaveBeenCalledWith(detail);
    });

    it("onMemberListChange → Group/onMemberListChange", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onMemberListChange", handler);
        bridge.register();
        const arg = {
            sceneId: "123",
            ids: ["u1"],
            infos: new Map([["u1", { uid: "u1" } as never]]),
            hasPrev: false,
            hasNext: true,
        };
        listener()?.onMemberListChange(arg as never);
        expect(handler).toHaveBeenCalledWith(arg);
    });

    it("onMemberInfoChange → Group/onMemberInfoChange（三参顺序保持）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onMemberInfoChange", handler);
        bridge.register();
        listener()?.onMemberInfoChange("123", 1, new Map([["u1", { uid: "u1" } as never]]));
        expect(handler).toHaveBeenCalledWith("123", 1, new Map([["u1", { uid: "u1" }]]));
    });

    it("onGroupNotifiesUpdated → Group/onGroupNotifiesUpdated（两参顺序保持）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onGroupNotifiesUpdated", handler);
        bridge.register();
        listener()?.onGroupNotifiesUpdated(false, [{ seq: "1" } as never]);
        expect(handler).toHaveBeenCalledWith(false, [{ seq: "1" }]);
    });

    it("onGroupSingleScreenNotifies → Group/onGroupSingleScreenNotifies（三参顺序保持）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onGroupSingleScreenNotifies", handler);
        bridge.register();
        listener()?.onGroupSingleScreenNotifies(true, "99", [{ seq: "99" } as never]);
        expect(handler).toHaveBeenCalledWith(true, "99", [{ seq: "99" }]);
    });

    it("onShutUpMemberListChanged → Group/onShutUpMemberListChanged（两参顺序保持）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onShutUpMemberListChanged", handler);
        bridge.register();
        listener()?.onShutUpMemberListChanged("123", [{ uid: "u1" } as never]);
        expect(handler).toHaveBeenCalledWith("123", [{ uid: "u1" }]);
    });

    it("onGroupEssenceListChange → Group/onGroupEssenceListChange", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Group/onGroupEssenceListChange", handler);
        bridge.register();
        const arg = [{ msgId: "1" } as never];
        listener()?.onGroupEssenceListChange(arg);
        expect(handler).toHaveBeenCalledWith(arg);
    });
});
