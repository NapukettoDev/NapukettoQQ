/**
 * GroupBridge：把 group service 的原生回调（onGroupListUpdate / onMemberListChange 等）
 * 推入类型化事件通道 `NTEventChannel<GroupListener, "Group">`；每个 Service 只注册一次
 * 原生监听（ADR-003），缓存维护（GroupCache）与协议层都订阅 channel。
 */

import type { NTEventChannel } from "../../infra/event-channel.js";
import { requireKernelService } from "../../infra/type-guards.js";
import type {
    GroupListener,
    NodeIKernelGroupService,
    NodeIQQNTWrapperSession,
} from "../../types/index.js";

/** 群事件通道的固定类型（事件名前缀 "Group"）。 */
export type GroupEventChannel = NTEventChannel<GroupListener, "Group">;

/**
 * 群事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程每 session 实例化一份。
 */
export class GroupBridge {
    private readonly service: NodeIKernelGroupService;
    private readonly channel: GroupEventChannel;
    private registration: { id?: number } | null = null;

    constructor(session: NodeIQQNTWrapperSession, channel: GroupEventChannel) {
        this.service = requireKernelService(session.getGroupService(), "getGroupService", [
            "addKernelGroupListener",
        ]);
        this.channel = channel;
    }

    /** 注册原生监听（幂等）。 */
    register(): void {
        if (this.registration !== null) {
            return;
        }
        const registration: { id?: number } = {};
        this.registration = registration;
        // 原生注销后仍可能调用先前捕获的监听器。
        const currentChannel = () =>
            this.registration === registration ? this.channel : undefined;
        // listener 为普通 JS 对象（NAPI 反射读取方法回调）
        const listener: GroupListener = {
            onGroupListInited: (listEmpty) =>
                currentChannel()?.emit("Group/onGroupListInited", listEmpty),
            onGroupListUpdate: (updateType, groupList) =>
                currentChannel()?.emit("Group/onGroupListUpdate", updateType, groupList),
            onGroupDetailInfoChange: (detailInfo) =>
                currentChannel()?.emit("Group/onGroupDetailInfoChange", detailInfo),
            onMemberListChange: (arg) => currentChannel()?.emit("Group/onMemberListChange", arg),
            onMemberInfoChange: (groupCode, dataSource, members) =>
                currentChannel()?.emit("Group/onMemberInfoChange", groupCode, dataSource, members),
            onGroupNotifiesUpdated: (doubt, notifies) =>
                currentChannel()?.emit("Group/onGroupNotifiesUpdated", doubt, notifies),
            onGroupSingleScreenNotifies: (doubt, seq, notifies) =>
                currentChannel()?.emit("Group/onGroupSingleScreenNotifies", doubt, seq, notifies),
            onShutUpMemberListChanged: (groupCode, members) =>
                currentChannel()?.emit("Group/onShutUpMemberListChanged", groupCode, members),
            // 群精华列表变化（方法名证据见 listeners/group.ts 注释）
            onGroupEssenceListChange: (arg) =>
                currentChannel()?.emit("Group/onGroupEssenceListChange", arg),
        };
        try {
            const id = this.service.addKernelGroupListener(listener);
            if (this.registration === registration) {
                registration.id = id;
            } else {
                this.service.removeKernelGroupListener(id);
            }
        } catch (err) {
            if (this.registration === registration) {
                this.registration = null;
            }
            throw err;
        }
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        const id = this.registration?.id;
        this.registration = null;
        if (id !== undefined) {
            this.service.removeKernelGroupListener(id);
        }
    }

    /** 释放（等价 unregister，幂等）。 */
    dispose(): void {
        this.unregister();
    }

    /** `using bridge = ...` 自动释放。 */
    [Symbol.dispose](): void {
        this.unregister();
    }
}
