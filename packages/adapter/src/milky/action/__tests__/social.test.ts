/**
 * Milky 社交类动作测试（social.ts，2026-11-14 域对齐重组，自 p3-social.test.ts
 * + p2-batch2 / p1-actions 社交用例归并）
 *
 * 锁定：好友/群列表（缓存与直查双路径）、send_profile_like count 缺省、
 * delete_friend、get_friend_requests（words 字段防御 + uid→uin 失败 0 兜底 +
 * limit 截断）、accept/reject_friend_request（NOT_FOUND 路径）、
 * send_friend_nudge（is_self 戳自己）、get_peer_pins（好友/群实体匹配与跳过）、
 * set_peer_pin（is_pinned 缺省）、findBuddyReq 匹配（api.js 共享查找）。
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { findBuddyReq } from "../../api.js";
import {
    type ApiOverrides,
    actionOf,
    buildMilkyApi,
    friendStub,
    registryOf,
} from "./test-support.js";

/** 社交类依赖桩。 */
function socialRegistry(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            groupApi: {
                getGroupList: vi.fn(async () => [
                    { groupCode: "10001", groupName: "测试群", memberCount: 9, maxMember: 100 },
                ]),
                ...overrides.groupApi,
            },
            friendApi: {
                getFriendList: vi.fn(async () => [friendStub()]),
                deleteFriend: vi.fn(async () => undefined),
                handleFriendRequest: vi.fn(async () => undefined),
                getBuddyReqList: vi.fn(async () => [
                    {
                        reqTime: "1760000000",
                        friendUid: "uid-20002",
                        words: "加我",
                        sourceName: "搜索",
                    },
                ]),
                ...overrides.friendApi,
            },
            profileLikeApi: {
                sendLike: vi.fn(async () => undefined),
                ...overrides.profileLikeApi,
            },
            msgApi: {
                sendNudge: vi.fn(async () => null),
                setContactTop: vi.fn(async () => undefined),
                ...overrides.msgApi,
            },
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => []),
                ...overrides.recentContactApi,
            },
            ...(overrides.selfUid !== undefined ? { selfUid: overrides.selfUid } : {}),
            ...(overrides.groupCache !== undefined ? { groupCache: overrides.groupCache } : {}),
        }),
    );
}

describe("get_friend_list / get_group_list", () => {
    it("get_friend_list：Friend → FriendEntity（uid/uin/昵称/备注）", async () => {
        const registry = socialRegistry();
        const res = await actionOf(registry, "get_friend_list").handle({});
        expect(res.data).toEqual({
            friends: [
                {
                    user_id: 20002,
                    nickname: "甲",
                    sex: "unknown",
                    qid: "",
                    remark: "备注甲",
                    category: { category_id: 0, category_name: "" },
                },
            ],
        });
    });

    it("get_group_list：无缓存走 groupApi.getGroupList(true)", async () => {
        const getGroupList = vi.fn(async () => [
            { groupCode: "10001", groupName: "测试群", memberCount: 9, maxMember: 100 },
        ]);
        const registry = socialRegistry({ groupApi: { getGroupList } });
        const res = await actionOf(registry, "get_group_list").handle({});
        expect(getGroupList).toHaveBeenCalledWith(true);
        const groups = (res.data as { groups: Array<{ group_id: number; group_name: string }> })
            .groups;
        expect(groups[0]).toMatchObject({ group_id: 10001, group_name: "测试群" });
    });

    it("get_group_list：缓存优先 listGroupsRefreshed", async () => {
        const listGroupsRefreshed = vi.fn(async () => [
            { groupCode: "10002", groupName: "缓存群", memberCount: 9, maxMember: 100 },
        ]);
        const registry = socialRegistry({ groupCache: { listGroupsRefreshed } });
        const res = await actionOf(registry, "get_group_list").handle({});
        const groups = (res.data as { groups: Array<{ group_id: number; member_count: number }> })
            .groups;
        expect(groups[0]).toMatchObject({ group_id: 10002, member_count: 9 });
    });
});

describe("send_profile_like / delete_friend", () => {
    it("send_profile_like：count 缺省 1；显式 count 透传", async () => {
        const sendLike = vi.fn(async () => undefined);
        const registry = socialRegistry({ profileLikeApi: { sendLike } });
        await actionOf(registry, "send_profile_like").handle({ user_id: 20002 });
        expect(sendLike).toHaveBeenLastCalledWith("uid-20002", 1);
        await actionOf(registry, "send_profile_like").handle({ user_id: 20002, count: 10 });
        expect(sendLike).toHaveBeenLastCalledWith("uid-20002", 10);
    });

    it("send_profile_like：uin→uid 失败 → -400", async () => {
        const registry = socialRegistry({
            groupApi: { uinToUid: vi.fn(async () => new Map()) },
        });
        const res = await actionOf(registry, "send_profile_like").handle({ user_id: 20002 });
        expect(res.retcode).toBe(-400);
    });

    it("delete_friend：uin→uid 后透传", async () => {
        const deleteFriend = vi.fn(async () => undefined);
        const registry = socialRegistry({ friendApi: { deleteFriend } });
        const res = await actionOf(registry, "delete_friend").handle({ user_id: 20002 });
        expect(res.status).toBe("ok");
        expect(deleteFriend).toHaveBeenCalledWith("uid-20002");
    });
});

describe("get_friend_requests", () => {
    it("words 字符串进 comment；via 取 sourceName；target 为自身", async () => {
        const registry = socialRegistry();
        const res = await actionOf(registry, "get_friend_requests").handle({});
        expect(res.data).toEqual({
            requests: [
                {
                    time: 1760000000,
                    initiator_id: 20002,
                    initiator_uid: "uid-20002",
                    target_user_id: 10000,
                    target_user_uid: "uid-10000",
                    state: "pending",
                    comment: "加我",
                    via: "搜索",
                    is_filtered: false,
                },
            ],
        });
    });

    it("words 非字符串 → comment 空串（防御）", async () => {
        const registry = socialRegistry({
            friendApi: {
                getBuddyReqList: vi.fn(async () => [
                    { reqTime: "abc", friendUid: "uid-20002", words: 123 },
                ]),
            },
        });
        const res = await actionOf(registry, "get_friend_requests").handle({});
        const reqs = (res.data as { requests: Array<{ comment: string; time: number }> }).requests;
        expect(reqs[0]?.comment).toBe("");
        expect(reqs[0]?.time).toBe(0);
    });

    it("uid→uin 失败 → initiator_id 兜底 0", async () => {
        const registry = socialRegistry({
            groupApi: { uidToUin: vi.fn(async () => new Map()) },
        });
        const res = await actionOf(registry, "get_friend_requests").handle({});
        const reqs = (res.data as { requests: Array<{ initiator_id: number }> }).requests;
        expect(reqs[0]?.initiator_id).toBe(0);
    });

    it("limit 截断", async () => {
        const registry = socialRegistry({
            friendApi: {
                getBuddyReqList: vi.fn(async () => [
                    { reqTime: "1", friendUid: "uid-20002" },
                    { reqTime: "2", friendUid: "uid-30003" },
                ]),
            },
        });
        const res = await actionOf(registry, "get_friend_requests").handle({ limit: 1 });
        expect((res.data as { requests: unknown[] }).requests).toHaveLength(1);
    });

    it("无申请时不调用 uidToUin", async () => {
        const uidToUin = vi.fn(async () => new Map<string, string>());
        const registry = socialRegistry({
            friendApi: { getBuddyReqList: vi.fn(async () => []) },
            groupApi: { uidToUin },
        });
        await actionOf(registry, "get_friend_requests").handle({});
        expect(uidToUin).not.toHaveBeenCalled();
    });
});

describe("accept/reject_friend_request", () => {
    it("accept：findBuddyReq 命中后 handleFriendRequest(true)", async () => {
        const handleFriendRequest = vi.fn(async () => undefined);
        const registry = socialRegistry({ friendApi: { handleFriendRequest } });
        const res = await actionOf(registry, "accept_friend_request").handle({
            initiator_uid: "uid-20002",
        });
        expect(res.status).toBe("ok");
        expect(handleFriendRequest).toHaveBeenCalledWith(
            expect.objectContaining({ friendUid: "uid-20002" }),
            true,
        );
    });

    it("reject：handleFriendRequest(false)", async () => {
        const handleFriendRequest = vi.fn(async () => undefined);
        const registry = socialRegistry({ friendApi: { handleFriendRequest } });
        await actionOf(registry, "reject_friend_request").handle({
            initiator_uid: "uid-20002",
        });
        expect(handleFriendRequest).toHaveBeenCalledWith(expect.anything(), false);
    });

    it("initiator_uid 无匹配申请 → NOT_FOUND（-404）", async () => {
        const registry = socialRegistry({});
        const res = await actionOf(registry, "accept_friend_request").handle({
            initiator_uid: "uid-99999",
        });
        expect(res.retcode).toBe(-404);
    });

    it("initiator_uid 空串 → -400（schema min(1)）", async () => {
        const registry = socialRegistry({});
        const res = await actionOf(registry, "accept_friend_request").handle({
            initiator_uid: "",
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("send_friend_nudge", () => {
    it("is_self=true：receiver = callerUid（peer 解析仍走 uin→uid）", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = socialRegistry({ msgApi: { sendNudge } });
        const res = await actionOf(registry, "send_friend_nudge").handle({
            user_id: 20002,
            is_self: true,
        });
        expect(res.status).toBe("ok");
        expect(sendNudge).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "uid-20002" },
            { receiverUid: "uid-10000", callerUid: "uid-10000" },
        );
    });

    it("is_self 缺省：receiver = uin→uid 转换结果", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = socialRegistry({ msgApi: { sendNudge } });
        await actionOf(registry, "send_friend_nudge").handle({ user_id: 20002 });
        expect(sendNudge).toHaveBeenCalledWith(expect.anything(), {
            receiverUid: "uid-20002",
            callerUid: "uid-10000",
        });
    });

    it("self.uid 缺失 → -400（不触 sendNudge）", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = socialRegistry({ msgApi: { sendNudge }, selfUid: "" });
        const res = await actionOf(registry, "send_friend_nudge").handle({ user_id: 20002 });
        expect(res.retcode).toBe(-400);
        expect(sendNudge).not.toHaveBeenCalled();
    });

    it("is_self：receiver = 自己 uid（P2 批次二补测）", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = socialRegistry({ msgApi: { sendNudge } });
        await actionOf(registry, "send_friend_nudge").handle({ user_id: 20002, is_self: true });
        expect(sendNudge).toHaveBeenCalledTimes(1);
    });

    it("self.uid 缺失 → -400（P2 批次二补测）", async () => {
        const registry = socialRegistry({ selfUid: "" });
        const res = await actionOf(registry, "send_friend_nudge").handle({ user_id: 20002 });
        expect(res.retcode).toBe(-400);
    });
});

describe("get_peer_pins / set_peer_pin", () => {
    it("置顶好友/群匹配实体；未命中跳过", async () => {
        const registry = socialRegistry({
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => [
                    { scene: "friend", peerUid: "uid-20002", peerUin: "20002" },
                    { scene: "friend", peerUid: "uid-miss", peerUin: "99999" },
                    { scene: "group", peerUid: "10001", peerUin: "10001" },
                    { scene: "group", peerUid: "88888", peerUin: "88888" },
                ]),
            },
        });
        const res = await actionOf(registry, "get_peer_pins").handle({});
        expect(res.data).toEqual({
            friends: [
                {
                    user_id: 20002,
                    nickname: "甲",
                    sex: "unknown",
                    qid: "",
                    remark: "备注甲",
                    category: { category_id: 0, category_name: "" },
                },
            ],
            groups: [
                {
                    group_id: 10001,
                    group_name: "测试群",
                    member_count: 9,
                    max_member_count: 100,
                    remark: "",
                    created_time: 0,
                    description: "",
                    question: "",
                    announcement: "",
                },
            ],
        });
    });

    it("空置顶列表 → friends/groups 均空（不查列表）", async () => {
        const getFriendList = vi.fn(async () => []);
        const registry = socialRegistry({
            friendApi: { getFriendList },
            recentContactApi: { getPinnedContacts: vi.fn(async () => []) },
        });
        const res = await actionOf(registry, "get_peer_pins").handle({});
        expect(res.data).toEqual({ friends: [], groups: [] });
        expect(getFriendList).not.toHaveBeenCalled();
    });

    it("set_peer_pin：peer 解析 + is_pinned 缺省 true", async () => {
        const setContactTop = vi.fn(async () => undefined);
        const registry = socialRegistry({ msgApi: { setContactTop } });
        const res = await actionOf(registry, "set_peer_pin").handle({
            message_scene: "group",
            peer_id: 10001,
        });
        expect(res.status).toBe("ok");
        expect(setContactTop).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            true,
        );
    });

    it("set_peer_pin：is_pinned=false 透传（friend 场景 C2C）", async () => {
        const setContactTop = vi.fn(async () => undefined);
        const registry = socialRegistry({ msgApi: { setContactTop } });
        await actionOf(registry, "set_peer_pin").handle({
            message_scene: "friend",
            peer_id: 20002,
            is_pinned: false,
        });
        expect(setContactTop).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "uid-20002" },
            false,
        );
    });

    it("message_scene 非法 → -400", async () => {
        const registry = socialRegistry({});
        const res = await actionOf(registry, "set_peer_pin").handle({
            message_scene: "channel",
            peer_id: 10001,
        });
        expect(res.retcode).toBe(-400);
    });

    it("get_peer_pins：置顶过滤 + 实体套用 + 未命中跳过（P2 批次二补测）", async () => {
        const registry = socialRegistry({
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => [
                    { peerUid: "uid-20002", scene: "friend" },
                    { peerUid: "30003", scene: "group" },
                    { peerUid: "uid-stranger", scene: "friend" },
                ]),
            },
            friendApi: {
                getFriendList: vi.fn(async () => [
                    { uid: "uid-20002", uin: "20002", nickname: "甲", remark: "" },
                ]),
            },
            groupCache: {
                listGroupsRefreshed: vi.fn(async () => [
                    { groupCode: "30003", groupName: "群", memberCount: 3, maxMember: 500 },
                ]),
            },
        });
        const res = await actionOf(registry, "get_peer_pins").handle({});
        expect(res.retcode).toBe(0);
        expect(res.data).toEqual({
            friends: [
                {
                    user_id: 20002,
                    nickname: "甲",
                    sex: "unknown",
                    qid: "",
                    remark: "",
                    category: { category_id: 0, category_name: "" },
                },
            ],
            groups: [
                {
                    group_id: 30003,
                    group_name: "群",
                    member_count: 3,
                    max_member_count: 500,
                    remark: "",
                    created_time: 0,
                    description: "",
                    question: "",
                    announcement: "",
                },
            ],
        });
    });

    it("set_peer_pin：is_pinned 缺省 true + 场景透传（P2 批次二补测）", async () => {
        const setContactTop = vi.fn(async () => null);
        const registry = socialRegistry({ msgApi: { setContactTop } });
        await actionOf(registry, "set_peer_pin").handle({
            message_scene: "group",
            peer_id: 10001,
        });
        expect(setContactTop).toHaveBeenCalledWith({ chatType: 2, peerUid: "10001" }, true);
    });
});

describe("findBuddyReq（api.js 共享查找）", () => {
    it("按 friendUid 匹配；未命中 NOT_FOUND", async () => {
        const api = buildMilkyApi({});
        const spy = vi
            .spyOn(api.friendApi, "getBuddyReqList")
            .mockResolvedValue([{ reqTime: "1760000000", friendUid: "uid-20002" }] as never);
        const hit = await findBuddyReq(api, "uid-20002");
        expect(hit.friendUid).toBe("uid-20002");
        await expect(findBuddyReq(api, "uid-99999")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
