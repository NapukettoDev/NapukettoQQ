/**
 * satori/api/satori-api.test.ts：SatoriApi 依赖聚合单测。
 *
 * 锁定：
 *  - 构造：字段装配（self/selfUin/cacheDir/groupCache 透传）
 *  - resolvePeer 三分支：缓存命中群聊 / 缓存命中私聊 / 未命中先试群号
 *    （getGroupInfo 成功=群、失败=私聊并缓存结果）
 *  - setChannelType 回填影响后续 resolvePeer
 *  - uinToUid / uidToUin 委托 groupApi；toCanonicalDeps 组装
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { type StubSatoriApi, stubSatoriApi } from "../../action/__tests__/test-support.js";
import { SatoriApi } from "../satori-api.js";

/** 构造 SatoriApi（kernel apis 用桩，可选注入 groupCache）。 */
function makeApi(api: StubSatoriApi, groupCache?: unknown): SatoriApi {
    return new SatoriApi({
        msgApi: api.msgApi as never,
        groupApi: api.groupApi as never,
        groupNotifyApi: api.groupNotifyApi as never,
        friendApi: api.friendApi as never,
        profileApi: api.profileApi as never,
        self: api.self,
        cacheDir: api.cacheDir,
        ...(groupCache !== undefined ? { groupCache: groupCache as never } : {}),
    });
}

describe("构造与字段装配", () => {
    it("self / selfUin / cacheDir / groupCache 装配", () => {
        const api = makeApi(stubSatoriApi());
        expect(api.selfUin).toBe("10001");
        expect(api.self).toEqual({ uin: "10001", nickname: "机器人" });
        expect(api.cacheDir).toBe("/tmp/nk-cache");
        expect(api.groupCache).toBeUndefined();
    });

    it("groupCache 可选注入", () => {
        const cache = { getMembers: async () => [] };
        const satoriApi = makeApi(stubSatoriApi(), cache);
        expect(satoriApi.groupCache).toBe(cache);
    });
});

describe("resolvePeer", () => {
    it("缓存命中 isGroup=true：直接返回群聊 Peer，不查原生", async () => {
        const api = stubSatoriApi();
        const satoriApi = makeApi(api);
        satoriApi.setChannelType("10001", true);
        await expect(satoriApi.resolvePeer("10001")).resolves.toEqual({
            chatType: ChatType.GROUP,
            peerUid: "10001",
        });
        expect(api.groupApi.getGroupInfo).not.toHaveBeenCalled();
    });

    it("缓存命中 isGroup=false：直接走私聊（uin→uid）", async () => {
        const api = stubSatoriApi();
        const satoriApi = makeApi(api);
        satoriApi.setChannelType("90001", false);
        await expect(satoriApi.resolvePeer("90001")).resolves.toEqual({
            chatType: ChatType.C2C,
            peerUid: "uid_90001",
        });
        expect(api.groupApi.uinToUid).toHaveBeenCalledWith(["90001"]);
        expect(api.groupApi.getGroupInfo).not.toHaveBeenCalled();
    });

    it("未命中：getGroupInfo 成功 → 群聊 Peer 且缓存回填", async () => {
        const api = stubSatoriApi();
        const satoriApi = makeApi(api);
        await expect(satoriApi.resolvePeer("10001")).resolves.toEqual({
            chatType: ChatType.GROUP,
            peerUid: "10001",
        });
        expect(api.groupApi.getGroupInfo).toHaveBeenCalledWith("10001");
        // 二次调用直接命中缓存（getGroupInfo 只调一次）
        await satoriApi.resolvePeer("10001");
        expect(api.groupApi.getGroupInfo).toHaveBeenCalledTimes(1);
    });

    it("未命中且 getGroupInfo 失败 → 私聊 Peer 且缓存 false", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupInfo).mockRejectedValueOnce(new Error("群不存在"));
        const satoriApi = makeApi(api);
        await expect(satoriApi.resolvePeer("90001")).resolves.toEqual({
            chatType: ChatType.C2C,
            peerUid: "uid_90001",
        });
        // 私聊也回填 isGroup=false：第二次不再探测群号，但 uin→uid 转换仍执行
        await satoriApi.resolvePeer("90001");
        expect(api.groupApi.getGroupInfo).toHaveBeenCalledTimes(1);
        expect(api.groupApi.uinToUid).toHaveBeenCalledTimes(2);
    });

    it("私聊 uinToUid 未命中该 uin：peerUid 退化用原 uin", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupInfo).mockRejectedValueOnce(new Error("x"));
        vi.mocked(api.groupApi.uinToUid).mockResolvedValueOnce(new Map());
        const satoriApi = makeApi(api);
        await expect(satoriApi.resolvePeer("90002")).resolves.toEqual({
            chatType: ChatType.C2C,
            peerUid: "90002",
        });
    });
});

describe("委托方法", () => {
    it("uinToUid / uidToUin 直接委托 groupApi", async () => {
        const api = stubSatoriApi();
        const satoriApi = makeApi(api);
        await satoriApi.uinToUid(["1"]);
        await satoriApi.uidToUin(["uid_1"]);
        expect(api.groupApi.uinToUid).toHaveBeenCalledWith(["1"]);
        expect(api.groupApi.uidToUin).toHaveBeenCalledWith(["uid_1"]);
    });

    it("toCanonicalDeps：uinToUid 委托 + cacheDir 透传", async () => {
        const api = stubSatoriApi();
        const satoriApi = makeApi(api);
        const deps = satoriApi.toCanonicalDeps();
        expect(deps.cacheDir).toBe("/tmp/nk-cache");
        await expect(deps.uinToUid(["9"])).resolves.toEqual(new Map([["9", "uid_9"]]));
        expect(api.groupApi.uinToUid).toHaveBeenCalledWith(["9"]);
    });
});

describe("setChannelType", () => {
    it("同一 channel_id 二次回填覆盖旧值", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupInfo).mockRejectedValue(new Error("x"));
        const satoriApi = makeApi(api);
        satoriApi.setChannelType("123", false);
        satoriApi.setChannelType("123", true);
        await expect(satoriApi.resolvePeer("123")).resolves.toEqual({
            chatType: ChatType.GROUP,
            peerUid: "123",
        });
        expect(api.groupApi.getGroupInfo).not.toHaveBeenCalled();
    });

    it("resolvePeer 的 spy 验证（vi.fn 兼容性自检）", async () => {
        const api = stubSatoriApi();
        const satoriApi = makeApi(api);
        const spy = vi.spyOn(satoriApi, "uinToUid");
        await satoriApi.uinToUid(["5"]);
        expect(spy).toHaveBeenCalledWith(["5"]);
    });
});
