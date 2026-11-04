/**
 * profile.ts ProfileApi + profile-like.ts ProfileLikeApi 测试（此前报告缺失模块）：
 *  - ProfileApi：constructor 空校验 / setLongNick / setNickName（宽松 result）/
 *    setHeader（严格 result）/ getStrangerInfo（uin → uid → 详情扁平化全链路）
 *  - ProfileLikeApi：constructor 空校验 / sendLike 参数形状（sourceId=71）与失败分支
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { ProfileApi } from "../profile.js";
import { ProfileLikeApi } from "../profile-like.js";
import { makeSession } from "../test-support.js";

describe("ProfileApi", () => {
    function makeApi(overrides: Record<string, unknown> = {}) {
        const service = {
            setLongNick: vi.fn(async () => ({ result: 0 })),
            setNickName: vi.fn(async () => ({ result: 0 })),
            setHeader: vi.fn(async () => ({ result: 0, errMsg: "" })),
            getUserDetailInfoByUin: vi.fn(async () => ({ detail: { uid: "uid-x" } })),
            getUserDetailInfo: vi.fn(async () => ({})),
            ...overrides,
        };
        const api = new ProfileApi(makeSession({ getProfileService: () => service }));
        return { api, service };
    }

    it("getProfileService 空 / undefined → INVALID_STATE", () => {
        expect(() => new ProfileApi(makeSession({ getProfileService: () => null }))).toThrow(
            /getProfileService\(\) 返回空/,
        );
        expect(() => new ProfileApi(makeSession({ getProfileService: () => undefined }))).toThrow(
            /getProfileService\(\) 返回空/,
        );
    });

    it("setLongNick：宽松 result 成功放行 / 数字非 0 抛错 / undefined 视为成功", async () => {
        const { api, service } = makeApi();
        await api.setLongNick("签名");
        expect(service.setLongNick).toHaveBeenCalledWith("签名");
        const { api: api2 } = makeApi({
            setLongNick: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(api2.setLongNick("签名")).rejects.toBeInstanceOf(KernelError);
        const { api: api3 } = makeApi({ setLongNick: vi.fn(async () => undefined) });
        await expect(api3.setLongNick("签名")).resolves.toBeUndefined();
    });

    it("setNickName：宽松 result 成功 / 非 0 抛错", async () => {
        const { api, service } = makeApi();
        await api.setNickName("新昵称");
        expect(service.setNickName).toHaveBeenCalledWith("新昵称");
        const { api: api2 } = makeApi({
            setNickName: vi.fn(async () => ({ result: 2, errMsg: "x" })),
        });
        await expect(api2.setNickName("新昵称")).rejects.toMatchObject({
            message: /setNickName 失败/,
        });
    });

    it("setHeader：严格 result 成功 / 非 0 抛 UNKNOWN", async () => {
        const { api, service } = makeApi();
        await api.setHeader("/tmp/a.png");
        expect(service.setHeader).toHaveBeenCalledWith("/tmp/a.png");
        const { api: api2 } = makeApi({
            setHeader: vi.fn(async () => ({ result: 5, errMsg: "bad" })),
        });
        await expect(api2.setHeader("/tmp/a.png")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /setHeader 失败: bad/,
        });
    });

    it("getStrangerInfo：uin 初查得 uid → 详情扁平化（双来源合并）", async () => {
        const byUin = {
            detail: {
                uid: "uid-x",
                simpleInfo: {
                    coreInfo: { nick: "初查昵称", remark: "" },
                    baseInfo: { sex: 1 },
                },
            },
        };
        const info = {
            detail: {
                simpleInfo: {
                    coreInfo: { nick: "全量昵称", remark: "备注" },
                    baseInfo: { age: 18, qid: "q1", sex: 2, longNick: "长签" },
                    vasInfo: { svipFlag: true, yearVipFlag: false, vipLevel: 3 },
                    status: { status: 10 },
                },
                commonExt: { qqLevel: 42, regTime: 1600000000 },
            },
        };
        const { api, service } = makeApi({
            getUserDetailInfoByUin: vi.fn(async () => byUin),
            getUserDetailInfo: vi.fn(async () => info),
        });
        await expect(api.getStrangerInfo("10001")).resolves.toEqual({
            user_id: 10001,
            uid: "uid-x",
            nickname: "全量昵称",
            age: 18,
            qid: "q1",
            qq_level: 42,
            sex: "female",
            long_nick: "长签",
            reg_time: 1600000000,
            is_vip: true,
            is_years_vip: false,
            vip_level: 3,
            remark: "备注",
            status: 10,
            login_days: 0,
        });
        // 调用链：先按 uin 查，再按 uid 查详情
        expect(service.getUserDetailInfoByUin).toHaveBeenCalledWith("10001");
        expect(service.getUserDetailInfo).toHaveBeenCalledWith("uid-x");
    });

    it("getStrangerInfo：uin 查询无 uid 时回退 uin 作 uid；字段全缺给默认", async () => {
        const { api } = makeApi({
            getUserDetailInfoByUin: vi.fn(async () => ({ detail: {} })),
            getUserDetailInfo: vi.fn(async () => ({})),
        });
        const result = await api.getStrangerInfo("10001");
        expect(result.uid).toBe("10001");
        expect(result.nickname).toBe("");
        expect(result.sex).toBe("unknown");
        expect(result.is_vip).toBe(false);
    });
});

describe("ProfileLikeApi", () => {
    function makeApi(overrides: Record<string, unknown> = {}) {
        const service = {
            setBuddyProfileLike: vi.fn(async () => ({ result: 0, errMsg: "" })),
            ...overrides,
        };
        const api = new ProfileLikeApi(makeSession({ getProfileLikeService: () => service }));
        return { api, service };
    }

    it("getProfileLikeService 空 / undefined → INVALID_STATE", () => {
        expect(
            () => new ProfileLikeApi(makeSession({ getProfileLikeService: () => null })),
        ).toThrow(/getProfileLikeService\(\) 返回空/);
        expect(
            () => new ProfileLikeApi(makeSession({ getProfileLikeService: () => undefined })),
        ).toThrow(/getProfileLikeService\(\) 返回空/);
    });

    it("sendLike：默认 1 次；参数形状（friendUid/sourceId=71/doLikeCount/doLikeTollCount）", async () => {
        const { api, service } = makeApi();
        await api.sendLike("uid-1");
        expect(service.setBuddyProfileLike).toHaveBeenCalledWith({
            friendUid: "uid-1",
            sourceId: 71,
            doLikeCount: 1,
            doLikeTollCount: 0,
        });
        await api.sendLike("uid-1", 10);
        expect(service.setBuddyProfileLike).toHaveBeenLastCalledWith({
            friendUid: "uid-1",
            sourceId: 71,
            doLikeCount: 10,
            doLikeTollCount: 0,
        });
    });

    it("sendLike：result 非 0 抛 UNKNOWN", async () => {
        const { api } = makeApi({
            setBuddyProfileLike: vi.fn(async () => ({ result: 7, errMsg: "limit" })),
        });
        await expect(api.sendLike("uid-1")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /点赞失败: limit/,
        });
    });
});
