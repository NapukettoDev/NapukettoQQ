/**
 * 好友动作测试：get_friend_list / get_friends_with_category / get_stranger_info /
 * set_friend_add_request / set_friend_remark / delete_friend / send_like /
 * get_doubt_friends_add_request / set_doubt_friends_add_request。
 *
 * 锁定行为：FriendInfo 映射（remark 空串省略）、申请 flag=reqTime 匹配与
 * approve 缺省同意、备注可选设置、uin→uid 转换（delete_friend / set_friend_remark /
 * send_like）、可疑申请读写直通。
 */
import { describe, expect, it, vi } from "vitest";
import { stubConverters } from "../../__tests__/test-support.js";
import {
    DeleteFriendAction,
    SendLikeAction,
    SetDoubtFriendsAddRequestAction,
    SetFriendAddRequestAction,
    SetFriendRemarkAction,
} from "../manage.js";
import {
    GetDoubtFriendsAddRequestAction,
    GetFriendListAction,
    GetFriendsWithCategoryAction,
    GetStrangerInfoAction,
} from "../query.js";

describe("get_friend_list", () => {
    it("Friend[] → FriendInfo[]（remark 非空才含）", async () => {
        const friendApi = {
            getFriendList: vi.fn(async () => [
                { uin: "90001", nickname: "甲", remark: "备注甲" },
                { uin: "90002", nickname: "乙", remark: "" },
            ]),
        };
        const result = await new GetFriendListAction(friendApi as never).handle({});
        expect(result.status).toBe("ok");
        expect(result.data).toEqual([
            { user_id: 90001, nickname: "甲", remark: "备注甲" },
            { user_id: 90002, nickname: "乙" },
        ]);
    });
});

describe("get_friends_with_category", () => {
    it("getFriendCategories 返回值直通", async () => {
        const categories = [{ categoryId: 1, categoryName: "家人", buddyList: [] }];
        const friendApi = { getFriendCategories: vi.fn(async () => categories) };
        const result = await new GetFriendsWithCategoryAction(friendApi as never).handle({});
        expect(result.data).toBe(categories);
    });
});

describe("get_stranger_info", () => {
    it("getStrangerInfo → 展开 info 并覆盖 user_id", async () => {
        const profileApi = {
            getStrangerInfo: vi.fn(async () => ({ nick: "陌生人", age: 18 })),
        };
        const result = await new GetStrangerInfoAction(profileApi as never).handle({
            user_id: 90009,
        });
        expect(result.data).toEqual({ nick: "陌生人", age: 18, user_id: 90009 });
        expect(profileApi.getStrangerInfo).toHaveBeenCalledWith("90009");
    });
});

describe("set_friend_add_request", () => {
    it("flag=reqTime 命中 → handleFriendRequest 同意（approve 缺省）", async () => {
        const req = { reqTime: "1760000000", friendUid: "u90002" };
        const friendApi = {
            getBuddyReqList: vi.fn(async () => [req]),
            handleFriendRequest: vi.fn(async () => undefined),
            setFriendRemark: vi.fn(),
        };
        const result = await new SetFriendAddRequestAction(friendApi as never).handle({
            flag: "1760000000",
        });
        expect(result.retcode).toBe(0);
        expect(friendApi.handleFriendRequest).toHaveBeenCalledWith(req, true);
        expect(friendApi.setFriendRemark).not.toHaveBeenCalled();
    });

    it("approve=false 拒绝；remark 有值 → setFriendRemark(uid, remark)", async () => {
        const req = { reqTime: "1760000000", friendUid: "u90002" };
        const friendApi = {
            getBuddyReqList: vi.fn(async () => [req]),
            handleFriendRequest: vi.fn(async () => undefined),
            setFriendRemark: vi.fn(),
        };
        await new SetFriendAddRequestAction(friendApi as never).handle({
            flag: "1760000000",
            approve: false,
            remark: " 备注 ",
        });
        expect(friendApi.handleFriendRequest).toHaveBeenCalledWith(req, false);
        expect(friendApi.setFriendRemark).toHaveBeenCalledWith("u90002", " 备注 ");
    });

    it("flag 未命中 → retcode 102", async () => {
        const friendApi = {
            getBuddyReqList: vi.fn(async () => []),
            handleFriendRequest: vi.fn(),
        };
        const result = await new SetFriendAddRequestAction(friendApi as never).handle({
            flag: "999",
        });
        expect(result.retcode).toBe(102);
    });
});

describe("set_friend_remark / delete_friend / send_like", () => {
    it("set_friend_remark → uin→uid → setFriendRemark", async () => {
        const { uinToUid } = stubConverters();
        const friendApi = { setFriendRemark: vi.fn() };
        const result = await new SetFriendRemarkAction({ friendApi, uinToUid } as never).handle({
            user_id: 90001,
            remark: "老铁",
        });
        expect(result.retcode).toBe(0);
        expect(friendApi.setFriendRemark).toHaveBeenCalledWith("u90001", "老铁");
    });

    it("delete_friend → uin→uid → deleteFriend", async () => {
        const { uinToUid } = stubConverters();
        const friendApi = { deleteFriend: vi.fn(async () => undefined) };
        const result = await new DeleteFriendAction({ friendApi, uinToUid } as never).handle({
            user_id: 90001,
        });
        expect(result.retcode).toBe(0);
        expect(friendApi.deleteFriend).toHaveBeenCalledWith("u90001");
    });

    it("delete_friend uin 解析失败 → retcode 105", async () => {
        const friendApi = { deleteFriend: vi.fn() };
        const result = await new DeleteFriendAction({
            friendApi,
            uinToUid: vi.fn(async () => new Map()),
        } as never).handle({ user_id: 11111 });
        expect(result.retcode).toBe(105);
    });

    it("send_like → uin→uid → sendLike(uid, times 缺省 1)", async () => {
        const { uinToUid } = stubConverters();
        const profileLikeApi = { sendLike: vi.fn(async () => undefined) };
        const result = await new SendLikeAction({ profileLikeApi, uinToUid } as never).handle({
            user_id: 90001,
        });
        expect(result.retcode).toBe(0);
        expect(profileLikeApi.sendLike).toHaveBeenCalledWith("u90001", 1);
        await new SendLikeAction({ profileLikeApi, uinToUid } as never).handle({
            user_id: 90001,
            times: 10,
        });
        expect(profileLikeApi.sendLike).toHaveBeenLastCalledWith("u90001", 10);
    });
});

describe("doubt 可疑好友申请", () => {
    it("get_doubt_friends_add_request → count 缺省 50 透传", async () => {
        const list = [{ reqTime: "1", friendUid: "u90002" }];
        const friendApi = { getDoubtFriendRequest: vi.fn(async () => list) };
        const result = await new GetDoubtFriendsAddRequestAction(friendApi as never).handle({});
        expect(result.data).toBe(list);
        expect(friendApi.getDoubtFriendRequest).toHaveBeenCalledWith(50);
        await new GetDoubtFriendsAddRequestAction(friendApi as never).handle({ count: 5 });
        expect(friendApi.getDoubtFriendRequest).toHaveBeenLastCalledWith(5);
    });

    it("set_doubt_friends_add_request → handleDoubtFriendRequest(flag)", async () => {
        const friendApi = { handleDoubtFriendRequest: vi.fn() };
        const result = await new SetDoubtFriendsAddRequestAction(friendApi as never).handle({
            flag: "u90002",
            approve: true,
        });
        expect(result.retcode).toBe(0);
        expect(friendApi.handleDoubtFriendRequest).toHaveBeenCalledWith("u90002");
    });
});
