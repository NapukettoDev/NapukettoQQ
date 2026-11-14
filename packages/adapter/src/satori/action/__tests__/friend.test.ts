/**
 * satori/action/friend.test.ts：friend.list / delete / approve 单测。
 *
 * 锁定：列表 remark≠nickname 才写 nick；delete uin→uid；approve 按
 * 申请方 uin（message_id）匹配好友申请（uid→uin 批量），空列表/未匹配抛错。
 */

import type { BuddyReq } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../shared/__tests__/stub.js";
import type { Friend, List } from "../../types/index.js";
import type { FriendActionDeps } from "../friend.js";
import { createFriendActions } from "../friend.js";
import { type StubSatoriApi, satoriActionOf, stubSatoriApi } from "./test-support.js";

function makeDeps(api: StubSatoriApi): FriendActionDeps {
    return stub<FriendActionDeps>({
        friendApi: api.friendApi,
        uinToUid: api.uinToUid,
        uidToUin: api.uidToUin,
    });
}

/** 构造指定好友动作（工厂产物按名取出）。 */
function actionOf<R>(api: StubSatoriApi, name: string) {
    return satoriActionOf<R>(createFriendActions(makeDeps(api)), name);
}

describe("friend.list", () => {
    it("getFriendList → List<Friend>（nickname 作 name）", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.friendApi.getFriendList).mockResolvedValueOnce([
            { uid: "uid_1", uin: "101", nickname: "好友A", remark: "" },
            { uid: "uid_2", uin: "102", nickname: "好友B", remark: "备注B" },
            { uid: "uid_3", uin: "103", nickname: "同名", remark: "同名" },
        ] as never);
        const action = actionOf<List<Friend>>(api, "friend.list");
        await expect(action.run({})).resolves.toEqual({
            data: [
                { user: { id: "101", name: "好友A" } },
                { user: { id: "102", name: "好友B" }, nick: "备注B" },
                { user: { id: "103", name: "同名" } },
            ],
        });
    });

    it("空好友列表 → data: []", async () => {
        const api = stubSatoriApi();
        const action = actionOf<List<Friend>>(api, "friend.list");
        await expect(action.run({})).resolves.toEqual({ data: [] });
    });
});

describe("friend.delete", () => {
    it("uin → uid 转换后 deleteFriend", async () => {
        const api = stubSatoriApi();
        const action = actionOf<void>(api, "friend.delete");
        await expect(action.run({ user_id: "101" })).resolves.toBeUndefined();
        expect(api.uinToUid).toHaveBeenCalledWith(["101"]);
        expect(api.friendApi.deleteFriend).toHaveBeenCalledWith("uid_101");
    });

    it("缺 user_id → 400", async () => {
        const action = actionOf<void>(stubSatoriApi(), "friend.delete");
        await expect(action.run({})).rejects.toMatchObject({ status: 400 });
    });
});

describe("friend.approve", () => {
    it("message_id（申请方 uin）匹配申请 → handleFriendRequest(notify, true)", async () => {
        const api = stubSatoriApi();
        const req: BuddyReq = { reqTime: "1", friendUid: "uid_101" };
        vi.mocked(api.friendApi.getBuddyReqList).mockResolvedValueOnce([req] as never);
        api.uidToUin.mockResolvedValueOnce(new Map([["uid_101", "101"]]));
        const action = actionOf<void>(api, "friend.approve");
        await expect(action.run({ message_id: "101", approve: true })).resolves.toBeUndefined();
        expect(api.friendApi.handleFriendRequest).toHaveBeenCalledWith(req, true);
    });

    it("approve=false → handleFriendRequest(notify, false)", async () => {
        const api = stubSatoriApi();
        const req: BuddyReq = { reqTime: "1", friendUid: "uid_101" };
        vi.mocked(api.friendApi.getBuddyReqList).mockResolvedValueOnce([req] as never);
        api.uidToUin.mockResolvedValueOnce(new Map([["uid_101", "101"]]));
        const action = actionOf<void>(api, "friend.approve");
        await action.run({ message_id: "101", approve: false, comment: "随意" });
        expect(api.friendApi.handleFriendRequest).toHaveBeenCalledWith(req, false);
    });

    it("空申请列表：抛「好友申请不存在」（500）", async () => {
        const api = stubSatoriApi();
        const action = actionOf<void>(api, "friend.approve");
        await expect(action.run({ message_id: "101", approve: true })).rejects.toMatchObject({
            status: 500,
            message: "好友申请不存在",
        });
    });

    it("有申请但 uin 不匹配：抛「好友申请不存在」", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.friendApi.getBuddyReqList).mockResolvedValueOnce([
            { reqTime: "1", friendUid: "uid_101" },
        ] as never);
        api.uidToUin.mockResolvedValueOnce(new Map([["uid_101", "101"]]));
        const action = actionOf<void>(api, "friend.approve");
        await expect(action.run({ message_id: "999", approve: true })).rejects.toMatchObject({
            status: 500,
            message: "好友申请不存在",
        });
    });

    it("approve 缺失 → 400", async () => {
        const action = actionOf<void>(stubSatoriApi(), "friend.approve");
        await expect(action.run({ message_id: "101" })).rejects.toMatchObject({ status: 400 });
    });
});
