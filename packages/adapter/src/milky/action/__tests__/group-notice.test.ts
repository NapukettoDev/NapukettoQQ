/**
 * Milky 群通知域动作测试（group-notice.ts，域对齐重组）
 *
 * 锁定：通知类型→实体五变体映射（uid→uin）、客户端分页（limit/next）、
 * 未知通知类型过滤、is_filtered doubt 标志、群通知应答（KAGREE/KREFUSE +
 * notification_seq/invitation_seq 匹配）、findGroupNotify 两屏匹配与
 * NOT_FOUND（api.js 共享查找）。
 */
import type { GroupNotify } from "@napuketto/kernel";
import {
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    NTGroupRequestOperateTypes,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { findGroupNotify } from "../../api.js";
import type { GroupNotificationEntity } from "../../types.js";
import { actionOf, buildMilkyApi, groupRegistry } from "./test-support.js";

/** 通知桩（user1/user2 固定 uid，经 uidToUin 桩转 uin）。 */
function notify(type: GroupNotifyMsgType): GroupNotify {
    return {
        seq: "88001",
        type,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        group: { groupCode: "10001", groupName: "群" },
        user1: { uid: "uid-20002", nickName: "甲" },
        user2: { uid: "uid-30003", nickName: "乙" },
        postscript: "求入",
    };
}

describe("get_group_notifications", () => {
    it("通知类型 → 实体五变体映射（uid→uin 转换）", async () => {
        const registry = groupRegistry({
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => [
                    notify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS),
                    notify(GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS),
                    notify(GroupNotifyMsgType.SET_ADMIN),
                    notify(GroupNotifyMsgType.KICK_MEMBER_NOTIFY_KICKED),
                    notify(GroupNotifyMsgType.MEMBER_LEAVE_NOTIFY_ADMIN),
                ]),
            },
        });
        const result = await registry.get("get_group_notifications")?.handle({ limit: 20 });
        expect(result?.status).toBe("ok");
        const data = result?.data as
            | { notifications: GroupNotificationEntity[]; next_notification_seq: number | null }
            | undefined;
        const types = (data?.notifications ?? []).map((n) => n.type);
        expect(types).toEqual([
            "join_request",
            "invited_join_request",
            "admin_change",
            "kick",
            "quit",
        ]);
        const [join, invited, admin] = data?.notifications ?? [];
        expect(join).toMatchObject({
            initiator_id: 20002,
            notification_seq: 88001,
            comment: "求入",
            operator_id: null,
        });
        expect(invited).toMatchObject({ initiator_id: 20002, target_user_id: 30003 });
        expect(admin).toMatchObject({ target_user_id: 20002, is_set: true, operator_id: 30003 });
    });

    it("start_notification_seq 客户端过滤 + limit 截断出 next", async () => {
        const registry = groupRegistry({
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => [
                    notify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS),
                    notify(GroupNotifyMsgType.MEMBER_LEAVE_NOTIFY_ADMIN),
                ]),
            },
        });
        // 全量 2 条；limit=1 → 1 条 + next = 88001
        const result = await registry.get("get_group_notifications")?.handle({ limit: 1 });
        const data = result?.data as
            | { notifications: unknown[]; next_notification_seq: number | null }
            | undefined;
        expect(data?.notifications).toHaveLength(1);
        expect(data?.next_notification_seq).toBe(88001);
        // start=88002 → 全部（seq < 88002）；limit 缺省 20 → 无 next
        const all = await registry
            .get("get_group_notifications")
            ?.handle({ start_notification_seq: 88002 });
        const allData = all?.data as
            | { notifications: unknown[]; next_notification_seq: number | null }
            | undefined;
        expect(allData?.notifications).toHaveLength(2);
        expect(allData?.next_notification_seq).toBeNull();
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

    it("accept_group_request：notification_type 非法 → -400（schema 补测）", async () => {
        const registry = groupRegistry({});
        const result = await registry.get("accept_group_request")?.handle({
            notification_seq: 1,
            notification_type: "bogus",
            group_id: 10001,
        });
        expect(result?.retcode).toBe(-400);
    });
});

describe("findGroupNotify（api.js 共享查找）", () => {
    it("先非可疑命中", async () => {
        const notifyObj = notify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS);
        const api = buildMilkyApi({
            groupNotifyApi: { getSingleScreenNotifies: vi.fn(async () => [notifyObj]) },
        });
        const hit = await findGroupNotify(api, "88001");
        expect(hit.seq).toBe("88001");
    });

    it("非可疑未命中 → 可疑屏兜底", async () => {
        const notifyObj = notify(GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS);
        const api = buildMilkyApi({});
        const spy = vi
            .spyOn(api.groupNotifyApi, "getSingleScreenNotifies")
            .mockImplementation(async (doubt: boolean) => (doubt ? [notifyObj] : []));
        const hit = await findGroupNotify(api, "88001");
        expect(hit.seq).toBe("88001");
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("两屏都未命中 → NOT_FOUND", async () => {
        const api = buildMilkyApi({});
        await expect(findGroupNotify(api, "999")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});
