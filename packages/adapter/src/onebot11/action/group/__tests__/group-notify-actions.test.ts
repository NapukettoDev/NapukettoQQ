/**
 * 群请求/禁言列表动作测试：get_group_add_request / get_group_ignored_notifies /
 * set_group_add_request / get_group_shut_list。
 *
 * 锁定行为：doubt=false/true 两屏语义、GroupNotify → OB11 请求项映射（flag=seq）、
 * set_group_add_request 先非可疑后可疑的匹配序、approve 缺省同意、reason 缺省空格、
 * flag 未命中 → retcode 102、禁言列表 uid→uin 批量转换与空表短路。
 */
import { GroupNotifyMsgStatus } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { makeNotify, ob11ActionOf, stubUidToUin } from "../../__tests__/test-support.js";
import { createGroupNotifyActions } from "../notify.js";

/**
 * 与 notify.ts 的 GroupAddRequestItem / ShutListMember 同构
 * （生产侧未导出，仅供断言类型标注）。
 */
interface GroupAddRequestItem {
    flag: string;
    group_id: number;
    group_name: string;
    user_id: number;
    user_nick: string;
    type: number;
    checked: boolean;
    postscript: string;
}

/** 同构 ShutListMember。 */
interface ShutListMember {
    user_id: number;
    nickname: string;
    shut_up_time: number;
}

describe("get_group_add_request / get_group_ignored_notifies", () => {
    it("未处理列表（doubt=false）→ GroupAddRequestItem 映射", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "88001",
                    type: 7,
                    status: GroupNotifyMsgStatus.KUNHANDLE,
                    // 本动作 user_id 取 Number(user1.uid)（不经 uidToUin 转换）——
                    // 数字串 uid 直接成 user_id；非数字 uid 会得 NaN（现状锁定）
                    user1: { uid: "90002", nickName: "申请人" },
                }),
            ]),
        };
        const result = await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "get_group_add_request",
        ).handle({});
        expect(result.status).toBe("ok");
        expect(result.data).toEqual([
            {
                flag: "88001",
                group_id: 808,
                group_name: "测试群",
                user_id: 90002,
                user_nick: "申请人",
                type: 7,
                checked: false,
                postscript: "求入群",
            },
        ]);
        expect(groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledWith(false, 100);
    });

    it("ignored 动作走 doubt=true 屏；count 可自定义", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => []),
        };
        await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "get_group_ignored_notifies",
        ).handle({ count: 3 });
        expect(groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledWith(true, 3);
    });

    it("ignored 动作 count 缺省 → 100（payload.count ?? DEFAULT_COUNT 右支）", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => []),
        };
        await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "get_group_ignored_notifies",
        ).handle({});
        expect(groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledWith(true, 100);
    });

    it("group/user1 缺失 → group_id=0 / user_id=0 / user_nick 空串", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "2",
                    group: undefined,
                    user1: undefined,
                    postscript: undefined,
                    // status=KAGREED → checked=true
                    status: GroupNotifyMsgStatus.KAGREED,
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupAddRequestItem[]>(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "get_group_add_request",
        ).handle({});
        expect(result.data?.[0]).toMatchObject({
            flag: "2",
            group_id: 0,
            user_id: 0,
            user_nick: "",
            postscript: "",
            checked: true,
        });
    });

    it("user1.uid 为非数字 uid 形态 → user_id=NaN（现状锁定，容忍不抛错）", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({ seq: "3", user1: { uid: "u_abc", nickName: "甲" } }),
            ]),
        };
        const result = await ob11ActionOf<GroupAddRequestItem[]>(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "get_group_add_request",
        ).handle({});
        expect(result.data?.[0]?.user_id).toBeNaN();
    });
});

describe("set_group_add_request", () => {
    it("flag 命中非可疑屏 → handleGroupRequest 同意（approve 缺省）", async () => {
        const notify = makeNotify({ seq: "88001", type: 7 });
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async (doubt: boolean) => (doubt ? [] : [notify])),
            handleGroupRequest: vi.fn(
                async (_doubt: boolean, _notify: unknown, _operate: number, _reason: string) =>
                    undefined,
            ),
        };
        const result = await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "set_group_add_request",
        ).handle({ flag: "88001" });
        expect(result.retcode).toBe(0);
        expect(groupNotifyApi.handleGroupRequest).toHaveBeenCalledTimes(1);
        const [doubt, hit, operate, reason] = groupNotifyApi.handleGroupRequest.mock.calls[0] ?? [];
        expect(doubt).toBe(false);
        expect(hit).toBe(notify);
        // KAGREE = 1
        expect(operate).toBe(1);
        expect(reason).toBe(" ");
    });

    it("approve=false → KREFUSE（2）+ 自定义 reason", async () => {
        const notify = makeNotify({ seq: "88001", type: 7 });
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async (doubt: boolean) => (doubt ? [] : [notify])),
            handleGroupRequest: vi.fn(
                async (_doubt: boolean, _notify: unknown, _operate: number, _reason: string) =>
                    undefined,
            ),
        };
        await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "set_group_add_request",
        ).handle({ flag: "88001", approve: false, reason: "不通过" });
        const [, , operate, reason] = groupNotifyApi.handleGroupRequest.mock
            .calls[0] as unknown as [boolean, unknown, number, string];
        // KREFUSE = 2
        expect(operate).toBe(2);
        expect(reason).toBe("不通过");
    });

    it("非可疑屏未命中 → 可疑屏兜底匹配（两次 getSingleScreenNotifies）", async () => {
        const doubtNotify = makeNotify({ seq: "88002", type: 7 });
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async (doubt: boolean) => (doubt ? [doubtNotify] : [])),
            handleGroupRequest: vi.fn(
                async (_doubt: boolean, _notify: unknown, _operate: number, _reason: string) =>
                    undefined,
            ),
        };
        const result = await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "set_group_add_request",
        ).handle({ flag: "88002" });
        expect(result.retcode).toBe(0);
        expect(groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledTimes(2);
        expect(groupNotifyApi.handleGroupRequest).toHaveBeenCalledTimes(1);
    });

    it("两屏都未命中 → retcode 102 NOT_FOUND（不调 handleGroupRequest）", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => []),
            handleGroupRequest: vi.fn(
                async (_doubt: boolean, _notify: unknown, _operate: number, _reason: string) =>
                    undefined,
            ),
        };
        const result = await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi } as never),
            "set_group_add_request",
        ).handle({ flag: "999" });
        expect(result.retcode).toBe(102);
        expect(groupNotifyApi.handleGroupRequest).not.toHaveBeenCalled();
    });
});

describe("get_group_shut_list", () => {
    it("禁言成员列表 → uid→uin 转换 + shut_up_time", async () => {
        const uidToUin = stubUidToUin();
        const groupNotifyApi = {
            getGroupShutUpMemberList: vi.fn(async () => [
                { uid: "u90001", uin: "", nick: "甲", shutUpTime: 120 },
                { uid: "u90002", uin: "90002", nick: "乙", shutUpTime: 0 },
            ]),
        };
        const result = await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi, uidToUin } as never),
            "get_group_shut_list",
        ).handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(uidToUin).toHaveBeenCalledWith(["u90001", "u90002"]);
        expect(result.data).toEqual([
            { user_id: 90001, nickname: "甲", shut_up_time: 120 },
            { user_id: 90002, nickname: "乙", shut_up_time: 0 },
        ]);
    });

    it("uid 不在映射 → member.uin 兜底；连 uin 都没有 → member.uid 兜底", async () => {
        const groupNotifyApi = {
            getGroupShutUpMemberList: vi.fn(async () => [
                { uid: "u-unknown", uin: "88001", nick: "丁", shutUpTime: 1 },
                { uid: "u-no-uin", nick: "戊", shutUpTime: 2 },
            ]),
        };
        // 空映射表：两个 uid 都查不到 → 依次回退 member.uin / member.uid
        const result = await ob11ActionOf(
            createGroupNotifyActions({
                groupNotifyApi,
                uidToUin: vi.fn(async () => new Map<string, string>()),
            } as never),
            "get_group_shut_list",
        ).handle({ group_id: 808 });
        expect(result.data).toEqual([
            { user_id: 88001, nickname: "丁", shut_up_time: 1 },
            { user_id: Number("u-no-uin"), nickname: "戊", shut_up_time: 2 },
        ]);
    });

    it("空列表 → 不调用 uidToUin（短路）", async () => {
        const uidToUin = stubUidToUin();
        const groupNotifyApi = {
            getGroupShutUpMemberList: vi.fn(async () => []),
        };
        const result = await ob11ActionOf(
            createGroupNotifyActions({ groupNotifyApi, uidToUin } as never),
            "get_group_shut_list",
        ).handle({ group_id: 808 });
        expect(result.data).toEqual([]);
        expect(uidToUin).not.toHaveBeenCalled();
    });

    it("uid 不在映射且无 uin → 回退 Number(uid)（NaN 容忍不抛错）", async () => {
        const groupNotifyApi = {
            getGroupShutUpMemberList: vi.fn(async () => [
                { uid: "u-unknown", uin: "", nick: "丙", shutUpTime: 5 },
            ]),
        };
        const result = await ob11ActionOf<ShutListMember[]>(
            createGroupNotifyActions({
                groupNotifyApi,
                uidToUin: stubUidToUin(),
            } as never),
            "get_group_shut_list",
        ).handle({ group_id: 808 });
        expect(result.data?.[0]?.nickname).toBe("丙");
    });
});
