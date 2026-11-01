/**
 * RecentContactBridge：会话列表事件桥（2026-11-01，Milky 批次三 peer_pin_change 源）
 *
 * 职责：把 recentContact service 的原生回调（onRecentContactListChangedVer2 /
 * onRecentContactNotification）推入类型化事件通道
 * `NTEventChannel<RecentContactListener, "RecentContact">`。与 MsgBridge/
 * GroupBridge/FriendBridge 同构（每个 Service 只注册一次原生监听，ADR-003）。
 *
 * 方法名与参数形状证据：listener 录制器三轮实测（kernel design.md §10.1）——
 * onRecentContactListChangedVer2 参数 = {listType, sortedContactList,
 * changedList} 数组，条目含 chatType/peerUin/topFlag/topFlagTime；
 * onRecentContactNotification = RecentContact 快照数组。
 *
 * 用法：
 *   const channel = new NTEventChannel<RecentContactListener, "RecentContact">("RecentContact");
 *   const bridge = new RecentContactBridge(session, channel);
 *   bridge.register();   // addKernelRecentContactListener（普通 JS 对象，NAPI 反射）
 *   bridge.unregister(); // 停止时清理
 */

import type { NTEventChannel } from "../event-channel.js";
import { kernelError } from "../infra/index.js";
import type {
    NodeIKernelRecentContactService,
    NodeIQQNTWrapperSession,
    RecentContactListener,
} from "../types/index.js";

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
        const service =
            session.getRecentContactService() as unknown as NodeIKernelRecentContactService | null;
        if (service === null || service === undefined) {
            throw kernelError(
                "getRecentContactService() 返回空（session 未 init）",
                "INVALID_STATE",
            );
        }
        this.service = service;
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
}
