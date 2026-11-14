/**
 * MsgBridge：消息事件桥（P2-2，2026-08-05）
 *
 * 职责：把 msg service 的原生回调（onRecvMsg 等）推入类型化事件通道
 * `NTEventChannel<MsgListener, "Msg">`。每个 Service 只注册一次原生监听
 * （ADR-003），缓存维护与协议翻译都订阅 channel。
 *
 * 用法：
 *   const channel = new NTEventChannel<MsgListener, "Msg">("Msg");
 *   const bridge = new MsgBridge(session, channel);
 *   bridge.register();   // addKernelMsgListener（普通 JS 对象，NAPI 反射）
 *   // 协议层订阅：channel.on("Msg/onRecvMsg", handler)
 *   bridge.unregister(); // 停止时清理
 */

import type { NTEventChannel } from "../event-channel.js";
import { kernelError } from "../infra/index.js";
import type {
    MsgListener,
    NodeIKernelMsgService,
    NodeIQQNTWrapperSession,
    RawMessage,
} from "../types/index.js";
import { awaitPicLocalPaths, hasPendingPicPaths } from "./pic-path-grace.js";

/** 消息事件通道的固定类型（事件名前缀 "Msg"）。 */
export type MsgEventChannel = NTEventChannel<MsgListener, "Msg">;

/**
 * 消息事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程每 session 实例化一份。
 */
export class MsgBridge {
    private readonly service: NodeIKernelMsgService;
    private readonly channel: MsgEventChannel;
    private listenerId: number | null = null;

    constructor(session: NodeIQQNTWrapperSession, channel: MsgEventChannel) {
        const service = session.getMsgService() as unknown as NodeIKernelMsgService | null;
        if (service === null || service === undefined) {
            throw kernelError("getMsgService() 返回空（session 未 init）", "INVALID_STATE");
        }
        this.service = service;
        this.channel = channel;
    }

    /**
     * 图片落盘宽限发射（issue #105）：候选路径全缺失的 pic 才进异步等待，
     * 其余同步发射（保持既有事件时序）。等待由 pic-path-grace 有界并行兜底，
     * 超时后原样放行（canonical 层置空裁决）。
     */
    private emitPicAware(
        event: "Msg/onRecvMsg" | "Msg/onMsgInfoListUpdate",
        msgs: RawMessage[],
    ): void {
        if (!hasPendingPicPaths(msgs)) {
            this.channel.emit(event, msgs);
            return;
        }
        void awaitPicLocalPaths(msgs).then(() => this.channel.emit(event, msgs));
    }

    /** 注册原生监听（幂等）。 */
    register(): void {
        if (this.listenerId !== null) {
            return;
        }
        // listener 为普通 JS 对象（NAPI 反射读取方法回调）
        // onRecvMsg 透传原生回调参数（运行时实证为消息数组，2026-08-07）。
        // 图片消息先经落盘宽限（pic-path-grace，有界并行）：原生补丁放行自动
        // 下载后，事件先于落盘到达——不等待则下游拿到尚未存在的路径，被
        // canonical 层置空后变成"有图无文件"。快速路径（无 pic / 路径已在）
        // 保持同步发射；缺失时异步等待，原生侧 fire-and-forget 不消费返回值。
        const listener: MsgListener = {
            onRecvMsg: (msgs) => this.emitPicAware("Msg/onRecvMsg", msgs),
            onRecvMsgReadReport: (reports) => this.channel.emit("Msg/onRecvMsgReadReport", reports),
            onRecvMsgReceipt: (receipts) => this.channel.emit("Msg/onRecvMsgReceipt", receipts),
            // 2026-08-11 补齐：发送状态更新（sendMsg 结果以此为准，NapCat 同款）
            onMsgInfoListUpdate: (msgs) => this.emitPicAware("Msg/onMsgInfoListUpdate", msgs),
            // 2026-09-10 接线：离线文件 / sys msg（方法名证据见 listeners/msg.ts 头注释）
            // 2026-11-01：onRecvOfflineFileMsg 收窄为 RawMessage[] + 补 onFileMsgCome
            // （录制实证与离线文件同载荷，friend_file_upload 第二源）
            onRecvOfflineFileMsg: (msgs) => this.channel.emit("Msg/onRecvOfflineFileMsg", msgs),
            onFileMsgCome: (msgs) => this.channel.emit("Msg/onFileMsgCome", msgs),
            onRecvOnlineFileMsg: (arg) => this.channel.emit("Msg/onRecvOnlineFileMsg", arg),
            onRecvSysMsg: (arg) => this.channel.emit("Msg/onRecvSysMsg", arg),
        };
        this.listenerId = this.service.addKernelMsgListener(listener);
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        if (this.listenerId === null) {
            return;
        }
        this.service.removeKernelMsgListener(this.listenerId);
        this.listenerId = null;
    }
}
