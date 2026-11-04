/**
 * friend.ts FriendApi 类测试（toDoubtFriendRequestInfo 已有独立基线）：
 *  - constructor 空校验
 *  - getFriendList：缓存成功 / 缓存抛错回退 getBuddyListV2 / buddyUids 兜底 /
 *    uidToUin 注入与缺失回退
 *  - getFriendCategories：分类保留 + uid 归并
 *  - isBuddy / getBuddyReqList / handleFriendRequest / setFriendRemark /
 *    deleteFriend / getDoubtFriendRequest / handleDoubtFriendRequest
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { FriendApi } from "../friend.js";
import { makeSession } from "../test-support.js";

/** 构造 FriendApi（buddy service 桩，可选 uidToUin 注入）。 */
function makeApi(
    overrides: Record<string, unknown> = {},
    opts: { uidToUin?: (uids: string[]) => Promise<Map<string, string>> } = {},
) {
    const service = {
        getBuddyListFromCache: vi.fn(async () => [
            {
                categoryId: 1,
                categorySortId: 0,
                categroyName: "我的好友",
                categroyMbCount: 2,
                onlineCount: 1,
                buddyList: [{ uid: "u1" }, { uid: "u2" }],
            },
        ]),
        getBuddyListV2: vi.fn(async () => ({
            result: 0,
            errMsg: "",
            data: [
                {
                    categoryId: 2,
                    categorySortId: 1,
                    categroyName: "家人",
                    categroyMbCount: 1,
                    onlineCount: 0,
                    buddyList: [{ uid: "u3" }],
                },
            ],
        })),
        getBuddyNick: vi.fn(() => "昵称"),
        getBuddyRemark: vi.fn(() => "备注"),
        isBuddy: vi.fn(() => true),
        getBuddyReq: vi.fn(async () => ({ result: 0, errMsg: "", buddyReqs: [] })),
        approvalFriendRequest: vi.fn(async () => ({ result: 0 })),
        setBuddyRemark: vi.fn(),
        delBuddy: vi.fn(async () => ({ result: 0 })),
        getDoubtBuddyReq: vi.fn(async () => ({ result: 0, errMsg: "", doubtList: [] })),
        approvalDoubtBuddyReq: vi.fn(),
        ...overrides,
    };
    const api = new FriendApi(
        makeSession({ getBuddyService: () => service }),
        opts.uidToUin !== undefined ? { uidToUin: opts.uidToUin } : {},
    );
    return { api, service };
}

describe("constructor", () => {
    it("getBuddyService 空 / undefined → INVALID_STATE", () => {
        expect(() => new FriendApi(makeSession({ getBuddyService: () => null }))).toThrow(
            /getBuddyService\(\) 返回空/,
        );
        expect(() => new FriendApi(makeSession({ getBuddyService: () => undefined }))).toThrow(
            /getBuddyService\(\) 返回空/,
        );
    });
});

describe("getFriendList", () => {
    it("缓存命中：buddyList 拍平 + 昵称备注读取；无 uidToUin 时 uin 回退 uid", async () => {
        const { api, service } = makeApi();
        await expect(api.getFriendList()).resolves.toEqual([
            { uid: "u1", uin: "u1", nickname: "昵称", remark: "备注" },
            { uid: "u2", uin: "u2", nickname: "昵称", remark: "备注" },
        ]);
        expect(service.getBuddyListV2).not.toHaveBeenCalled();
    });

    it("uidToUin 注入：命中映射 / 缺失回退 uid", async () => {
        const { api } = makeApi(
            {},
            {
                uidToUin: vi.fn(async () => new Map([["u1", "10001"]])),
            },
        );
        const list = await api.getFriendList();
        expect(list[0]).toEqual({ uid: "u1", uin: "10001", nickname: "昵称", remark: "备注" });
        expect(list[1]?.uin).toBe("u2");
    });

    it("缓存抛错回退 getBuddyListV2；V2 失败抛 UNKNOWN", async () => {
        const { api, service } = makeApi({
            getBuddyListFromCache: vi.fn(async () => {
                throw new Error("cache miss");
            }),
        });
        await expect(api.getFriendList()).resolves.toHaveLength(1);
        expect(service.getBuddyListV2).toHaveBeenCalledWith("cli", true, 0);
        const { api: api2 } = makeApi({
            getBuddyListFromCache: vi.fn(async () => {
                throw new Error("cache miss");
            }),
            getBuddyListV2: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(api2.getFriendList()).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("buddyList 缺失时回退 buddyUids 字段", async () => {
        const { api } = makeApi({
            getBuddyListFromCache: vi.fn(async () => [
                {
                    categoryId: 1,
                    categorySortId: 0,
                    categroyName: "旧",
                    categroyMbCount: 0,
                    onlineCount: 0,
                    buddyUids: ["u9"],
                },
            ]),
        });
        await expect(api.getFriendList()).resolves.toEqual([
            { uid: "u9", uin: "u9", nickname: "昵称", remark: "备注" },
        ]);
    });

    it("两字段都缺失 → 空列表", async () => {
        const { api } = makeApi({
            getBuddyListFromCache: vi.fn(async () => [
                {
                    categoryId: 1,
                    categorySortId: 0,
                    categroyName: "空",
                    categroyMbCount: 0,
                    onlineCount: 0,
                },
            ]),
        });
        await expect(api.getFriendList()).resolves.toEqual([]);
    });
});

describe("getFriendCategories", () => {
    it("分类保留 + 好友按 uid 归并", async () => {
        const { api } = makeApi();
        const cats = await api.getFriendCategories();
        expect(cats).toHaveLength(1);
        expect(cats[0]).toMatchObject({
            categoryId: 1,
            categorySortId: 0,
            categoryName: "我的好友",
            categoryMbCount: 2,
            onlineCount: 1,
        });
        expect(cats[0]?.buddyList.map((f) => f.uid)).toEqual(["u1", "u2"]);
    });

    it("缓存抛错时走 V2 分类", async () => {
        const { api } = makeApi({
            getBuddyListFromCache: vi.fn(async () => {
                throw new Error("cache miss");
            }),
        });
        const cats = await api.getFriendCategories();
        expect(cats[0]?.categoryName).toBe("家人");
        expect(cats[0]?.buddyList.map((f) => f.uid)).toEqual(["u3"]);
    });

    it("分类中的 uid 不在好友列表 → 该项跳过（分类与好友列表两次独立拉取）", async () => {
        const categories = [
            {
                categoryId: 1,
                categorySortId: 0,
                categroyName: "c",
                categroyMbCount: 0,
                onlineCount: 0,
                buddyList: [{ uid: "ghost" }],
            },
        ];
        const { api } = makeApi({
            // 第 1 次：getFriendCategories 的分类源；第 2 次：getFriendList 的数据源（空）
            getBuddyListFromCache: vi
                .fn()
                .mockResolvedValueOnce(categories)
                .mockResolvedValueOnce([]),
        });
        const cats = await api.getFriendCategories();
        expect(cats[0]?.buddyList).toEqual([]);
    });
});

describe("其余方法", () => {
    it("isBuddy 透传", () => {
        const { api, service } = makeApi();
        expect(api.isBuddy("u1")).toBe(true);
        expect(service.isBuddy).toHaveBeenCalledWith("u1");
    });

    it("getBuddyReqList：buddyReqs 返回 / 缺失空数组 / 失败抛错", async () => {
        const { api } = makeApi({
            getBuddyReq: vi.fn(async () => ({
                result: 0,
                errMsg: "",
                buddyReqs: [{ reqTime: "1", friendUid: "u1" }],
            })),
        });
        await expect(api.getBuddyReqList()).resolves.toEqual([{ reqTime: "1", friendUid: "u1" }]);
        const { api: api2 } = makeApi({
            getBuddyReq: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api2.getBuddyReqList()).resolves.toEqual([]);
        const { api: api3 } = makeApi({
            getBuddyReq: vi.fn(async () => ({ result: 2, errMsg: "x" })),
        });
        await expect(api3.getBuddyReqList()).rejects.toBeInstanceOf(KernelError);
    });

    it("handleFriendRequest：friendUid/reqTime/accept 透传", async () => {
        const { api, service } = makeApi();
        const notify = { reqTime: "123", friendUid: "u1" } as never;
        await api.handleFriendRequest(notify, true);
        expect(service.approvalFriendRequest).toHaveBeenCalledWith({
            friendUid: "u1",
            reqTime: "123",
            accept: true,
        });
    });

    it("setFriendRemark：void 透传", () => {
        const { api, service } = makeApi();
        api.setFriendRemark("u1", "改名");
        expect(service.setBuddyRemark).toHaveBeenCalledWith({ uid: "u1", remark: "改名" });
    });

    it("deleteFriend：默认参数与显式拉黑/双向删除；宽松失败抛错", async () => {
        const { api, service } = makeApi();
        await api.deleteFriend("u1");
        expect(service.delBuddy).toHaveBeenCalledWith({
            friendUid: "u1",
            tempBlock: false,
            tempBothDel: false,
        });
        await api.deleteFriend("u1", true, true);
        expect(service.delBuddy).toHaveBeenLastCalledWith({
            friendUid: "u1",
            tempBlock: true,
            tempBothDel: true,
        });
        const { api: api2 } = makeApi({
            delBuddy: vi.fn(async () => ({ result: 9, errMsg: "x" })),
        });
        await expect(api2.deleteFriend("u1")).rejects.toMatchObject({ message: /delBuddy 失败/ });
    });

    it("getDoubtFriendRequest：uidToUin 转换 + 无转换回退 Number(uid)；空列表不调 uidToUin", async () => {
        const uidToUin = vi.fn(async () => new Map([["u1", "10001"]]));
        const { api } = makeApi(
            {
                getDoubtBuddyReq: vi.fn(async () => ({
                    result: 0,
                    errMsg: "",
                    doubtList: [{ uid: "u1", nick: "小明" }],
                })),
            },
            { uidToUin },
        );
        const out = await api.getDoubtFriendRequest(10);
        expect(uidToUin).toHaveBeenCalledWith(["u1"]);
        expect(out).toEqual([
            {
                flag: "u1",
                uin: 10001,
                nick: "小明",
                type: "doubt",
            },
        ]);
        const { api: api2 } = makeApi({
            getDoubtBuddyReq: vi.fn(async () => ({
                result: 0,
                errMsg: "",
                doubtList: [{ uid: "12345" }],
            })),
        });
        const out2 = await api2.getDoubtFriendRequest(5);
        expect(out2).toEqual([{ flag: "12345", uin: 12345, type: "doubt" }]);
        const uidToUin2 = vi.fn(async () => new Map<string, string>());
        const { api: api3 } = makeApi({}, { uidToUin: uidToUin2 });
        await expect(api3.getDoubtFriendRequest(5)).resolves.toEqual([]);
        expect(uidToUin2).not.toHaveBeenCalled();
    });

    it("getDoubtFriendRequest：原生失败抛错", async () => {
        const { api } = makeApi({
            getDoubtBuddyReq: vi.fn(async () => ({ result: 3, errMsg: "x" })),
        });
        await expect(api.getDoubtFriendRequest(5)).rejects.toMatchObject({
            message: /getDoubtBuddyReq 失败/,
        });
    });

    it("handleDoubtFriendRequest：approvalDoubtBuddyReq(uid, '', '')", () => {
        const { api, service } = makeApi();
        api.handleDoubtFriendRequest("uid-9");
        expect(service.approvalDoubtBuddyReq).toHaveBeenCalledWith("uid-9", "", "");
    });
});

describe("分类兜底与错误语义补充", () => {
    it("getFriendList：buddyUids 兜底（无 buddyList）", async () => {
        const { api, service } = makeApi({
            getBuddyListFromCache: vi.fn(async () => [
                {
                    categoryId: 1,
                    categorySortId: 0,
                    categroyName: "旧分类",
                    categroyMbCount: 1,
                    onlineCount: 0,
                    buddyUids: ["u9"],
                },
            ]),
        });
        await expect(api.getFriendList()).resolves.toEqual([
            { uid: "u9", uin: "u9", nickname: "昵称", remark: "备注" },
        ]);
        expect(service.getBuddyNick).toHaveBeenCalledWith("u9");
    });

    it("getFriendList：两字段全缺 → 该分类贡献 0 人", async () => {
        const { api } = makeApi({
            getBuddyListFromCache: vi.fn(async () => [
                {
                    categoryId: 1,
                    categorySortId: 0,
                    categroyName: "空分类",
                    categroyMbCount: 0,
                    onlineCount: 0,
                },
            ]),
        });
        await expect(api.getFriendList()).resolves.toEqual([]);
    });

    it("getFriendCategories：缓存抛错回退 getBuddyListV2 失败 → UNKNOWN", async () => {
        const { api } = makeApi({
            getBuddyListFromCache: vi.fn(async () => {
                throw new Error("cache corrupt");
            }),
            getBuddyListV2: vi.fn(async () => ({ result: 9, errMsg: "db err", data: [] })),
        });
        await expect(api.getFriendCategories()).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /getBuddyListV2 失败: db err/,
        });
    });

    it("getDoubtFriendRequest：doubtList 缺省 → 空列表（不触发 uidToUin）", async () => {
        const uidToUin = vi.fn(async () => new Map<string, string>());
        const { api } = makeApi(
            { getDoubtBuddyReq: vi.fn(async () => ({ result: 0, errMsg: "" })) },
            { uidToUin },
        );
        await expect(api.getDoubtFriendRequest(10)).resolves.toEqual([]);
        expect(uidToUin).not.toHaveBeenCalled();
    });

    it("getDoubtFriendRequest：doubtList 空 → 不触发 uidToUin", async () => {
        const uidToUin = vi.fn(async () => new Map<string, string>());
        const { api } = makeApi({}, { uidToUin });
        await expect(api.getDoubtFriendRequest(10)).resolves.toEqual([]);
        expect(uidToUin).not.toHaveBeenCalled();
    });
});
