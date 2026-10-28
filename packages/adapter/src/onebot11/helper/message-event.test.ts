/**
 * 消息翻译 sender.role 传播测试（群缓存角色判定，2026-10-28）
 *
 * 锁定 ctx 注入行为：
 *  - toOb11MessageEvent：群消息 role 缺省 member，ctx.senderRole 透传；私聊无 role
 *  - toOb11MessageInfo：同上（get_msg / 历史消息返回结构）
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toOb11MessageEvent } from "./message-event.js";
import { toOb11MessageInfo } from "./message-info.js";
import { MessageUnique } from "./message-unique.js";

/** 构造 RawMessage（text 元素，其余最小合法值）。 */
function makeMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1",
        msgTime: "1700000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "90001",
        peerName: "测试群",
        sendNickName: "小明",
        elements: [{ elementType: 1, textElement: { content: "你好" } }],
        ...overrides,
    };
}

describe("toOb11MessageEvent sender.role", () => {
    it("群消息缺省 role=member（ctx 未注入角色）", () => {
        const event = toOb11MessageEvent(makeMsg(), "10000", new MessageUnique());
        if (event.post_type !== "message" || event.message_type !== "group") {
            throw new Error("应为群消息事件");
        }
        expect(event.sender.role).toBe("member");
    });

    it("ctx.senderRole 透传（owner / admin）", () => {
        for (const senderRole of ["owner", "admin"] as const) {
            const event = toOb11MessageEvent(makeMsg(), "10000", new MessageUnique(), "array", {
                senderRole,
            });
            if (event.post_type !== "message" || event.message_type !== "group") {
                throw new Error("应为群消息事件");
            }
            expect(event.sender.role).toBe(senderRole);
        }
    });

    it("私聊 sender 无 role（即使 ctx 带角色）", () => {
        const event = toOb11MessageEvent(
            makeMsg({ chatType: ChatType.C2C, peerUid: "u2" }),
            "10000",
            new MessageUnique(),
            "array",
            { senderRole: "admin" },
        );
        if (event.post_type !== "message" || event.message_type !== "private") {
            throw new Error("应为私聊消息事件");
        }
        expect("role" in event.sender).toBe(false);
    });
});

describe("toOb11MessageInfo sender.role", () => {
    it("群消息缺省 role=member，ctx 注入后透传", () => {
        const unique = new MessageUnique();
        const none = toOb11MessageInfo(makeMsg(), unique);
        expect(none.sender.role).toBe("member");
        const admin = toOb11MessageInfo(makeMsg(), unique, { senderRole: "admin" });
        expect(admin.sender.role).toBe("admin");
    });

    it("私聊 sender 无 role", () => {
        const info = toOb11MessageInfo(
            makeMsg({ chatType: ChatType.C2C, peerUid: "u2" }),
            new MessageUnique(),
            {
                senderRole: "owner",
            },
        );
        expect("role" in info.sender).toBe(false);
    });
});
