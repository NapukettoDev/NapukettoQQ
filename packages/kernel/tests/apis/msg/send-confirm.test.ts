import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmSend } from "../../../src/apis/msg/send-confirm.js";
import { NTEventChannel } from "../../../src/infra/event-channel.js";
import type { MsgEventChannel } from "../../../src/native/bridge/msg-bridge.js";
import { ChatType, type Peer, type RawMessage } from "../../../src/types/entities.js";
import type { MsgListener } from "../../../src/types/listeners/msg.js";

const REQUEST_ID = "client-generated-id";
const MESSAGE_UPDATE = "Msg/onMsgInfoListUpdate";
const CONFIRM_TIMEOUT_MS = 15_000;
const target: Peer = { chatType: ChatType.GROUP, peerUid: "10001" };

function messageUpdate(sendStatus: number, guildId = REQUEST_ID): RawMessage {
    return {
        msgId: "native-stored-id",
        msgSeq: "42",
        msgTime: "1700000000",
        msgType: 0,
        chatType: target.chatType,
        peerUid: target.peerUid,
        peerUin: target.peerUid,
        senderUid: "sender",
        senderUin: "10002",
        peerName: "",
        sendNickName: "",
        elements: [],
        guildId,
        sendStatus,
    };
}

function expectConfirmationCleanedUp(channel: MsgEventChannel): void {
    expect(vi.getTimerCount()).toBe(0);
    const readGuildId = vi.fn(() => REQUEST_ID);
    const lateUpdate: RawMessage = {
        ...messageUpdate(2),
        get guildId() {
            return readGuildId();
        },
    };
    const receiveUpdate = vi.fn<(messages: RawMessage[]) => void>();
    channel.on(MESSAGE_UPDATE, receiveUpdate);
    const list = [lateUpdate];
    channel.emit(MESSAGE_UPDATE, list);
    expect(receiveUpdate.mock.calls[0]?.[0]).toBe(list);
    expect(readGuildId).not.toHaveBeenCalled();
}

describe("confirmSend", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([2, 3])("忽略无关和发送中事件，状态 %i 完成并清理", async (status) => {
        using channel = new NTEventChannel<MsgListener, "Msg">("Msg");
        const confirmation = confirmSend(channel, REQUEST_ID, target);
        const settled = vi.fn();
        const observation = confirmation.then(settled, settled);

        channel.emit("Msg/onRecvMsg", [messageUpdate(2)]);
        channel.emit(MESSAGE_UPDATE, [messageUpdate(0, "other-request")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).not.toHaveBeenCalled();

        channel.emit(MESSAGE_UPDATE, [messageUpdate(1)]);
        await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();

        const confirmed = messageUpdate(status);
        if (status === 3) {
            confirmed.msgSeq = "0";
        }
        channel.emit(MESSAGE_UPDATE, [messageUpdate(0, "other-request"), confirmed]);
        await observation;
        await expect(confirmation).resolves.toBe(confirmed);
        expectConfirmationCleanedUp(channel);
    });

    it("匹配消息发送失败时抛 SEND_FAILED 并清理", async () => {
        using channel = new NTEventChannel<MsgListener, "Msg">("Msg");
        const confirmation = confirmSend(channel, REQUEST_ID, target);

        channel.emit(MESSAGE_UPDATE, [messageUpdate(0)]);

        await expect(confirmation).rejects.toMatchObject({
            code: "SEND_FAILED",
            message: expect.stringContaining("sendStatus=0"),
        });
        expectConfirmationCleanedUp(channel);
    });

    it("确认超时时抛 SEND_FAILED 并清理", async () => {
        using channel = new NTEventChannel<MsgListener, "Msg">("Msg");
        const confirmation = confirmSend(channel, REQUEST_ID, target);
        channel.emit(MESSAGE_UPDATE, [messageUpdate(1)]);

        await Promise.all([
            expect(confirmation).rejects.toMatchObject({
                code: "SEND_FAILED",
                message: expect.stringContaining("等待确认超时"),
            }),
            vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS),
        ]);
        expectConfirmationCleanedUp(channel);
    });
});
