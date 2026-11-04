/**
 * satori 测试公共 fixture（test-support.ts，避免跨文件复制同构 setup）
 *
 * - makeRawMsg：最小合法 RawMessage（元素可注入）
 * - makeRevokeMsg / makeMemberChangeMsg：grayTip 事件载体（撤回 / 群成员变动）
 * - spyBroadcaster：捕获 emit 的事件列表
 * - fakeMsgChannel：捕获 Msg/onRecvMsg 订阅回调（可手动触发）
 */
import { ChatType, type MsgEventChannel, type RawMessage } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";

/** 最小合法 RawMessage（元素可注入）。 */
export function makeRawMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "5",
        msgTime: "1700000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "peer-uid-1",
        peerUin: "10001",
        senderUid: "sender-uid-1",
        senderUin: "90001",
        peerName: "测试群",
        sendNickName: "小明",
        elements: [{ elementType: 1, textElement: { content: "你好" } }],
        ...overrides,
    };
}

/** 撤回 grayTip 消息（message-deleted 事件载体）。 */
export function makeRevokeMsg(
    overrides: Partial<RawMessage> = {},
    operatorUid = "op-uid-1",
): RawMessage {
    return makeRawMsg({
        elements: [
            {
                elementType: 8,
                grayTipElement: { subElementType: 1, revokeElement: { operatorUid } },
            },
        ],
        ...overrides,
    });
}

/** 群成员变动 grayTip 消息（guild-member-added / removed 事件载体）。 */
export function makeMemberChangeMsg(
    groupElement: RawMessage["elements"][number]["grayTipElement"],
    overrides: Partial<RawMessage> = {},
): RawMessage {
    return makeRawMsg({
        elements: [{ elementType: 8, grayTipElement: { subElementType: 4, ...groupElement } }],
        ...overrides,
    });
}

/** 捕获 emit 的事件列表（broadcaster 桩；含 register/unregister 记录）。 */
export function spyBroadcaster(): {
    broadcaster: EventBroadcaster;
    events: unknown[];
    registered: unknown[];
    unregistered: unknown[];
} {
    const events: unknown[] = [];
    const registered: unknown[] = [];
    const unregistered: unknown[] = [];
    return {
        events,
        registered,
        unregistered,
        broadcaster: {
            emit: (e: unknown) => {
                events.push(e);
            },
            register: (a: unknown) => {
                registered.push(a);
            },
            unregister: (a: unknown) => {
                unregistered.push(a);
            },
        } as unknown as EventBroadcaster,
    };
}

/** 捕获 Msg/onRecvMsg 订阅回调（手动触发收链路；退订函数真正摘除回调）。 */
export function fakeMsgChannel(): {
    channel: MsgEventChannel;
    fire: (msgs: unknown) => void;
} {
    let callback: ((msgs: unknown) => void) | undefined;
    const channel = {
        on: (_event: string, cb: (msgs: unknown) => void) => {
            callback = cb;
            return () => {
                callback = undefined;
            };
        },
    } as unknown as MsgEventChannel;
    return { channel, fire: (msgs: unknown) => callback?.(msgs) };
}
