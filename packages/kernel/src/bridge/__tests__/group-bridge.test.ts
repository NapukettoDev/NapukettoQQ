/**
 * group-bridge.ts 单测：注册/注销/事件透传。
 *
 * 覆盖目标：GroupBridge 注册幂等（register/unregister）、session 未 init 抛
 * INVALID_STATE，以及 9 个原生回调 → `Group/*` 通道的事件名与参数顺序原样
 * 透传（表驱动冒烟，逐个回调一个用例）。
 */
import { describe, expect, it } from "vitest";
import { NTEventChannel } from "../../infra/event-channel.js";
import type { GroupListener } from "../../types/index.js";
import { GroupBridge } from "../group-bridge.js";
import { makeCapturedService, makeSession } from "./test-support.js";

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
});

/** 透传样本：同一份数据既作原生回调实参，也作通道侧期望参数。 */
const groupList = [{ groupCode: "123" }] as never;
const detail = { groupCode: "123", groupName: "g" } as never;
const memberArg = {
    sceneId: "123",
    ids: ["u1"],
    infos: new Map([["u1", { uid: "u1" } as never]]),
    hasPrev: false,
    hasNext: true,
} as never;
const members = new Map([["u1", { uid: "u1" } as never]]);
const notifies = [{ seq: "1" }] as never;
const shutUpMembers = [{ uid: "u1" }] as never;
const essenceArg = [{ msgId: "1" }] as never;

describe("原生回调透传（表驱动冒烟）", () => {
    it.each([
        {
            name: "onGroupListInited",
            event: "Group/onGroupListInited",
            invoke: (listener: GroupListener) => listener.onGroupListInited(true),
            args: [true],
        },
        {
            name: "onGroupListUpdate",
            event: "Group/onGroupListUpdate",
            invoke: (listener: GroupListener) => listener.onGroupListUpdate(1, groupList),
            args: [1, groupList],
        },
        {
            name: "onGroupDetailInfoChange",
            event: "Group/onGroupDetailInfoChange",
            invoke: (listener: GroupListener) => listener.onGroupDetailInfoChange(detail),
            args: [detail],
        },
        {
            name: "onMemberListChange",
            event: "Group/onMemberListChange",
            invoke: (listener: GroupListener) => listener.onMemberListChange(memberArg),
            args: [memberArg],
        },
        {
            name: "onMemberInfoChange",
            event: "Group/onMemberInfoChange",
            invoke: (listener: GroupListener) => listener.onMemberInfoChange("123", 1, members),
            args: ["123", 1, members],
        },
        {
            name: "onGroupNotifiesUpdated",
            event: "Group/onGroupNotifiesUpdated",
            invoke: (listener: GroupListener) => listener.onGroupNotifiesUpdated(false, notifies),
            args: [false, notifies],
        },
        {
            name: "onGroupSingleScreenNotifies",
            event: "Group/onGroupSingleScreenNotifies",
            invoke: (listener: GroupListener) =>
                listener.onGroupSingleScreenNotifies(true, "99", notifies),
            args: [true, "99", notifies],
        },
        {
            name: "onShutUpMemberListChanged",
            event: "Group/onShutUpMemberListChanged",
            invoke: (listener: GroupListener) =>
                listener.onShutUpMemberListChanged("123", shutUpMembers),
            args: ["123", shutUpMembers],
        },
        {
            name: "onGroupEssenceListChange",
            event: "Group/onGroupEssenceListChange",
            invoke: (listener: GroupListener) => listener.onGroupEssenceListChange(essenceArg),
            args: [essenceArg],
        },
    ])("$name → $event（参数顺序原样透传）", ({ event, invoke, args }) => {
        const { bridge, channel, listener } = makeBridge();
        const seen: Array<{ event: string; args: unknown[] }> = [];
        channel.onAny((name, ...rest) => {
            seen.push({ event: name, args: rest });
        });
        bridge.register();
        const native = listener();
        expect(native).toBeDefined();
        if (native !== undefined) {
            invoke(native);
        }
        expect(seen).toEqual([{ event, args }]);
    });
});
