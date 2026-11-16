/**
 * kurobot 协议核心接口契约（纯类型，无运行时依赖）
 *
 * 从 `adapter.ts` 下沉，切断 adapter / session / inbound 之间的类型环：
 * 各消费方直接引本文件，不再反向 import `adapter.ts`。
 */
import type { CanonicalElement, Peer } from "@napuketto/kernel";

/** 发群消息最小面（kernel MsgApi.sendMessage 的结构子集，便于测试桩替换）。 */
export interface KurobotMsgApi {
    sendMessage(target: Peer, elements: CanonicalElement[]): Promise<{ msgId: string }>;
}

/** 接收行绑定过滤 holder（loader ReceiveLogFilter 同构契约）。 */
export interface ReceiveLogFilterHolder {
    current: ((peerUin: string, isGroup: boolean) => boolean) | null;
}

/** 连接出口面（adapter 持有连接生命周期；未建立连接时 send 恒 false / established 恒 false）。 */
export interface KurobotConnFace {
    send: (frame: { type: string; body: unknown; id?: string }) => boolean;
    isEstablished: () => boolean;
}
