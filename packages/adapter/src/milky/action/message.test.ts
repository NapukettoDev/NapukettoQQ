/**
 * Milky 动作层测试（P0 发送链 + 注册表面）
 *
 * 锁定：
 *  - sendMilkyMessage：OutgoingSegment → canonical（mention uin→uid、
 *    at all、reply seq 原样兜底、text/light_app 直映射；未知段跳过）
 *  - 响应输出 {message_seq, time}（发送回查）
 *  - 注册表：P0 九动作名齐
 */
import { ChatType, type Peer, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { MilkyApi } from "../api.js";
import { MessageSeqIndex } from "../helper/seq-index.js";
import { createMilkyActionRegistry } from "./index.js";
import { sendMilkyMessage } from "./message.js";

/** 发送成功回查用的 RawMessage。 */
function sentMsg(seq: string, time: string): RawMessage {
    return {
        msgId: "sent-1",
        msgSeq: seq,
        msgTime: time,
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "self-uid",
        senderUin: "10000",
        peerName: "测试群",
        sendNickName: "机器人",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
    };
}

/** 构造 MilkyApi（kernel apis 桩：uinToUid 桩映射 + sendMessage 捕获）。 */
function makeApi(): { api: MilkyApi; sentElements: () => RawMessage["elements"] } {
    let captured: RawMessage["elements"] = [];
    const api = new MilkyApi(
        {
            msgApi: {
                sendMessage: vi.fn(async (_peer: Peer, elements: RawMessage["elements"]) => {
                    captured = elements;
                    return { msgId: "sent-1" };
                }),
                fetchMsgsByMsgId: vi.fn(async () => [sentMsg("1300", "1760000000000")]),
                fetchMessages: vi.fn(async () => []),
            },
            groupApi: {
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(async () => new Map()),
            },
            friendApi: {},
            profileApi: {},
            self: { uin: "10000", nickname: "机器人" },
            system: undefined,
        } as unknown as ConstructorParameters<typeof MilkyApi>[0],
        new MessageSeqIndex(),
    );
    return { api, sentElements: () => captured };
}

describe("sendMilkyMessage", () => {
    it("text + mention：canonical 直映射，at uin→uid 批量转换", async () => {
        const { api, sentElements } = makeApi();
        await sendMilkyMessage(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            [
                { type: "text", data: { text: "你好 " } },
                { type: "mention", data: { user_id: 90001 } },
                { type: "mention_all", data: {} },
            ],
            api,
        );
        // 桩捕获的是 sendMessage 入参 = canonical 元素（NT 转换在 kernel 内部）
        expect(sentElements()).toEqual([
            { type: "text", text: "你好 " },
            { type: "at", target: "uid-90001" },
            { type: "at", target: "all" },
        ]);
    });

    it("输出 = 发送回查的 message_seq/time", async () => {
        const { api } = makeApi();
        const out = await sendMilkyMessage(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            [{ type: "text", data: { text: "hi" } }],
            api,
        );
        expect(out).toEqual({ message_seq: 1300, time: 1760000000 });
    });

    it("未知段跳过；全部不可用抛 INVALID_PARAM", async () => {
        const { api } = makeApi();
        await expect(
            sendMilkyMessage(
                { chatType: ChatType.GROUP, peerUid: "10001" },
                [{ type: "no_such_segment", data: {} } as never],
                api,
            ),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("reply：seq 原样透传给 canonical（msgId 反查由接收索引/命中兜底）", async () => {
        const { api, sentElements } = makeApi();
        await sendMilkyMessage(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            [{ type: "reply", data: { message_seq: 1299 } }],
            api,
        );
        const [replyEl] = sentElements();
        expect(replyEl).toEqual({ type: "reply", messageId: "1299" });
    });
});

describe("createMilkyActionRegistry", () => {
    it("P0 九动作名齐（保持注册表前缀；P1 面 42 动作另测）", () => {
        const { api } = makeApi();
        const registry = createMilkyActionRegistry({ api });
        expect(registry.names.slice(0, 9)).toEqual([
            "get_login_info",
            "get_impl_info",
            "send_private_message",
            "send_group_message",
            "get_message",
            "recall_private_message",
            "recall_group_message",
            "get_friend_list",
            "get_group_list",
        ]);
    });

    it("get_impl_info：milky_version=1.3 + impl_name=napukettoqq", async () => {
        const { api } = makeApi();
        const registry = createMilkyActionRegistry({ api });
        const result = await registry.get("get_impl_info")?.handle({});
        expect(result?.status).toBe("ok");
        expect(result?.data).toMatchObject({
            impl_name: "napukettoqq",
            qq_protocol_type: "windows",
            milky_version: "1.3",
        });
    });

    it("参数解析失败 → retcode=-400", async () => {
        const { api } = makeApi();
        const registry = createMilkyActionRegistry({ api });
        const result = await registry
            .get("send_group_message")
            ?.handle({ group_id: "not-a-number" });
        expect(result?.retcode).toBe(-400);
        expect(result?.status).toBe("failed");
    });
});
