/**
 * FriendBridge：好友事件桥（2026-09-08）
 *
 * 职责：把 buddy service 的原生回调（onBuddyReqChange / onBuddyListChange 等）
 * 推入类型化事件通道 `NTEventChannel<BuddyListener, "Buddy">`。与 MsgBridge/
 * GroupBridge 同构（每个 Service 只注册一次原生监听，ADR-003）。
 *
 * 方法名证据：wrapper.node（9.9.33-52230）二进制字符串提取；参数形状
 * 待真实事件校准（透传 unknown，订阅方防御性收窄）。
 *
 * 用法：
 *   const channel = new NTEventChannel<BuddyListener, "Buddy">("Buddy");
 *   const bridge = new FriendBridge(session, channel);
 *   bridge.register();   // addKernelBuddyListener（普通 JS 对象，NAPI 反射）
 *   bridge.unregister(); // 停止时清理
 */

import type { NTEventChannel } from "../event-channel.js";
import type {
    BuddyListener,
    NodeIKernelBuddyService,
    NodeIQQNTWrapperSession,
} from "../types/index.js";
import { requireKernelService } from "../utils/type-guards.js";

/** 好友事件通道的固定类型（事件名前缀 "Buddy"）。 */
export type BuddyEventChannel = NTEventChannel<BuddyListener, "Buddy">;

/**
 * 好友事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程每 session 实例化一份。
 */
export class FriendBridge {
    private readonly service: NodeIKernelBuddyService;
    private readonly channel: BuddyEventChannel;
    private listenerId: number | null = null;

    constructor(session: NodeIQQNTWrapperSession, channel: BuddyEventChannel) {
        this.service = requireKernelService(session.getBuddyService(), "getBuddyService", [
            "addKernelBuddyListener",
        ]);
        this.channel = channel;
    }

    /** 注册原生监听（幂等）。 */
    register(): void {
        if (this.listenerId !== null) {
            return;
        }
        // listener 为普通 JS 对象（NAPI 反射读取方法回调）
        const listener: BuddyListener = {
            onBuddyReqChange: (arg) => this.channel.emit("Buddy/onBuddyReqChange", arg),
            onBuddyListChange: (arg) => this.channel.emit("Buddy/onBuddyListChange", arg),
            onBuddyListChangedV2: (arg) => this.channel.emit("Buddy/onBuddyListChangedV2", arg),
            onBuddyDeleted: (arg) => this.channel.emit("Buddy/onBuddyDeleted", arg),
        };
        this.listenerId = this.service.addKernelBuddyListener(listener);
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        if (this.listenerId === null) {
            return;
        }
        this.service.removeKernelBuddyListener(this.listenerId);
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
