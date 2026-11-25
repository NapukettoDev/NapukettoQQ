/**
 * friend.ts FriendApi 类测试 + toDoubtFriendRequestInfo 纯函数断言（同文件合并保留）：
 *  - constructor 空校验
 *  - getFriendList：缓存成功 / 缓存抛错回退 getBuddyListV2 / buddyUids 兜底 /
 *    uidToUin 注入与缺失回退
 *  - getFriendCategories：分类保留 + uid 归并
 *  - getBuddyReqList / deleteFriend / getDoubtFriendRequest
 */
import { describe, expect, it, vi } from "vitest";
import { FriendApi, toDoubtFriendRequestInfo } from "../../../src/apis/social/friend.js";
import { KernelError } from "../../../src/infra/index.js";
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
    it("缓存命中：buddyList 拍平并保留昵称备注；缺失的 UIN 为空", async () => {
        const { api, service } = makeApi();
        await expect(api.getFriendList()).resolves.toEqual([
            { uid: "u1", uin: null, nickname: "昵称", remark: "备注" },
            { uid: "u2", uin: null, nickname: "昵称", remark: "备注" },
        ]);
        expect(service.getBuddyListV2).not.toHaveBeenCalled();
    });

    it("uidToUin 注入：命中映射，未命中保留 null", async () => {
        const { api } = makeApi(
            {},
            {
                uidToUin: vi.fn(async () => new Map([["u1", "10001"]])),
            },
        );
        const list = await api.getFriendList();
        expect(list[0]).toEqual({ uid: "u1", uin: "10001", nickname: "昵称", remark: "备注" });
        expect(list[1]?.uin).toBeNull();
    });

    it("好友明细优先；只转换缺失的 UIN，数字形态的 UID 也独立保留", async () => {
        const uidToUin = vi.fn(async () => new Map([["20001", "u_bad_value"]]));
        const { api, service } = makeApi(
            {
                getBuddyListFromCache: async () => [
                    {
                        buddyList: [
                            {
                                uid: "u_friend",
                                uin: "",
                                coreInfo: { uin: "10001", nick: "明细昵称", remark: "" },
                            },
                            { uid: "20001" },
                        ],
                    },
                ],
            },
            { uidToUin },
        );
        await expect(api.getFriendList()).resolves.toEqual([
            { uid: "u_friend", uin: "10001", nickname: "明细昵称", remark: "" },
            { uid: "20001", uin: null, nickname: "昵称", remark: "备注" },
        ]);
        expect(uidToUin).toHaveBeenCalledExactlyOnceWith(["20001"]);
        expect(service.getBuddyRemark).toHaveBeenCalledExactlyOnceWith("20001");
    });

    it("批量转换失败时传播原错误", async () => {
        const failure = new Error("转换不可用");
        const { api } = makeApi({}, { uidToUin: vi.fn().mockRejectedValue(failure) });
        await expect(api.getFriendList()).rejects.toBe(failure);
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
            { uid: "u9", uin: null, nickname: "昵称", remark: "备注" },
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

    it("分类与好友列表来自同一次快照", async () => {
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
        const { api, service } = makeApi({
            getBuddyListFromCache: vi
                .fn()
                .mockResolvedValueOnce(categories)
                .mockResolvedValueOnce([]),
        });
        const cats = await api.getFriendCategories();
        expect(cats[0]?.buddyList.map(({ uid }) => uid)).toEqual(["ghost"]);
        expect(service.getBuddyListFromCache).toHaveBeenCalledTimes(1);
    });
});

describe("其余方法", () => {
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

    it("getDoubtFriendRequest：映射缺失则省略 UIN；空列表不调用转换", async () => {
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
        expect(out2).toEqual([{ flag: "12345", type: "doubt" }]);
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
});

describe("分类兜底与错误语义补充", () => {
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
});

// ---------------------------------------------------------------------------
// toDoubtFriendRequestInfo 基线断言（原 friend.test.ts，合并保留全部断言）
// ---------------------------------------------------------------------------

describe("toDoubtFriendRequestInfo", () => {
    it("uinMap 无命中时数字形态的 UID 仍只用作 flag", () => {
        const item = { uid: "10001" } as never;
        expect(toDoubtFriendRequestInfo(item, new Map())).toEqual({
            flag: "10001",
            type: "doubt",
        });
    });

    it("uid 形如 u_xxx 且 uinMap 未命中 → 不产出 NaN，uin 字段缺省", () => {
        const item = { uid: "u_a1b2c3" } as never;
        const result = toDoubtFriendRequestInfo(item, new Map());
        expect(result).toEqual({ flag: "u_a1b2c3", type: "doubt" });
        expect("uin" in result).toBe(false);
        // JSON 序列化后不得出现 null（NaN 的序列化产物）
        expect(JSON.stringify(result)).not.toContain("null");
    });

    it("uinMap 命中时 uin 用转换值", () => {
        const item = { uid: "u1" } as never;
        expect(toDoubtFriendRequestInfo(item, new Map([["u1", "10001"]]))).toMatchObject({
            flag: "u1",
            uin: 10001,
            type: "doubt",
        });
    });

    it("全部可选字段填充", () => {
        const item = {
            uid: "u1",
            nick: "小明",
            source: "好友推荐",
            reason: "认识一下",
            msg: "你好",
            groupCode: "g1",
            reqTime: "123456",
        } as never;
        expect(toDoubtFriendRequestInfo(item, new Map([["u1", "10001"]]))).toEqual({
            flag: "u1",
            uin: 10001,
            nick: "小明",
            source: "好友推荐",
            reason: "认识一下",
            msg: "你好",
            group_code: "g1",
            time: "123456",
            type: "doubt",
        });
    });

    it("可选字段缺失不出现键（exactOptionalPropertyTypes）", () => {
        const item = { uid: "u1" } as never;
        const result = toDoubtFriendRequestInfo(item, new Map());
        expect("uin" in result).toBe(false);
        expect("nick" in result).toBe(false);
        expect("source" in result).toBe(false);
        expect("reason" in result).toBe(false);
        expect("msg" in result).toBe(false);
        expect("group_code" in result).toBe(false);
        expect("time" in result).toBe(false);
    });
});
