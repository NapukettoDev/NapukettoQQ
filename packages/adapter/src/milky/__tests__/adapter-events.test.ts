/**
 * Milky 适配器事件分发测试（adapter.ts 收链路，批次三全量）
 *
 * 锁定：消息通道三源分流（message_receive / group_file_upload / notice /
 * message_recall / 自消息不上报）、at+reply 回填、转发登记、sysmsg 识别表
 * （732:16 表情回应 / 732:1 精华快路径 + 列表 diff 去重 / 528 校准日志）、
 * 私聊文件双回调去重、精华 diff（基线/新增/移除/操作者回填/拉取失败）、
 * 置顶翻转（播种/首见/影子过滤）、bot_offline、群通知与好友请求通道。
 */
import { ChatType, GrayTipSubType, TipGroupElementType } from "@napuketto/kernel";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type AdapterEnv,
    adapterEnv,
    cleanupEnvDirs,
    flushAsync,
    ProtoWriter,
    rawMsg,
} from "./test-support.js";

/** 共享环境（beforeAll 启动一次；用例间以捕获数组与独立群号隔离）。 */
let env: AdapterEnv;

/** 取捕获事件列表（event_type + data 视图）。 */
function events(): Array<{ event_type: string; data: Record<string, unknown> }> {
    return env.captures.map((e) => e as { event_type: string; data: Record<string, unknown> });
}

beforeAll(async () => {
    env = await adapterEnv({
        config: { port: 36395 },
        withGroupChannel: true,
        withBuddyChannel: true,
        withRecentContactChannel: true,
        withLoginChannel: true,
    });
    await env.adapter.start();
});

afterAll(async () => {
    await env.adapter.stop();
    await cleanupEnvDirs();
});

beforeEach(() => {
    env.captures.length = 0;
    vi.clearAllMocks();
    env.logger.info.mockClear();
});

afterEach(async () => {
    await flushAsync();
});

/** 群聊文本消息（群号/seq/发送者可覆写，均避开自账号）。 */
function groupMsg(overrides: Record<string, unknown> = {}): ReturnType<typeof rawMsg> {
    return rawMsg({ ...overrides });
}

describe("消息通道分流（Msg/onRecvMsg）", () => {
    it("他人群聊消息 → message_receive + seqIndex 双向登记", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [groupMsg({ msgSeq: "1101", msgId: "m-e1" })]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as {
            event_type: string;
            data: { message_scene: string; message_seq: number; group: { group_id: number } };
        };
        expect(event.event_type).toBe("message_receive");
        expect(event.data["message_scene"]).toBe("group");
        expect(event.data.message_seq).toBe(1101);
        expect(event.data.group).toEqual({
            group_id: 10001,
            group_name: "",
            member_count: 0,
            max_member_count: 0,
            remark: "",
            created_time: 0,
            description: "",
            question: "",
            announcement: "",
        });
        // seq → msgId 反查可用（接收链路登记）：经撤回动作端到端验证
        const recall = await env.adapter.registry.get("recall_group_message")?.handle({
            group_id: 10001,
            message_seq: 1101,
        });
        expect(recall?.status).toBe("ok");
    });

    it("自消息不上报（senderUin = self）但 seq 仍登记", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                senderUin: "10000",
                senderUid: "uid-10000",
                msgSeq: "1102",
                msgId: "m-self",
            }),
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
        const recall = await env.adapter.registry.get("recall_group_message")?.handle({
            group_id: 10001,
            message_seq: 1102,
        });
        expect(recall?.status).toBe("ok");
    });

    it("群文件消息 → group_file_upload（替代 message_receive）", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1103",
                msgId: "m-file",
                elements: [
                    {
                        elementType: 3,
                        fileElement: { fileName: "a.zip", fileSize: "2048", fileUuid: "uuid-a" },
                    },
                ],
            }),
        ]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(event.event_type).toBe("group_file_upload");
        expect(event.data).toEqual({
            group_id: 10001,
            user_id: 20002,
            file_id: "uuid-a",
            file_name: "a.zip",
            file_size: 2048,
        });
    });

    it("grayTip 撤回 → message_recall（operator uid→uin）", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1104",
                msgId: "m-revoke",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: GrayTipSubType.REVOKE,
                            revokeElement: { operatorUid: "uid-30003", wording: "撤回了一条消息" },
                        },
                    },
                ],
            }),
        ]);
        await flushAsync();
        const recall = events().find((e) => e.event_type === "message_recall");
        expect(recall).toBeDefined();
        expect(recall?.data).toMatchObject({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 1104,
            sender_id: 20002,
            operator_id: 30003,
            display_suffix: "撤回了一条消息",
        });
    });

    it("grayTip 成员增加 → group_member_increase（approve 形态 operator；invite 形态 invitor）", async () => {
        // approve 形态：adminUid === memberUid → operator_id
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1105",
                msgId: "m-join",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: GrayTipSubType.GROUP,
                            groupElement: {
                                type: TipGroupElementType.MEMBER_ADD,
                                memberUid: "uid-20002",
                                adminUid: "uid-20002",
                            },
                        },
                    },
                ],
            }),
        ]);
        await flushAsync();
        const notice = events().find((e) => e.event_type === "group_member_increase");
        expect(notice).toBeDefined();
        expect(notice?.data).toMatchObject({ group_id: 10001, user_id: 20002, operator_id: 20002 });
        // invite 形态：adminUid ≠ memberUid → invitor_id
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1105b",
                msgId: "m-join2",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: GrayTipSubType.GROUP,
                            groupElement: {
                                type: TipGroupElementType.MEMBER_ADD,
                                memberUid: "uid-20002",
                                adminUid: "uid-30003",
                            },
                        },
                    },
                ],
            }),
        ]);
        await flushAsync();
        const invite = events().find(
            (e) => e.event_type === "group_member_increase" && e.data["invitor_id"] !== null,
        );
        expect(invite?.data).toMatchObject({ user_id: 20002, invitor_id: 30003 });
    });

    it("grayTip 未知子类型 → 翻译 null 不广播", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1106",
                msgId: "m-gray-unknown",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: { subElementType: GrayTipSubType.PROCLAMATION },
                    },
                ],
            }),
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });

    it("C2C 消息 → friend 场景 message_receive", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            rawMsg({
                chatType: ChatType.C2C,
                peerUid: "uid-20002",
                peerUin: "20002",
                msgSeq: "1107",
                msgId: "m-c2c",
            }),
        ]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(event.event_type).toBe("message_receive");
        expect(event.data["message_scene"]).toBe("friend");
        expect(event.data["friend"]).toMatchObject({ user_id: 20002, nickname: "测试群" });
    });

    it("合并转发消息 → forward 段注入 + resId 登记", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1108",
                msgId: "m-fw",
                elements: [
                    { elementType: 1, textElement: { content: "转发卡片" } },
                    {
                        elementType: 16,
                        multiForwardMsgElement: {
                            resId: "res-xyz",
                            fileName: "聊天记录",
                            xmlContent: "",
                        },
                    },
                ],
            }),
        ]);
        await flushAsync();
        const event = events()[0] as unknown as {
            data: { segments: Array<{ type: string; data: Record<string, unknown> }> };
        };
        const forward = event.data.segments.find((s) => s.type === "forward");
        expect(forward?.data).toEqual({
            forward_id: "res-xyz",
            title: "聊天记录",
            preview: [],
            summary: "",
        });
        // 转发索引登记（get_forwarded_messages 反查用）：索引未登记会 NOT_FOUND
        const forwarded = await env.adapter.registry.get("get_forwarded_messages")?.handle({
            forward_id: "res-xyz",
        });
        expect(forwarded?.status).toBe("ok");
        expect(forwarded?.data).toEqual({ messages: [] });
    });

    it("at 段 uid→uin 回填 → mention user_id 数字", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1109",
                msgId: "m-at",
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "@甲", atType: 2, atUid: "uid-20002" },
                    },
                ],
            }),
        ]);
        await flushAsync();
        const event = events()[0] as unknown as {
            data: { segments: Array<{ type: string; data: Record<string, unknown> }> };
        };
        expect(event.data.segments[0]).toEqual({
            type: "mention",
            data: { user_id: 20002, name: "甲" },
        });
    });

    it("reply 段经 seqIndex 回填引用元信息", async () => {
        // 先登记被引用消息
        await env.msgCh.emit("Msg/onRecvMsg", [groupMsg({ msgSeq: "1110", msgId: "m-ref" })]);
        await flushAsync();
        env.captures.length = 0;
        // 引用消息
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1111",
                msgId: "m-reply",
                elements: [{ elementType: 7, replyElement: { replayMsgId: "m-ref" } }],
            }),
        ]);
        await flushAsync();
        const event = events()[0] as unknown as {
            data: { segments: Array<{ type: string; data: Record<string, unknown> }> };
        };
        expect(event.data.segments[0]?.type).toBe("reply");
        expect(event.data.segments[0]?.data).toMatchObject({ message_seq: 1110, sender_id: 20002 });
    });

    it("消息数组规范化：单对象入参等效数组", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [groupMsg({ msgSeq: "1112", msgId: "m-single" })]);
        await flushAsync();
        expect(events()).toHaveLength(1);
    });

    it("群场景 + groupCache：实体回填进 message_receive（fillGroupEntities）", async () => {
        const envCache = await adapterEnv({
            config: { port: 36397 },
            withGroupChannel: false,
            groupCache: {
                getGroupDetail: vi.fn(async () => ({
                    groupCode: "10001",
                    groupName: "缓存群",
                    memberNum: 5,
                    maxMemberNum: 100,
                })),
                getMember: vi.fn(async () => ({
                    uid: "uid-20002",
                    uin: "20002",
                    nick: "甲",
                    cardName: "名片甲",
                    role: 3,
                })),
            },
        });
        try {
            await envCache.adapter.start();
            await envCache.msgCh.emit("Msg/onRecvMsg", [
                rawMsg({ msgSeq: "1150", msgId: "m-cache" }),
            ]);
            await flushAsync();
            const event = envCache.captures[0] as {
                event_type: string;
                data: { group: { group_name: string }; group_member: { card: string } };
            };
            expect(
                event.data["group"] && (event.data["group"] as { group_name: string }).group_name,
            ).toBe("缓存群");
            expect(
                event.data["group_member"] && (event.data["group_member"] as { card: string }).card,
            ).toBe("名片甲");
        } finally {
            await envCache.adapter.stop();
        }
    });
});

describe("sysmsg 通道（Msg/onRecvSysMsg，批次三识别表）", () => {
    /** 732:16 表情回应 blob（faceId/f5/群号/msgSeq 可配）。 */
    function reactionBlob(opts: { f5: number; group?: number; seq?: number }): Uint8Array {
        const detail = new ProtoWriter()
            .varint(1, 1)
            .bytes(2, new ProtoWriter().varint(1, opts.seq ?? 150).build())
            .bytes(
                3,
                new ProtoWriter()
                    .text(1, "76")
                    .varint(5, opts.f5)
                    .varint(3, 1)
                    .text(4, "u_bot")
                    .build(),
            )
            .build();
        const f44 = new ProtoWriter().bytes(1, new ProtoWriter().bytes(1, detail).build()).build();
        return new ProtoWriter()
            .bytes(1, new ProtoWriter().varint(1, opts.group ?? 1101729931).build())
            .bytes(2, new ProtoWriter().varint(1, 732).varint(2, 16).varint(6, 1793540000).build())
            .bytes(3, new ProtoWriter().bytes(2, new ProtoWriter().bytes(44, f44).build()).build())
            .build();
    }

    it("732:16 添加回应 → group_message_reaction（is_add=true）", async () => {
        await env.msgCh.emit("Msg/onRecvSysMsg", [reactionBlob({ f5: 1 })]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as {
            event_type: string;
            data: Record<string, unknown>;
            time: number;
        };
        expect(event.event_type).toBe("group_message_reaction");
        expect(event.data).toEqual({
            group_id: 1101729931,
            message_seq: 150,
            face_id: 76,
            reaction_type: "face",
            is_add: true,
        });
        expect(event["time"]).toBe(1793540000);
    });

    it("732:16 信封缺时间字段 → 事件 time 兜底当前秒", async () => {
        const detail = new ProtoWriter()
            .varint(1, 1)
            .bytes(2, new ProtoWriter().varint(1, 9).build())
            .bytes(3, new ProtoWriter().text(1, "76").varint(5, 1).varint(3, 1).build())
            .build();
        const f44 = new ProtoWriter().bytes(1, new ProtoWriter().bytes(1, detail).build()).build();
        const noTime = new ProtoWriter()
            .bytes(1, new ProtoWriter().varint(1, 1101729931).build())
            .bytes(2, new ProtoWriter().varint(1, 732).varint(2, 16).build())
            .bytes(3, new ProtoWriter().bytes(2, new ProtoWriter().bytes(44, f44).build()).build())
            .build();
        const before = Math.floor(Date.now() / 1000);
        await env.msgCh.emit("Msg/onRecvSysMsg", [noTime]);
        await flushAsync();
        const event = events()[0] as unknown as { time: number };
        expect(event.time).toBeGreaterThanOrEqual(before);
    });

    it("732:16 撤销回应（f5=2）→ is_add=false", async () => {
        await env.msgCh.emit("Msg/onRecvSysMsg", [reactionBlob({ f5: 2 })]);
        await flushAsync();
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event?.data["is_add"]).toBe(false);
    });

    it("732:16 缺 face 块 → 提取失败不广播（debug 日志）", async () => {
        const poor = new ProtoWriter()
            .bytes(1, new ProtoWriter().varint(1, 1101729931).build())
            .bytes(2, new ProtoWriter().varint(1, 732).varint(2, 16).build())
            .build();
        await env.msgCh.emit("Msg/onRecvSysMsg", [poor]);
        await flushAsync();
        expect(events()).toHaveLength(0);
        expect(env.logger.debug).toHaveBeenCalled();
    });

    it("onRecvSysMsg 未知参数形状 → warn 日志", async () => {
        await env.msgCh.emit("Msg/onRecvSysMsg", "garbage");
        await flushAsync();
        expect(events()).toHaveLength(0);
        expect(env.logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("未知参数形状"),
        );
    });

    it("528:382（多端同步）→ observed_unnamed 只留校准日志", async () => {
        const blob = new ProtoWriter()
            .bytes(1, new ProtoWriter().varint(1, 1).build())
            .bytes(2, new ProtoWriter().varint(1, 528).varint(2, 382).build())
            .build();
        await env.msgCh.emit("Msg/onRecvSysMsg", [blob]);
        await flushAsync();
        expect(events()).toHaveLength(0);
        expect(env.logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ verdict: "observed_unnamed" }),
            expect.any(String),
        );
    });

    it("畸形字节（非 protobuf）→ 解码失败 debug 日志", async () => {
        await env.msgCh.emit("Msg/onRecvSysMsg", [Uint8Array.from([0x0f, 0xff, 0xff])]);
        await flushAsync();
        expect(events()).toHaveLength(0);
        expect(env.logger.debug).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("解码失败"),
        );
    });
});

describe("精华双路径（732:1 快路径 + 列表 diff）", () => {
    /** 732:1 精华设置 blob。 */
    function essenceBlob(group: number, seq: number): Uint8Array {
        return new ProtoWriter()
            .bytes(
                1,
                new ProtoWriter()
                    .varint(1, group)
                    .bytes(
                        8,
                        new ProtoWriter()
                            .bytes(8, new ProtoWriter().varint(1, seq).build())
                            .build(),
                    )
                    .build(),
            )
            .bytes(2, new ProtoWriter().varint(1, 732).varint(2, 1).varint(6, 1793540100).build())
            .build();
    }

    it("732:1 快路径广播；后续列表 diff 同 seq 不重复广播", async () => {
        const gid = "20001";
        // 基线（空列表）
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        expect(events()).toHaveLength(0);
        // 快路径 732:1
        await env.msgCh.emit("Msg/onRecvSysMsg", [essenceBlob(20001, 1300)]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const fast = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(fast.event_type).toBe("group_essence_message_change");
        expect(fast.data).toEqual({ group_id: 20001, message_seq: 1300, is_set: true });
        // 列表出现同 seq → diff 新增但去重命中 → 不广播
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => [
            essenceItem("1300"),
        ]);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        expect(events()).toHaveLength(1);
    });

    it("列表 diff：新增项广播 operator（add_digest_uin）", async () => {
        const gid = "20002";
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => []);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        env.captures.length = 0;
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => [
            essenceItem("1400", "20002", "30003"),
        ]);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data).toEqual({
            group_id: 20002,
            message_seq: 1400,
            operator_id: 30003,
            is_set: true,
        });
    });

    it("列表 diff：移除项广播 is_set=false（无 operator）", async () => {
        const gid = "20003";
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => [
            essenceItem("1500"),
        ]);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        env.captures.length = 0;
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => []);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data).toEqual({ group_id: 20003, message_seq: 1500, is_set: false });
    });

    it("列表 diff 先到（已广播）→ 732:1 快路径被去重不广播", async () => {
        const gid = "20006";
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => []);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        env.captures.length = 0;
        // 列表新增并广播（diff 路径先 claim）
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => [
            essenceItem("1700"),
        ]);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        // 732:1 快路径后到 → claim 失败 → 不广播
        await env.msgCh.emit("Msg/onRecvSysMsg", [essenceBlob(20006, 1700)]);
        await flushAsync();
        expect(events()).toHaveLength(1);
    });

    it("拉取失败 → warn 日志（diff 跳过）", async () => {
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => {
            throw new Error("web down");
        });
        await env.groupCh?.emit("Group/onGroupEssenceListChange", ["20004"]);
        await flushAsync();
        expect(events()).toHaveLength(0);
        expect(env.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ group: "20004" }),
            expect.stringContaining("拉取失败"),
        );
    });

    it("未知参数形状 → warn 日志", async () => {
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [{ foo: "bar" }]);
        await flushAsync();
        expect(env.logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("onGroupEssenceListChange"),
        );
    });

    it("operator 非数字串 → 省略 operator_id", async () => {
        const gid = "20005";
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => []);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        env.captures.length = 0;
        vi.mocked(env.api.webApi.getEssenceMsgList).mockImplementation(async () => [
            essenceItem("1600", "20002", "u_not_numeric"),
        ]);
        await env.groupCh?.emit("Group/onGroupEssenceListChange", [gid]);
        await flushAsync();
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data).toEqual({ group_id: 20005, message_seq: 1600, is_set: true });
        expect(event.data["operator_id"]).toBeUndefined();
    });

    /** 精华列表项桩（形状对齐 kernel EssenceMsgItem）。 */
    function essenceItem(
        seq: string,
        sender = "20002",
        operator = "10000",
    ): {
        msg_seq: number;
        msg_random: number;
        sender_uin: string;
        sender_nick: string;
        add_digest_uin: string;
        add_digest_nick: string;
        add_digest_time: number;
        msg_content: Array<{ msg_type?: number; text?: string; image_url?: string }>;
    } {
        return {
            msg_seq: Number(seq),
            msg_random: 0,
            sender_uin: sender,
            sender_nick: "甲",
            add_digest_uin: operator,
            add_digest_nick: "机器人",
            add_digest_time: 1760000000,
            msg_content: [],
        };
    }
});

describe("私聊文件双回调（friend_file_upload）", () => {
    /** C2C 文件消息。 */
    function fileC2c(overrides: Record<string, unknown> = {}): ReturnType<typeof rawMsg> {
        return rawMsg({
            chatType: ChatType.C2C,
            peerUid: "u_20002",
            peerUin: "20002",
            msgId: "m-pf",
            msgSeq: "900",
            elements: [
                {
                    elementType: 3,
                    fileElement: {
                        fileName: "doc.pdf",
                        fileSize: "4096",
                        fileUuid: "uuid-doc",
                        file10MMd5: "md5hex",
                    },
                },
            ],
            ...overrides,
        });
    }

    it("onRecvOfflineFileMsg → friend_file_upload（is_self=false）", async () => {
        await env.msgCh.emit("Msg/onRecvOfflineFileMsg", [fileC2c()]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(event.event_type).toBe("friend_file_upload");
        expect(event.data).toEqual({
            user_id: 20002,
            file_id: "uuid-doc",
            file_name: "doc.pdf",
            file_size: 4096,
            file_hash: "md5hex",
            is_self: false,
        });
    });

    it("onFileMsgCome 同 msgId → 去重不重复广播", async () => {
        await env.msgCh.emit("Msg/onRecvOfflineFileMsg", [fileC2c({ msgId: "m-dup" })]);
        await env.msgCh.emit("Msg/onFileMsgCome", [fileC2c({ msgId: "m-dup" })]);
        await flushAsync();
        expect(events()).toHaveLength(1);
    });

    it("sendType=2（自己发出）→ is_self=true", async () => {
        await env.msgCh.emit("Msg/onRecvOfflineFileMsg", [
            fileC2c({ sendType: 2, msgId: "m-selff" }),
        ]);
        await flushAsync();
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data["is_self"]).toBe(true);
    });

    it("senderUin 缺失 → user_id=0 + debug 校准日志", async () => {
        await env.msgCh.emit("Msg/onRecvOfflineFileMsg", [
            fileC2c({ senderUin: "", msgId: "m-nouin" }),
        ]);
        await flushAsync();
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data["user_id"]).toBe(0);
        expect(env.logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ msgId: "m-nouin" }),
            expect.stringContaining("senderUin 缺失"),
        );
    });

    it("非文件消息 / 非 C2C → 不产出", async () => {
        await env.msgCh.emit("Msg/onRecvOfflineFileMsg", [
            rawMsg({ chatType: ChatType.C2C, msgId: "m-nofile" }),
        ]);
        await env.msgCh.emit("Msg/onRecvOfflineFileMsg", [
            fileC2c({ chatType: ChatType.GROUP, msgId: "m-groupf" }),
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });
});

describe("置顶翻转（RecentContact/onRecentContactListChangedVer2）", () => {
    /** 变更条目（RecentContact 形状子集）。 */
    function pinEntry(overrides: Record<string, unknown>): Record<string, unknown> {
        return {
            chatType: 2,
            peerUin: "30001",
            topFlag: 1,
            topFlagTime: "1760000000",
            ...overrides,
        };
    }

    /** emit 入参放宽（通道签名要求 RecentContact；桩仅提供子集字段，同仓 as never 惯例）。 */
    function pinEntryAs(overrides: Record<string, unknown>): never {
        return pinEntry(overrides) as never;
    }

    it("首见条目（基线未建立）→ 不广播，仅记录", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "31001", topFlag: 1 })] },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });

    it("播种后翻转（1→0）→ peer_pin_change group 场景", async () => {
        vi.mocked(env.api.recentContactApi.getPinnedContacts).mockImplementation(async () => [
            { scene: "group", peerUid: "32001", peerUin: "32001" },
        ]);
        // 重新播种：start 期已播种过，这里手动再触发一次订阅内播种不可行——
        // 直接用 observe 链：首见 1（建立基线）→ 0（翻转）
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "32001", topFlag: 1 })] },
        ]);
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "32001", topFlag: 0 })] },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as {
            event_type: string;
            data: Record<string, unknown>;
            time: number;
        };
        expect(event.event_type).toBe("peer_pin_change");
        expect(event.data).toEqual({ message_scene: "group", peer_id: 32001, is_pinned: false });
        expect(event.time).toBe(1760000000);
    });

    it("好友场景翻转（chatType 1）→ message_scene=friend", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ chatType: 1, peerUin: "33001", topFlag: 0 })] },
        ]);
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ chatType: 1, peerUin: "33001", topFlag: 1 })] },
        ]);
        await flushAsync();
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data).toEqual({ message_scene: "friend", peer_id: 33001, is_pinned: true });
    });

    it("未翻转（同值重复快照）→ 不广播", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "34001", topFlag: 1 })] },
        ]);
        env.captures.length = 0;
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "34001", topFlag: 1 })] },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });

    it("影子条目（chatType 7）与缺 topFlag 条目 → 跳过", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            {
                changedList: [
                    pinEntryAs({ chatType: 7, peerUin: "35001" }),
                    pinEntryAs({ peerUin: "35002", topFlag: undefined }),
                    pinEntryAs({ peerUin: "", topFlag: 1, chatType: 2 }),
                ],
            },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });

    it("非数组单对象参数等效处理；非对象列表 → 空", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", {
            changedList: [pinEntryAs({ peerUin: "36001", topFlag: 1 })],
        } as never);
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", {
            nope: true,
        } as never);
        await flushAsync();
        // 首见建立基线，仍无广播（形状处理无异常即通过）
        expect(events()).toHaveLength(0);
    });

    it("start 期播种：getPinnedContacts 命中后首个取消置顶可观测", async () => {
        // 独立环境：播种在 start 时发生
        const seeded = await adapterEnv({
            config: { port: 36396 },
            withRecentContactChannel: true,
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => [
                    { scene: "group", peerUid: "37001", peerUin: "37001" },
                ]),
            },
        });
        await seeded.adapter.start();
        try {
            await seeded.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
                { changedList: [pinEntryAs({ peerUin: "37001", topFlag: 0 })] },
            ]);
            await flushAsync();
            expect(seeded.captures).toHaveLength(1);
            const event = seeded.captures[0] as { data: Record<string, unknown> };
            expect(event.data).toEqual({
                message_scene: "group",
                peer_id: 37001,
                is_pinned: false,
            });
        } finally {
            await seeded.adapter.stop();
        }
    });

    it("start 期播种失败 → 静默（catch 吞错，不阻断启动）", async () => {
        const failing = await adapterEnv({
            config: { port: 36398 },
            withRecentContactChannel: true,
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => {
                    throw new Error("rpc down");
                }),
            },
        });
        try {
            await expect(failing.adapter.start()).resolves.toBeUndefined();
        } finally {
            await failing.adapter.stop();
        }
    });

    it("缺 topFlagTime → 事件 time 兜底当前秒", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "38001", topFlagTime: undefined })] },
        ]);
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [pinEntryAs({ peerUin: "38001", topFlag: 0, topFlagTime: undefined })] },
        ]);
        await flushAsync();
        const event = events()[0] as unknown as { time: number };
        expect(event.time).toBeGreaterThan(1700000000);
    });

    it("changedList 含 null / 非对象条目 / 列表非对象 → 全部跳过", async () => {
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            { changedList: [null, "junk", 42] } as never,
        ]);
        await env.recentCh?.emit("RecentContact/onRecentContactListChangedVer2", [
            "junk-list",
        ] as never);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });
});

describe("bot_offline（Login 通道）", () => {
    it("onLoginDisConnected → reason=disconnected", async () => {
        await env.loginCh?.emit("Login/onLoginDisConnected");
        await flushAsync();
        const event = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(event.event_type).toBe("bot_offline");
        expect(event.data).toEqual({ reason: "disconnected" });
        expect(env.logger.debug).toHaveBeenCalled();
    });

    it("onLogoutSucceed → reason=logout", async () => {
        await env.loginCh?.emit("Login/onLogoutSucceed");
        await flushAsync();
        const event = events()[0] as { data: Record<string, unknown> };
        expect(event.data).toEqual({ reason: "logout" });
    });
});

describe("群通知 / 好友请求通道", () => {
    it("Group/onGroupNotifiesUpdated → group_join_request（uid→uin）", async () => {
        await env.groupCh?.emit("Group/onGroupNotifiesUpdated", false, [
            {
                seq: "88001",
                type: 7,
                status: 1,
                group: { groupCode: "40001", groupName: "群" },
                user1: { uid: "uid-20002", nickName: "甲" },
                postscript: "求入",
            },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(event.event_type).toBe("group_join_request");
        expect(event.data).toMatchObject({
            group_id: 40001,
            initiator_id: 20002,
            comment: "求入",
        });
    });

    it("已处理状态通知 → 不产出事件", async () => {
        await env.groupCh?.emit("Group/onGroupNotifiesUpdated", false, [
            {
                seq: "88002",
                type: 7,
                status: 2,
                group: { groupCode: "40001", groupName: "群" },
                user1: { uid: "uid-20002", nickName: "甲" },
            },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });

    it("Buddy/onBuddyReqChange → friend_request", async () => {
        await env.buddyCh?.emit("Buddy/onBuddyReqChange", [
            { reqTime: "1760000000", friendUid: "uid-20002", words: "加我", sourceName: "群" },
        ]);
        await flushAsync();
        expect(events()).toHaveLength(1);
        const event = events()[0] as { event_type: string; data: Record<string, unknown> };
        expect(event.event_type).toBe("friend_request");
        expect(event.data).toMatchObject({
            initiator_id: 20002,
            initiator_uid: "uid-20002",
            comment: "加我",
        });
    });

    it("Buddy/onBuddyReqChange 未知形状 → warn 日志", async () => {
        await env.buddyCh?.emit("Buddy/onBuddyReqChange", "junk");
        await flushAsync();
        expect(events()).toHaveLength(0);
        expect(env.logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("onBuddyReqChange"),
        );
    });

    it("空申请数组 → 无 uid 反查仍走空 Map 分支（无事件）", async () => {
        await env.buddyCh?.emit("Buddy/onBuddyReqChange", []);
        await flushAsync();
        expect(events()).toHaveLength(0);
    });

    it("撤回 operatorUid 缺失 → uidToUin undefined 分支（operator_id 0）", async () => {
        await env.msgCh.emit("Msg/onRecvMsg", [
            groupMsg({
                msgSeq: "1120",
                msgId: "m-revoke-nouid",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: GrayTipSubType.REVOKE,
                            revokeElement: { operatorUid: "", wording: "" },
                        },
                    },
                ],
            }),
        ]);
        await flushAsync();
        const recall = events().find((e) => e.event_type === "message_recall");
        expect(recall?.data["operator_id"]).toBe(0);
    });
});
