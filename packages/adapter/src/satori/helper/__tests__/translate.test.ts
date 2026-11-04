/**
 * translate.ts toSatoriMessage 基线测试（Satori 收方向翻译，fallow CRITICAL）
 *
 * 锁定 RawMessage → Satori Message 的资源提升规则：
 *  - 群聊：guild + channel(TEXT) + user + member
 *  - 私聊：channel(DIRECT) + user（对端兜底 senderUin 或 peerUin）
 *  - content：元素渲染；空 → 不写
 *  - created_at：有效时间戳写入
 *  - memberName 与 nickname 不同 → member.nick
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { type SatoriTranslateDeps, toChannelById, toSatoriMessage } from "../translate.js";

/** 构造 RawMessage（text 元素，其余最小合法值）。 */
function makeMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1",
        msgTime: "1700000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "g1",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "90001",
        peerName: "测试群",
        sendNickName: "小明",
        elements: [{ elementType: 1, textElement: { content: "你好" } }],
        ...overrides,
    };
}

const deps: SatoriTranslateDeps = { selfUin: "1" };

describe("toSatoriMessage", () => {
    it("群聊：guild + channel + user + member", async () => {
        const msg = await toSatoriMessage(makeMsg(), deps);
        expect(msg.id).toBe("m1");
        expect(msg.content).toBe("你好");
        expect(msg.guild).toEqual({ id: "10001", name: "测试群" });
        expect(msg.channel).toEqual({ id: "10001", type: 0, name: "测试群" });
        expect(msg.user).toEqual({ id: "90001", name: "小明" });
        expect(msg.member).toEqual({ user: { id: "90001", name: "小明" } });
        expect(msg.created_at).toBe(1700000000);
    });

    it("群聊 memberName 与 nickname 不同 → member.nick", async () => {
        const msg = await toSatoriMessage(makeMsg({ sendMemberName: "群名片" }), deps);
        expect(msg.member?.nick).toBe("群名片");
    });

    it("群聊 memberName 与 nickname 相同 → 不写 member.nick", async () => {
        const msg = await toSatoriMessage(makeMsg({ sendMemberName: "小明" }), deps);
        expect(msg.member?.nick).toBeUndefined();
    });

    it("私聊：channel(DIRECT) + user（对端=senderUin）", async () => {
        const msg = await toSatoriMessage(
            makeMsg({ chatType: ChatType.C2C, peerUin: "10001", senderUin: "90001" }),
            deps,
        );
        expect(msg.guild).toBeUndefined();
        expect(msg.member).toBeUndefined();
        expect(msg.channel).toEqual({ id: "90001", type: 1, name: "小明" });
        expect(msg.user).toEqual({ id: "90001", name: "小明" });
    });

    it("私聊 senderUin 空 → 对端兜底 peerUin", async () => {
        const msg = await toSatoriMessage(
            makeMsg({ chatType: ChatType.C2C, peerUin: "10001", senderUin: "" }),
            deps,
        );
        expect(msg.channel?.id).toBe("10001");
        expect(msg.user?.id).toBe("10001");
    });

    it("content 为空（无元素）→ 不写 content", async () => {
        const msg = await toSatoriMessage(makeMsg({ elements: [] }), deps);
        expect(msg.content).toBeUndefined();
    });

    it("msgTime 无效（0 / NaN）→ 不写 created_at", async () => {
        const msg0 = await toSatoriMessage(makeMsg({ msgTime: "0" }), deps);
        expect(msg0.created_at).toBeUndefined();
        const msgNan = await toSatoriMessage(makeMsg({ msgTime: "abc" }), deps);
        expect(msgNan.created_at).toBeUndefined();
    });
});

describe("toChannelById", () => {
    it("isGroup=true → 群聊频道（type 0，name 可选）", () => {
        expect(toChannelById("10001", true, "群名")).toEqual({
            id: "10001",
            type: 0,
            name: "群名",
        });
        expect(toChannelById("10001", true)).toEqual({ id: "10001", type: 0 });
    });

    it("isGroup=false → 私聊频道（type 1）", () => {
        expect(toChannelById("90001", false)).toEqual({ id: "90001", type: 1 });
    });
});
