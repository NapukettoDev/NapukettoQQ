/**
 * RecentContactBridge：把 recentContact service 的原生回调（onRecentContactListChangedVer2 /
 * onRecentContactNotification）推入 `NTEventChannel<RecentContactListener, "RecentContact">`。
 * 录制实证：前者参数 = {listType, sortedContactList, changedList}（条目含 chatType/peerUin/topFlag）。
 */

import type { NTEventChannel } from "../../infra/event-channel.js";
import { requireKernelService } from "../../infra/type-guards.js";
import type {
    NodeIKernelRecentContactService,
    NodeIQQNTWrapperSession,
    RecentContactListener,
} from "../../types/index.js";

/** 会话列表事件通道的固定类型（事件名前缀 "RecentContact"）。 */
export type RecentContactEventChannel = NTEventChannel<RecentContactListener, "RecentContact">;

/**
 * 会话列表事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程每 session 实例化一份。
 */
export class RecentContactBridge {
    private readonly service: NodeIKernelRecentContactService;
    private readonly channel: RecentContactEventChannel;
    private listenerId: number | null = null;

    constructor(session: NodeIQQNTWrapperSession, channel: RecentContactEventChannel) {
        this.service = requireKernelService(
            session.getRecentContactService(),
            "getRecentContactService",
            ["addKernelRecentContactListener"],
        );
        this.channel = channel;
    }

    /** 注册原生监听（幂等）。 */
    register(): void {
        if (this.listenerId !== null) {
            return;
        }
        // listener 为普通 JS 对象（NAPI 反射读取方法回调）
        const listener: RecentContactListener = {
            onRecentContactListChangedVer2: (lists) =>
                this.channel.emit("RecentContact/onRecentContactListChangedVer2", lists),
            onRecentContactNotification: (contacts) =>
                this.channel.emit("RecentContact/onRecentContactNotification", contacts),
        };
        this.listenerId = this.service.addKernelRecentContactListener(listener);
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        if (this.listenerId === null) {
            return;
        }
        this.service.removeKernelRecentContactListener(this.listenerId);
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
