/**
 * GroupBridge：群事件桥（P2-17，2026-08-05）
 *
 * 职责：把 group service 的原生回调（onGroupListUpdate / onMemberListChange 等）
 * 推入类型化事件通道 `NTEventChannel<GroupListener, "Group">`。每个 Service 只
 * 注册一次原生监听（ADR-003），缓存维护（GroupCache）与协议层都订阅 channel。
 *
 * 用法：
 *   const channel = new NTEventChannel<GroupListener, "Group">("Group");
 *   const bridge = new GroupBridge(session, channel);
 *   bridge.register();   // addKernelGroupListener（普通 JS 对象，NAPI 反射）
 *   const cache = new GroupCache({ channel, groupApi });
 *   cache.register();    // 订阅 channel 主动维护
 *   bridge.unregister(); // 停止时清理
 */

import type { NTEventChannel } from "../event-channel.js";
import type {
    GroupListener,
    NodeIKernelGroupService,
    NodeIQQNTWrapperSession,
} from "../types/index.js";
import { requireKernelService } from "../utils/type-guards.js";

/** 群事件通道的固定类型（事件名前缀 "Group"）。 */
export type GroupEventChannel = NTEventChannel<GroupListener, "Group">;

/**
 * 群事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程每 session 实例化一份。
 */
export class GroupBridge {
    private readonly service: NodeIKernelGroupService;
    private readonly channel: GroupEventChannel;
    private listenerId: number | null = null;

    constructor(session: NodeIQQNTWrapperSession, channel: GroupEventChannel) {
        this.service = requireKernelService(session.getGroupService(), "getGroupService", [
            "addKernelGroupListener",
        ]);
        this.channel = channel;
    }

    /** 注册原生监听（幂等）。 */
    register(): void {
        if (this.listenerId !== null) {
            return;
        }
        // listener 为普通 JS 对象（NAPI 反射读取方法回调）
        const listener: GroupListener = {
            onGroupListInited: (listEmpty) =>
                this.channel.emit("Group/onGroupListInited", listEmpty),
            onGroupListUpdate: (updateType, groupList) =>
                this.channel.emit("Group/onGroupListUpdate", updateType, groupList),
            onGroupDetailInfoChange: (detailInfo) =>
                this.channel.emit("Group/onGroupDetailInfoChange", detailInfo),
            onMemberListChange: (arg) => this.channel.emit("Group/onMemberListChange", arg),
            onMemberInfoChange: (groupCode, dataSource, members) =>
                this.channel.emit("Group/onMemberInfoChange", groupCode, dataSource, members),
            onGroupNotifiesUpdated: (doubt, notifies) =>
                this.channel.emit("Group/onGroupNotifiesUpdated", doubt, notifies),
            onGroupSingleScreenNotifies: (doubt, seq, notifies) =>
                this.channel.emit("Group/onGroupSingleScreenNotifies", doubt, seq, notifies),
            onShutUpMemberListChanged: (groupCode, members) =>
                this.channel.emit("Group/onShutUpMemberListChanged", groupCode, members),
            // 2026-09-10 接线：群精华列表变化（方法名证据见 listeners/group.ts 注释）
            onGroupEssenceListChange: (arg) =>
                this.channel.emit("Group/onGroupEssenceListChange", arg),
        };
        this.listenerId = this.service.addKernelGroupListener(listener);
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        if (this.listenerId === null) {
            return;
        }
        this.service.removeKernelGroupListener(this.listenerId);
        this.listenerId = null;
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
