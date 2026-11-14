/**
 * get_group_system_msg 动作测试（覆盖面最大的群通知动作）。
 *
 * 锁定行为：type 1=邀请 / 7=入群申请分流（其余类型丢弃）、count 缺省 50 透传、
 * user1/user2 uid 批量转 uin（空 uid 跳过、无 uid 不调转换）、group 缺失回退
 * 0/空串、checked=status!==1、postscript 缺省空串、InvitedRequest 兼容别名。
 */
import { GroupNotifyMsgStatus, GroupNotifyMsgType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { makeNotify, ob11ActionOf, stubUidToUin } from "../../__tests__/test-support.js";
import { createGroupSystemMsgActions } from "../get-group-system-msg.js";

/**
 * 与 get-group-system-msg.ts 的 GroupSystemMessageInfo / GroupSystemMsgResult
 * 同构（生产侧未导出，仅供断言类型标注）。
 */
interface GroupSystemMsgItem {
    request_id: number;
    invitor_uin: number;
    invitor_nick: string;
    group_id: number;
    message: string;
    group_name: string;
    checked: boolean;
    actor: number;
    requester_nick: string;
}

/** 同构 GroupSystemMsgResult（含 InvitedRequest 兼容别名）。 */
interface GroupSystemMsgResult {
    invited_requests: GroupSystemMsgItem[];
    InvitedRequest: GroupSystemMsgItem[];
    join_requests: GroupSystemMsgItem[];
}

describe("get_group_system_msg", () => {
    it("邀请（type 1）与申请（type 7）分流到 invited_requests / join_requests", async () => {
        const uidToUin = stubUidToUin();
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({ seq: "1", type: GroupNotifyMsgType.INVITED_BY_MEMBER }),
                makeNotify({
                    seq: "2",
                    type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
                }),
                makeNotify({ seq: "3", type: GroupNotifyMsgType.SET_ADMIN }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({ groupNotifyApi, uidToUin } as never),
            "get_group_system_msg",
        ).handle({});
        expect(result.status).toBe("ok");
        const data = result.data;
        expect(data?.invited_requests).toHaveLength(1);
        expect(data?.join_requests).toHaveLength(1);
        expect(data?.invited_requests[0]).toMatchObject({
            request_id: 1,
            group_id: 808,
            group_name: "测试群",
            invitor_uin: 90002,
            invitor_nick: "申请人",
            requester_nick: "申请人",
            message: "求入群",
            checked: false,
        });
        // 兼容别名 InvitedRequest 与 invited_requests 同引用
        expect(data?.["InvitedRequest"]).toBe(data?.invited_requests);
    });

    it("count 透传给 getSingleScreenNotifies（缺省 50）", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => []),
        };
        const action = ob11ActionOf(
            createGroupSystemMsgActions({
                groupNotifyApi,
                uidToUin: stubUidToUin(),
            } as never),
            "get_group_system_msg",
        );
        await action.handle({});
        expect(groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledWith(false, 50);
        await action.handle({ count: 5 });
        expect(groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledWith(false, 5);
    });

    it("user1/user2 uid 批量转 uin（一次请求）；空 uid 跳过", async () => {
        const uidToUin = stubUidToUin();
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "9",
                    type: GroupNotifyMsgType.INVITED_BY_MEMBER,
                    user1: { uid: "u90002", nickName: "邀请人" },
                    user2: { uid: "u90009", nickName: "被邀请人" },
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({ groupNotifyApi, uidToUin } as never),
            "get_group_system_msg",
        ).handle({});
        expect(uidToUin).toHaveBeenCalledWith(["u90002", "u90009"]);
        expect(result.data?.invited_requests[0]).toMatchObject({
            invitor_uin: 90002,
            actor: 90009,
        });
    });

    it("user2.uid 空串 → 跳过该 uid（不进批量转换表）", async () => {
        const uidToUin = stubUidToUin();
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "7",
                    type: GroupNotifyMsgType.INVITED_BY_MEMBER,
                    user1: { uid: "u90002", nickName: "邀请人" },
                    user2: { uid: "", nickName: "被邀请人" },
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({ groupNotifyApi, uidToUin } as never),
            "get_group_system_msg",
        ).handle({});
        // 只收集 user1 的 uid；空串 user2 不入表
        expect(uidToUin).toHaveBeenCalledWith(["u90002"]);
        expect(result.data?.invited_requests[0]).toMatchObject({ invitor_uin: 90002 });
    });

    it("全部 uid 为空 → 不调用 uidToUin，uin 回退 Number(uid)（NaN 容忍）", async () => {
        const uidToUin = stubUidToUin();
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "10",
                    type: GroupNotifyMsgType.INVITED_BY_MEMBER,
                    user1: { uid: "", nickName: "空" },
                    user2: undefined,
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({ groupNotifyApi, uidToUin } as never),
            "get_group_system_msg",
        ).handle({});
        expect(uidToUin).not.toHaveBeenCalled();
        expect(result.data?.invited_requests).toHaveLength(1);
    });

    it("group 缺失 → group_id=0 / group_name 空串；postscript 缺失 → 空串", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "11",
                    type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
                    group: undefined,
                    postscript: undefined,
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({
                groupNotifyApi,
                uidToUin: stubUidToUin(),
            } as never),
            "get_group_system_msg",
        ).handle({});
        expect(result.data?.join_requests[0]).toMatchObject({
            group_id: 0,
            group_name: "",
            message: "",
        });
    });

    it("status=KUNHANDLE → checked=false；KAGREED → checked=true", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "12",
                    type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
                    status: GroupNotifyMsgStatus.KUNHANDLE,
                }),
                makeNotify({
                    seq: "13",
                    type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
                    status: GroupNotifyMsgStatus.KAGREED,
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({
                groupNotifyApi,
                uidToUin: stubUidToUin(),
            } as never),
            "get_group_system_msg",
        ).handle({});
        expect(result.data?.join_requests[0]?.checked).toBe(false);
        expect(result.data?.join_requests[1]?.checked).toBe(true);
    });

    it("user1 缺失 → invitor_nick 空串、invitor_uin 回退 NaN（不抛错）", async () => {
        const groupNotifyApi = {
            getSingleScreenNotifies: vi.fn(async () => [
                makeNotify({
                    seq: "14",
                    type: GroupNotifyMsgType.INVITED_BY_MEMBER,
                    user1: undefined,
                }),
            ]),
        };
        const result = await ob11ActionOf<GroupSystemMsgResult>(
            createGroupSystemMsgActions({
                groupNotifyApi,
                uidToUin: stubUidToUin(),
            } as never),
            "get_group_system_msg",
        ).handle({});
        expect(result.data?.invited_requests[0]).toMatchObject({ invitor_nick: "", actor: 0 });
    });

    it("count 参数非法 → retcode 400", async () => {
        const result = await ob11ActionOf(
            createGroupSystemMsgActions({} as never),
            "get_group_system_msg",
        ).handle({ count: "bad" });
        expect(result.retcode).toBe(400);
    });
});
