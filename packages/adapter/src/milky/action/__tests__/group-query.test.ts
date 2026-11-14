/**
 * Milky 群查询域动作测试（group-query.ts，2026-11-14 域对齐重组）
 *
 * 锁定：群信息/成员查询（GroupCache 与直查双路径）、成员单查 uin→uid 解析与
 * 兜底、群公告列表 bulletin 宽松映射（senderUid→uin / pic url / 无源兜底）。
 */
import { describe, expect, it, vi } from "vitest";
import { actionOf, detailStub, groupRegistry, memberStub } from "./test-support.js";

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

describe("get_group_announcements", () => {
    it("bulletin 映射 + senderUid→uin + pic url（无 id 公告兜底）", async () => {
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

    it("bulletin 宽松映射（P2 批次二补测：publishTime 数值 + 无图 null）", async () => {
        const registry = groupRegistry({
            groupApi: {
                getGroupAnnouncements: vi.fn(async () => [
                    {
                        announcementId: "a1",
                        senderUid: "uid-20002",
                        publishTime: 100,
                        content: "公告",
                    },
                ]),
            },
        });
        const res = await actionOf(registry, "get_group_announcements").handle({ group_id: 10001 });
        expect(res.data).toEqual({
            announcements: [
                {
                    group_id: 10001,
                    announcement_id: "a1",
                    user_id: 20002,
                    time: 100,
                    content: "公告",
                    image_url: null,
                },
            ],
        });
    });
});
