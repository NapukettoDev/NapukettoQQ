/**
 * Milky 群类动作测试（group.ts，p3 系列）
 *
 * 锁定：群信息/成员查询（GroupCache 与直查双路径）、群管动作的 uin→uid 与
 * 参数换算（admin role 3/2、禁言 duration 缺省、kick reject_add_request）、
 * 精华 seq→msgId 反查（NOT_FOUND）、表情表态 reaction_type 映射、群通知应答
 * （KAGREE/KREFUSE + doubt 标志）、公告映射（senderUid→uin / pic url）、
 * 群头像/头衔、nudge self.uid 缺失、未知通知类型过滤。
 */

import { join } from "node:path";
import {
    ChatType,
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    NTGroupRequestOperateTypes,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import {
    type ApiOverrides,
    actionOf,
    buildMilkyApi,
    detailStub,
    memberStub,
    registryOf,
} from "./test-support.js";

/** 群管依赖桩（groupApi 方法可覆写，缺省全 vi.fn）。 */
function groupRegistry(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            groupApi: {
                modifyGroupName: vi.fn(async () => undefined),
                setMemberCardName: vi.fn(async () => undefined),
                setMemberRole: vi.fn(async () => undefined),
                setMemberShutUp: vi.fn(async () => undefined),
                setGroupShutUp: vi.fn(async () => undefined),
                kickMember: vi.fn(async () => undefined),
                quitGroup: vi.fn(async () => undefined),
                getGroupInfo: vi.fn(async () => detailStub()),
                getGroupMemberList: vi.fn(async () => [memberStub()]),
                removeGroupEssence: vi.fn(async () => undefined),
                addGroupEssence: vi.fn(async () => undefined),
                getGroupAnnouncements: vi.fn(async () => []),
                publishGroupAnnouncement: vi.fn(async () => undefined),
                deleteGroupAnnouncement: vi.fn(async () => undefined),
                setGroupAvatar: vi.fn(async () => undefined),
                setMemberSpecialTitle: vi.fn(async () => undefined),
                ...overrides.groupApi,
            },
            msgApi: {
                setMsgEmojiLike: vi.fn(async () => undefined),
                sendNudge: vi.fn(async () => null),
                fetchMessages: vi.fn(async () => []),
                ...overrides.msgApi,
            },
            webApi: {
                getEssenceMsgList: vi.fn(async () => []),
                ...overrides.webApi,
            },
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => []),
                handleGroupRequest: vi.fn(async () => undefined),
                ...overrides.groupNotifyApi,
            },
            ...(overrides.selfUid !== undefined ? { selfUid: overrides.selfUid } : {}),
            ...(overrides.groupCache !== undefined ? { groupCache: overrides.groupCache } : {}),
        }),
    );
}

describe("get_group_info / get_group_member_list", () => {
    it("无缓存：直查 groupApi.getGroupInfo 并映射实体", async () => {
        const getGroupInfo = vi.fn(async () => detailStub());
        const registry = groupRegistry({ groupApi: { getGroupInfo } });
        const res = await actionOf(registry, "get_group_info").handle({ group_id: 10001 });
        expect(getGroupInfo).toHaveBeenCalledWith("10001");
        expect(res.data).toEqual({
            group: {
                group_id: 10001,
                group_name: "测试群",
                member_count: 3,
                max_member_count: 500,
                remark: "群备注",
                created_time: 1760000000,
                description: "",
                question: "",
                announcement: "",
            },
        });
    });

    it("有缓存：getGroupDetail 优先于 getGroupInfo", async () => {
        const getGroupInfo = vi.fn(async () => detailStub());
        const getGroupDetail = vi.fn(async () => detailStub({ groupName: "缓存群名" }));
        const registry = groupRegistry({
            groupApi: { getGroupInfo },
            groupCache: { getGroupDetail },
        });
        const res = await actionOf(registry, "get_group_info").handle({ group_id: 10001 });
        expect(getGroupDetail).toHaveBeenCalledWith("10001");
        expect(getGroupInfo).not.toHaveBeenCalled();
        const group = (res.data as { group: { group_name: string } }).group;
        expect(group.group_name).toBe("缓存群名");
    });

    it("成员列表：缓存优先（getMembers），直查兜底", async () => {
        const getGroupMemberList = vi.fn(async () => [memberStub({ uin: "20002", nick: "直查" })]);
        const registry = groupRegistry({ groupApi: { getGroupMemberList } });
        const res = await actionOf(registry, "get_group_member_list").handle({ group_id: 10001 });
        expect(getGroupMemberList).toHaveBeenCalledWith("10001", true);
        const members = (res.data as { members: Array<{ nickname: string; user_id: number }> })
            .members;
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ user_id: 20002, nickname: "直查" });
    });

    it("成员列表：缓存路径走 groupCache.getMembers", async () => {
        const getMembers = vi.fn(async () => [memberStub({ nick: "缓存成员" })]);
        const registry = groupRegistry({ groupCache: { getMembers } });
        const res = await actionOf(registry, "get_group_member_list").handle({ group_id: 10001 });
        expect(getMembers).toHaveBeenCalledWith("10001");
        const members = (res.data as { members: Array<{ nickname: string }> }).members;
        expect(members[0]?.nickname).toBe("缓存成员");
    });
});

describe("get_group_member_info", () => {
    it("缓存路径：uin→uid 解析后单查，命中返回实体", async () => {
        const getMember = vi.fn(async () => memberStub({ cardName: "名片" }));
        const registry = groupRegistry({
            groupCache: { getMember },
            groupApi: {},
        });
        const res = await actionOf(registry, "get_group_member_info").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(getMember).toHaveBeenCalledWith("10001", "uid-20002");
        const member = (res.data as { member: { card: string; user_id: number } }).member;
        expect(member.card).toBe("名片");
        expect(member.user_id).toBe(20002);
    });

    it("缓存路径：成员缺失 → NOT_FOUND", async () => {
        const getMember = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupCache: { getMember } });
        const res = await actionOf(registry, "get_group_member_info").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("成员 20002 不在群 10001");
    });

    it("直查路径：按 uin 匹配列表命中", async () => {
        const getGroupMemberList = vi.fn(async () => [memberStub({ uin: "20002" })]);
        const registry = groupRegistry({ groupApi: { getGroupMemberList } });
        const res = await actionOf(registry, "get_group_member_info").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.status).toBe("ok");
        const member = (res.data as { member: { user_id: number } }).member;
        expect(member.user_id).toBe(20002);
    });

    it("直查路径：未命中 → NOT_FOUND", async () => {
        const registry = groupRegistry({ groupApi: { getGroupMemberList: vi.fn(async () => []) } });
        const res = await actionOf(registry, "get_group_member_info").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.retcode).toBe(-404);
    });

    it("缓存路径：uin→uid 转换失败 → 以 uin 原样单查（兜底）", async () => {
        const getMember = vi.fn(async () => memberStub());
        const registry = groupRegistry({
            groupCache: { getMember },
            groupApi: { uinToUid: vi.fn(async () => new Map()) },
        });
        await actionOf(registry, "get_group_member_info").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(getMember).toHaveBeenCalledWith("10001", "20002");
    });
});

describe("群管动作（set_* / kick / quit）", () => {
    it("set_group_name：群号字符串化透传", async () => {
        const modifyGroupName = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { modifyGroupName } });
        const res = await actionOf(registry, "set_group_name").handle({
            group_id: 10001,
            new_group_name: "新群名",
        });
        expect(res.status).toBe("ok");
        expect(modifyGroupName).toHaveBeenCalledWith("10001", "新群名");
    });

    it("set_group_member_card：uin→uid + card 透传", async () => {
        const setMemberCardName = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberCardName } });
        await actionOf(registry, "set_group_member_card").handle({
            group_id: 10001,
            user_id: 20002,
            card: "新名片",
        });
        expect(setMemberCardName).toHaveBeenCalledWith("10001", "uid-20002", "新名片");
    });

    it("set_group_member_admin：is_set 缺省 → ADMIN(3)；false → MEMBER(2)", async () => {
        const setMemberRole = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberRole } });
        await actionOf(registry, "set_group_member_admin").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(setMemberRole).toHaveBeenLastCalledWith("10001", "uid-20002", 3);
        await actionOf(registry, "set_group_member_admin").handle({
            group_id: 10001,
            user_id: 20002,
            is_set: false,
        });
        expect(setMemberRole).toHaveBeenLastCalledWith("10001", "uid-20002", 2);
    });

    it("set_group_member_mute：duration 缺省 0（解除禁言）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberShutUp } });
        await actionOf(registry, "set_group_member_mute").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid-20002", duration: 0 }]);
        await actionOf(registry, "set_group_member_mute").handle({
            group_id: 10001,
            user_id: 20002,
            duration: 600,
        });
        expect(setMemberShutUp).toHaveBeenLastCalledWith("10001", [
            { uid: "uid-20002", duration: 600 },
        ]);
    });

    it("set_group_whole_mute：is_mute 缺省 true；false → 解除", async () => {
        const setGroupShutUp = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setGroupShutUp } });
        await actionOf(registry, "set_group_whole_mute").handle({ group_id: 10001 });
        expect(setGroupShutUp).toHaveBeenLastCalledWith("10001", true);
        await actionOf(registry, "set_group_whole_mute").handle({
            group_id: 10001,
            is_mute: false,
        });
        expect(setGroupShutUp).toHaveBeenLastCalledWith("10001", false);
    });

    it("kick_group_member：reject_add_request 缺省 false；true 透传", async () => {
        const kickMember = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { kickMember } });
        await actionOf(registry, "kick_group_member").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(kickMember).toHaveBeenLastCalledWith("10001", ["uid-20002"], false);
        await actionOf(registry, "kick_group_member").handle({
            group_id: 10001,
            user_id: 20002,
            reject_add_request: true,
        });
        expect(kickMember).toHaveBeenLastCalledWith("10001", ["uid-20002"], true);
    });

    it("quit_group：退出群聊", async () => {
        const quitGroup = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { quitGroup } });
        const res = await actionOf(registry, "quit_group").handle({ group_id: 10001 });
        expect(res.status).toBe("ok");
        expect(quitGroup).toHaveBeenCalledWith("10001");
    });

    it("uin→uid 转换失败 → INVALID_PARAM（-400）", async () => {
        const registry = groupRegistry({
            groupApi: { uinToUid: vi.fn(async () => new Map()) },
        });
        const res = await actionOf(registry, "set_group_member_card").handle({
            group_id: 10001,
            user_id: 20002,
            card: "x",
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("不存在或 uin→uid 转换失败");
    });
});

describe("精华消息（set / list）", () => {
    it("set_group_essence_message：seq→msgId 反查后 addGroupEssence（is_set 缺省）", async () => {
        const addGroupEssence = vi.fn(async () => undefined);
        const api = buildMilkyApi({ groupApi: { addGroupEssence } });
        // 预登记 seq 索引（chatType GROUP + peerUid 10001 + seq 150）
        api.seqIndex.record({
            msgId: "m-150",
            msgSeq: "150",
            msgTime: "1760000000000",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "20002",
            senderUid: "uid-20002",
            elements: [],
        } as never);
        const registry = registryOf(api);
        const res = await actionOf(registry, "set_group_essence_message").handle({
            group_id: 10001,
            message_seq: 150,
        });
        expect(res.status).toBe("ok");
        expect(addGroupEssence).toHaveBeenCalledWith("10001", "m-150");
    });

    it("set_group_essence_message：is_set=false → removeGroupEssence", async () => {
        const removeGroupEssence = vi.fn(async () => undefined);
        const api = buildMilkyApi({ groupApi: { removeGroupEssence } });
        api.seqIndex.record({
            msgId: "m-9",
            msgSeq: "9",
            msgTime: "1760000000000",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "20002",
            senderUid: "uid-20002",
            elements: [],
        } as never);
        const registry = registryOf(api);
        await actionOf(registry, "set_group_essence_message").handle({
            group_id: 10001,
            message_seq: 9,
            is_set: false,
        });
        expect(removeGroupEssence).toHaveBeenCalledWith("10001", "m-9");
    });

    it("seq 反查未命中（近段扫描也无）→ NOT_FOUND", async () => {
        const fetchMessages = vi.fn(async () => []);
        const registry = groupRegistry({ msgApi: { fetchMessages } });
        const res = await actionOf(registry, "set_group_essence_message").handle({
            group_id: 10001,
            message_seq: 999,
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("消息 999 不存在");
    });

    it("get_group_essence_messages：客户端分页 + is_end 判定", async () => {
        const essenceItem = () => ({
            msg_seq: 1,
            msg_random: 0,
            sender_uin: "20002",
            sender_nick: "甲",
            add_digest_uin: "10000",
            add_digest_nick: "机器人",
            add_digest_time: 1760000000,
            msg_content: [],
        });
        const getEssenceMsgList = vi.fn(async () => [essenceItem(), essenceItem(), essenceItem()]);
        const registry = groupRegistry({ webApi: { getEssenceMsgList } });
        const page = await actionOf(registry, "get_group_essence_messages").handle({
            group_id: 10001,
            page_index: 1,
            page_size: 2,
        });
        const pageData = page.data as { messages: unknown[]; is_end: boolean };
        expect(pageData.messages).toHaveLength(1);
        expect(pageData.is_end).toBe(true);
        const first = await actionOf(registry, "get_group_essence_messages").handle({
            group_id: 10001,
            page_index: 0,
            page_size: 2,
        });
        const firstData = first.data as { messages: unknown[]; is_end: boolean };
        expect(firstData.messages).toHaveLength(2);
        expect(firstData.is_end).toBe(false);
    });

    it("get_group_essence_messages：空文本空图片的 msg_content 跳过", async () => {
        const getEssenceMsgList = vi.fn(async () => [
            {
                msg_seq: 5,
                sender_uin: "",
                sender_nick: "n",
                add_digest_uin: "x",
                add_digest_nick: "op",
                add_digest_time: 0,
                msg_content: [
                    { msg_type: 1, text: "" },
                    { msg_type: 2, image_url: "" },
                ],
            },
        ]);
        const registry = groupRegistry({ webApi: { getEssenceMsgList } });
        const res = await actionOf(registry, "get_group_essence_messages").handle({
            group_id: 10001,
            page_index: 0,
            page_size: 10,
        });
        const data = res.data as {
            messages: Array<{ sender_id: number; operator_id: number; segments: unknown[] }>;
        };
        expect(data.messages[0]?.segments).toEqual([]);
        expect(data.messages[0]?.sender_id).toBe(0);
        expect(data.messages[0]?.operator_id).toBe(0);
    });
});

describe("send_group_message_reaction", () => {
    it("face + is_add 缺省：emojiType=1 / like=true", async () => {
        const setMsgEmojiLike = vi.fn(async () => undefined);
        const registry = groupRegistry({ msgApi: { setMsgEmojiLike } });
        const res = await actionOf(registry, "send_group_message_reaction").handle({
            group_id: 10001,
            message_seq: 150,
            reaction: "76",
        });
        expect(res.status).toBe("ok");
        expect(setMsgEmojiLike).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { msgSeq: "150", emojiId: "76", emojiType: "1", like: true },
        );
    });

    it("emoji + is_add=false：emojiType=2 / like=false", async () => {
        const setMsgEmojiLike = vi.fn(async () => undefined);
        const registry = groupRegistry({ msgApi: { setMsgEmojiLike } });
        await actionOf(registry, "send_group_message_reaction").handle({
            group_id: 10001,
            message_seq: 150,
            reaction: "5",
            reaction_type: "emoji",
            is_add: false,
        });
        expect(setMsgEmojiLike).toHaveBeenCalledWith(expect.anything(), {
            msgSeq: "150",
            emojiId: "5",
            emojiType: "2",
            like: false,
        });
    });

    it("reaction 空串 → -400", async () => {
        const registry = groupRegistry({});
        const res = await actionOf(registry, "send_group_message_reaction").handle({
            group_id: 10001,
            message_seq: 1,
            reaction: "",
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("群通知应答（accept/reject request + invitation）", () => {
    const notify = () => ({
        seq: "88001",
        type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        group: { groupCode: "10001", groupName: "群" },
        user1: { uid: "uid-20002", nickName: "甲" },
    });

    it("accept_group_request：KAGREE + doubt=is_filtered", async () => {
        const handleGroupRequest = vi.fn(async () => undefined);
        const registry = groupRegistry({
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => [notify()]),
                handleGroupRequest,
            },
        });
        const res = await actionOf(registry, "accept_group_request").handle({
            notification_seq: 88001,
            notification_type: "join_request",
            group_id: 10001,
        });
        expect(res.status).toBe("ok");
        expect(handleGroupRequest).toHaveBeenCalledWith(
            false,
            expect.objectContaining({ seq: "88001" }),
            NTGroupRequestOperateTypes.KAGREE,
            " ",
        );
    });

    it("reject_group_request：KREFUSE + is_filtered → doubt=true", async () => {
        const handleGroupRequest = vi.fn(async () => undefined);
        const registry = groupRegistry({
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => [notify()]),
                handleGroupRequest,
            },
        });
        await actionOf(registry, "reject_group_request").handle({
            notification_seq: 88001,
            notification_type: "join_request",
            group_id: 10001,
            is_filtered: true,
        });
        expect(handleGroupRequest).toHaveBeenCalledWith(
            true,
            expect.anything(),
            NTGroupRequestOperateTypes.KREFUSE,
            " ",
        );
    });

    it("accept/reject_group_invitation：invitation_seq 匹配 + doubt=false", async () => {
        const handleGroupRequest = vi.fn(async () => undefined);
        const registry = groupRegistry({
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => [notify()]),
                handleGroupRequest,
            },
        });
        await actionOf(registry, "accept_group_invitation").handle({
            group_id: 10001,
            invitation_seq: 88001,
        });
        expect(handleGroupRequest).toHaveBeenCalledWith(
            false,
            expect.anything(),
            NTGroupRequestOperateTypes.KAGREE,
            " ",
        );
        await actionOf(registry, "reject_group_invitation").handle({
            group_id: 10001,
            invitation_seq: 88001,
        });
        expect(handleGroupRequest).toHaveBeenLastCalledWith(
            false,
            expect.anything(),
            NTGroupRequestOperateTypes.KREFUSE,
            " ",
        );
    });

    it("notification_seq 无效 → NOT_FOUND（-404）", async () => {
        const registry = groupRegistry({});
        const res = await actionOf(registry, "accept_group_request").handle({
            notification_seq: 1,
            notification_type: "join_request",
            group_id: 10001,
        });
        expect(res.retcode).toBe(-404);
    });

    it("notification_type 非法 → -400", async () => {
        const registry = groupRegistry({});
        const res = await actionOf(registry, "accept_group_request").handle({
            notification_seq: 1,
            notification_type: "bogus",
            group_id: 10001,
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("send_group_nudge", () => {
    it("uin→uid + confId=群号 peer + callerUid=self.uid", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = groupRegistry({ msgApi: { sendNudge } });
        const res = await actionOf(registry, "send_group_nudge").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.status).toBe("ok");
        expect(sendNudge).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { receiverUid: "uid-20002", callerUid: "uid-10000" },
        );
    });

    it("self.uid 缺失 → INVALID_PARAM（-400）", async () => {
        const registry = groupRegistry({ selfUid: "" });
        const res = await actionOf(registry, "send_group_nudge").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("登录身份缺 uid");
    });
});

describe("群公告（get / send / delete）", () => {
    it("get_group_announcements：bulletin 映射 + senderUid→uin + pic url", async () => {
        const getGroupAnnouncements = vi.fn(async () => [
            {
                announcementId: "a1",
                senderUid: "uid-20002",
                publishTime: "1760000000",
                content: "公告正文",
                pic: { url: "https://img.example/a.png" },
            },
            { content: "无 id 公告" },
        ]);
        const registry = groupRegistry({ groupApi: { getGroupAnnouncements } });
        const res = await actionOf(registry, "get_group_announcements").handle({ group_id: 10001 });
        const data = res.data as { announcements: Record<string, unknown>[] };
        expect(data.announcements[0]).toEqual({
            group_id: 10001,
            announcement_id: "a1",
            user_id: 20002,
            time: 1760000000,
            content: "公告正文",
            image_url: "https://img.example/a.png",
        });
        expect(data.announcements[1]).toEqual({
            group_id: 10001,
            announcement_id: "",
            user_id: 0,
            time: 0,
            content: "无 id 公告",
            image_url: null,
        });
    });

    it("send_group_announcement：无图直发 publishGroupBulletin 链", async () => {
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { publishGroupAnnouncement } });
        const res = await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "正文",
        });
        expect(res.status).toBe("ok");
        expect(publishGroupAnnouncement).toHaveBeenCalledWith("10001", "正文", undefined);
    });

    it("send_group_announcement：file:// image_uri 展开本地路径后透传", async () => {
        const { pathToFileURL } = await import("node:url");
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { publishGroupAnnouncement } });
        const filePath = join("盘", "公告.png");
        const res = await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "带图公告",
            image_uri: pathToFileURL(filePath).href,
        });
        expect(res.status).toBe("ok");
        const [, , imageArg] = publishGroupAnnouncement.mock.calls[0] as unknown as [
            string,
            string,
            string,
        ];
        expect(imageArg.endsWith("公告.png")).toBe(true);
    });

    it("send_group_announcement：image_uri 空串视同无图", async () => {
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { publishGroupAnnouncement } });
        await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "正文",
            image_uri: "",
        });
        expect(publishGroupAnnouncement).toHaveBeenCalledWith("10001", "正文", undefined);
    });

    it("delete_group_announcement：id 透传", async () => {
        const deleteGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { deleteGroupAnnouncement } });
        await actionOf(registry, "delete_group_announcement").handle({
            group_id: 10001,
            announcement_id: "a1",
        });
        expect(deleteGroupAnnouncement).toHaveBeenCalledWith("10001", "a1");
    });

    it("公告 content 空串 → -400", async () => {
        const registry = groupRegistry({});
        const res = await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "",
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("set_group_avatar / set_group_member_special_title", () => {
    it("set_group_avatar：裸路径 image_uri 原样透传", async () => {
        const setGroupAvatar = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setGroupAvatar } });
        const res = await actionOf(registry, "set_group_avatar").handle({
            group_id: 10001,
            image_uri: join("some", "avatar.png"),
        });
        expect(res.status).toBe("ok");
        expect(setGroupAvatar).toHaveBeenCalledWith("10001", join("some", "avatar.png"));
    });

    it("set_group_member_special_title：uin→uid + 头衔透传", async () => {
        const setMemberSpecialTitle = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberSpecialTitle } });
        await actionOf(registry, "set_group_member_special_title").handle({
            group_id: 10001,
            user_id: 20002,
            special_title: "头衔",
        });
        expect(setMemberSpecialTitle).toHaveBeenCalledWith("10001", "uid-20002", "头衔");
    });
});

describe("get_group_notifications 补充分支", () => {
    /** 最小通知（user1 带 uid；type 用例覆写）。 */
    const bareNotify = (type: number, seq = "88001") => ({
        seq,
        type,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        group: { groupCode: "10001" },
        user1: { uid: "uid-20002" },
    });

    it("未知通知类型 → null 实体（过滤不产出）", async () => {
        const getSingleScreenNotifies = vi.fn(async () => [bareNotify(1)]); // 邀请自身：无实体变体
        const registry = groupRegistry({ groupNotifyApi: { getSingleScreenNotifies } });
        const res = await actionOf(registry, "get_group_notifications").handle({});
        const data = res.data as { notifications: unknown[]; next_notification_seq: unknown };
        expect(data.notifications).toEqual([]);
        expect(data.next_notification_seq).toBeNull();
    });

    it("is_filtered=true → getSingleScreenNotifies(doubt=true)", async () => {
        const getSingleScreenNotifies = vi.fn(async () => []);
        const registry = groupRegistry({ groupNotifyApi: { getSingleScreenNotifies } });
        await actionOf(registry, "get_group_notifications").handle({ is_filtered: true });
        expect(getSingleScreenNotifies).toHaveBeenCalledWith(true, expect.any(Number));
    });

    it("uid→uin 转换失败 → 实体 id 兜底 0（不抛）", async () => {
        const getSingleScreenNotifies = vi.fn(async () => [
            bareNotify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS),
        ]);
        const registry = groupRegistry({
            groupNotifyApi: { getSingleScreenNotifies },
            groupApi: { uidToUin: vi.fn(async () => new Map()) },
        });
        const res = await actionOf(registry, "get_group_notifications").handle({});
        const data = res.data as { notifications: Array<{ initiator_id: number }> };
        expect(data.notifications[0]?.initiator_id).toBe(0);
    });

    it("limit 截断 → next 取本页最小 seq", async () => {
        const mk = (seq: string) => ({
            seq,
            type: GroupNotifyMsgType.MEMBER_LEAVE_NOTIFY_ADMIN,
            status: GroupNotifyMsgStatus.KUNHANDLE,
            group: { groupCode: "10001" },
            user1: { uid: "uid-20002" },
        });
        const getSingleScreenNotifies = vi.fn(async () => [mk("300"), mk("200"), mk("100")]);
        const registry = groupRegistry({ groupNotifyApi: { getSingleScreenNotifies } });
        const res = await actionOf(registry, "get_group_notifications").handle({ limit: 2 });
        const data = res.data as {
            notifications: Array<{ notification_seq: number }>;
            next_notification_seq: number | null;
        };
        expect(data.notifications).toHaveLength(2);
        expect(data.next_notification_seq).toBe(200);
    });
});
