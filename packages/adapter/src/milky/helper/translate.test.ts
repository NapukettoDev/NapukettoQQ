/**
 * Milky 翻译层基线测试（2026-10-28 P0）
 *
 * 锁定 RawMessage → Milky 事件的映射行为与规范字段名（SSOT：Milky 1.3 JSON Schema）：
 *  - 三场景 IncomingMessage 形状（group 必需 group/group_member，friend 必需 friend）
 *  - 段映射：text / mention（uid→uin，失败跳过）/ mention_all / face / reply 回填 /
 *    image / light_app / xml；unknown 跳过
 *  - message_recall：operator uid→uin + wording
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import type { GroupEntity, GroupMemberEntity } from "../types.js";
import {
    chatTypeToScene,
    toGroupFileUploadEvent,
    toMessageRecallEvent,
    toMessageReceiveEvent,
} from "./translate.js";

/** 构造 RawMessage（text 元素，其余最小合法值）。 */
function makeMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1201",
        msgTime: "1760000000000",
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

const GROUP_ENTITY: GroupEntity = {
    group_id: 10001,
    group_name: "测试群",
    member_count: 10,
    max_member_count: 500,
    remark: "",
    created_time: 0,
    description: "",
    question: "",
    announcement: "",
};

const MEMBER_ENTITY: GroupMemberEntity = {
    user_id: 90001,
    nickname: "小明",
    sex: "unknown",
    group_id: 10001,
    card: "群名片",
    title: "",
    level: 0,
    role: "member",
    join_time: 0,
    last_sent_time: 0,
    shut_up_end_time: null,
};

describe("toMessageReceiveEvent", () => {
    it("群消息：scene/peer_id/message_seq/sender_id + group/group_member 实体注入", () => {
        const event = toMessageReceiveEvent(makeMsg(), {
            selfUin: "10000",
            groupEntity: GROUP_ENTITY,
            groupMemberEntity: MEMBER_ENTITY,
        });
        expect(event.event_type).toBe("message_receive");
        expect(event.self_id).toBe(10000);
        expect(event.time).toBe(1760000000);
        const data = event.data;
        if (data.message_scene !== "group") {
            throw new Error("应为 group 场景");
        }
        expect(data.peer_id).toBe(10001);
        expect(data.message_seq).toBe(1201);
        expect(data.sender_id).toBe(90001);
        expect(data.group).toEqual(GROUP_ENTITY);
        expect(data.group_member).toEqual(MEMBER_ENTITY);
        expect(data.segments).toEqual([{ type: "text", data: { text: "你好" } }]);
    });

    it("好友消息：peer_id=peerUin + friend 实体（peerName 兜底昵称）", () => {
        const event = toMessageReceiveEvent(
            makeMsg({ chatType: ChatType.C2C, peerUid: "u2", peerUin: "80002", peerName: "小红" }),
            { selfUin: "10000" },
        );
        const data = event.data;
        if (data.message_scene !== "friend") {
            throw new Error("应为 friend 场景");
        }
        expect(data.peer_id).toBe(80002);
        expect(data.friend).toEqual({
            user_id: 80002,
            nickname: "小红",
            sex: "unknown",
            qid: "",
            remark: "",
            category: { category_id: 0, category_name: "" },
        });
    });

    it("临时会话：scene=temp + group 缺省 null", () => {
        const event = toMessageReceiveEvent(
            makeMsg({ chatType: ChatType.C2C_TEMP, peerUid: "u3", peerUin: "80003" }),
            { selfUin: "10000" },
        );
        const data = event.data;
        if (data.message_scene !== "temp") {
            throw new Error("应为 temp 场景");
        }
        expect(data.group).toBeNull();
    });

    it("mention：uid→uin 注入；at all → mention_all；转换失败跳过", () => {
        const event = toMessageReceiveEvent(
            makeMsg({
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "@小明", atType: 2, atUid: "u1" },
                    },
                    { elementType: 1, textElement: { content: "@全体成员", atType: 1 } },
                    {
                        elementType: 1,
                        textElement: { content: "@未知", atType: 2, atUid: "unknown-uid" },
                    },
                ],
            }),
            { selfUin: "10000", uidToUin: new Map([["u1", "90001"]]) },
        );
        expect(event.data.segments).toEqual([
            { type: "mention", data: { user_id: 90001, name: "小明" } },
            { type: "mention_all", data: {} },
        ]);
    });

    it("reply：replyMeta 回填 message_seq/sender_id/time", () => {
        const event = toMessageReceiveEvent(
            makeMsg({
                elements: [
                    {
                        elementType: 7,
                        replyElement: { replayMsgId: "m0" },
                    },
                    { elementType: 1, textElement: { content: "回复" } },
                ],
            }),
            {
                selfUin: "10000",
                replyMeta: new Map([
                    ["m0", { messageSeq: 1199, senderId: 80002, time: 1759990000 }],
                ]),
            },
        );
        expect(event.data.segments).toEqual([
            {
                type: "reply",
                data: {
                    message_seq: 1199,
                    sender_id: 80002,
                    sender_name: null,
                    time: 1759990000,
                    segments: [],
                },
            },
            { type: "text", data: { text: "回复" } },
        ]);
    });

    it("light_app：json raw 字符串 → app_name（顶层 app 字段）+ json_payload", () => {
        const payload = '{"app":"com.test.app","meta":{"x":1}}';
        const event = toMessageReceiveEvent(
            makeMsg({
                elements: [{ elementType: 10, arkElement: { bytesData: payload } }],
            }),
            { selfUin: "10000" },
        );
        expect(event.data.segments).toEqual([
            { type: "light_app", data: { app_name: "com.test.app", json_payload: payload } },
        ]);
    });

    it("unknown 段跳过（规范：数组中未知项跳过）", () => {
        const event = toMessageReceiveEvent(
            makeMsg({
                elements: [
                    { elementType: 1, textElement: { content: "ok" } },
                    { elementType: 999 },
                ],
            }),
            { selfUin: "10000" },
        );
        expect(event.data.segments).toEqual([{ type: "text", data: { text: "ok" } }]);
    });
});

describe("toMessageRecallEvent", () => {
    it("群撤回：operator uid→uin + wording 后缀", () => {
        const event = toMessageRecallEvent(
            makeMsg({
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: 1,
                            revokeElement: { operatorUid: "u9", wording: "撤回了一条消息" },
                        },
                    },
                ],
            }),
            { selfUin: "10000", uidToUin: new Map([["u9", "90009"]]) },
        );
        expect(event).not.toBeNull();
        if (event === null) {
            return;
        }
        expect(event.event_type).toBe("message_recall");
        expect(event.data).toEqual({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 1201,
            sender_id: 90001,
            operator_id: 90009,
            display_suffix: "撤回了一条消息",
        });
    });

    it("非撤回 grayTip → null（不广播）", () => {
        const event = toMessageRecallEvent(
            makeMsg({
                elements: [{ elementType: 8, grayTipElement: { subElementType: 4 } }],
            }),
            { selfUin: "10000" },
        );
        expect(event).toBeNull();
    });
});

describe("chatTypeToScene", () => {
    it("GROUP→group / C2C→friend / C2C_TEMP→temp", () => {
        expect(chatTypeToScene(ChatType.GROUP)).toBe("group");
        expect(chatTypeToScene(ChatType.C2C)).toBe("friend");
        expect(chatTypeToScene(ChatType.C2C_TEMP)).toBe("temp");
    });
});

describe("toGroupFileUploadEvent", () => {
    it("群场景文件消息 → group_file_upload（fileUuid 优先）", () => {
        const msg = makeMsg({
            elements: [
                {
                    elementType: 3,
                    fileElement: {
                        fileName: "a.zip",
                        fileSize: "2048",
                        fileUuid: "uuid-1",
                    },
                },
            ],
        });
        const event = toGroupFileUploadEvent(msg, "10000");
        expect(event).toMatchObject({
            event_type: "group_file_upload",
            self_id: 10000,
            data: {
                group_id: 10001,
                user_id: 90001,
                file_id: "uuid-1",
                file_name: "a.zip",
                file_size: 2048,
            },
        });
    });

    it("非群场景返回 null（守卫在翻译函数内，friend 文件消息走 message_receive）", () => {
        const msg = makeMsg({
            chatType: ChatType.C2C,
            elements: [{ elementType: 3, fileElement: { fileName: "a.zip", fileSize: "2048" } }],
        });
        expect(toGroupFileUploadEvent(msg, "10000")).toBeNull();
    });
});
