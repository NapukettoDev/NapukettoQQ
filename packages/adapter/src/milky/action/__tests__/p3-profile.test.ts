/**
 * Milky 系统 + 资料类动作测试（system.ts + profile.ts）
 *
 * 锁定：get_login_info/get_impl_info 版本协商面、get_user_profile 字段映射
 * （无源字段空兜底）、get_friend_info 命中与 NOT_FOUND、set_nickname/set_bio
 * 透传、get_cookies k=v 拼接、get_csrf_token bkn 派生、set_avatar 远程 URI
 * 下载链（@napuketto/media downloadUrl mock，不触网）。
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketApi } from "@napuketto/kernel";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiOverrides, actionOf, buildMilkyApi, registryOf } from "./test-support.js";

vi.mock("@napuketto/media", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    downloadUrl: vi.fn(async (_url: string, _dest: string) => 4),
}));

/** 资料类依赖桩（stranger / cookies 可覆写）。 */
function profileApi(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            profileApi: {
                getStrangerInfo: vi.fn(async (_uid: string) => ({
                    nickname: "陌生人",
                    qid: "qid-1",
                    age: 18,
                    sex: 1,
                    remark: "备",
                    long_nick: "签名",
                    qq_level: 42,
                })),
                setHeader: vi.fn(async () => undefined),
                setNickName: vi.fn(async () => undefined),
                setLongNick: vi.fn(async () => undefined),
                ...overrides.profileApi,
            },
            ticketApi: {
                getCookies: vi.fn(async (_domain: string, _uin: string) => ({
                    skey: "@abc",
                    uin: "s10000",
                })),
                ...overrides.ticketApi,
            },
            friendApi: {
                getFriendList: vi.fn(async () => [
                    { uid: "uid-20002", uin: "20002", nickname: "甲", remark: "备注甲" },
                ]),
                ...overrides.friendApi,
            },
            ...(overrides.mediaDir !== undefined ? { mediaDir: overrides.mediaDir } : {}),
        }),
    );
}

afterAll(async () => {
    for (const dir of mediaDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
});

/** 用例内创建的临时目录（afterAll 统一清理）。 */
const mediaDirs: string[] = [];

describe("系统动作（system.ts）", () => {
    it("get_login_info：uin 数值化 + nickname 透传", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_login_info").handle({});
        expect(res.status).toBe("ok");
        expect(res.data).toEqual({ uin: 10000, nickname: "机器人" });
    });

    it("get_impl_info：五字段版本协商面（milky_version=1.3 / windows）", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_impl_info").handle({});
        expect(res.data).toEqual({
            impl_name: "napukettoqq",
            impl_version: "0.0.0",
            qq_protocol_version: "9.9.9-test",
            qq_protocol_type: "windows",
            milky_version: "1.3",
        });
    });

    it("get_login_info 多余字段 → -400（schema strict）", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_login_info").handle({ extra: 1 });
        expect(res.retcode).toBe(-400);
    });
});

describe("get_user_profile", () => {
    it("字段映射：bio/level 取 long_nick/qq_level，无源字段空串", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_user_profile").handle({ user_id: 20002 });
        expect(res.data).toEqual({
            nickname: "陌生人",
            qid: "qid-1",
            age: 18,
            sex: 1,
            remark: "备",
            bio: "签名",
            level: 42,
            country: "",
            city: "",
            school: "",
        });
    });

    it("入参 uin 直传 getStrangerInfo（kernel 侧再转 uid）", async () => {
        const getStrangerInfo = vi.fn(async () => ({ nickname: "n" }));
        const registry = profileApi({ profileApi: { getStrangerInfo } });
        await actionOf(registry, "get_user_profile").handle({ user_id: 20002 });
        expect(getStrangerInfo).toHaveBeenCalledWith("20002");
    });

    it("缺 user_id → -400", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_user_profile").handle({});
        expect(res.retcode).toBe(-400);
    });
});

describe("get_friend_info", () => {
    it("命中：friend 实体（uid/uin/昵称/备注）", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_friend_info").handle({ user_id: 20002 });
        expect(res.data).toEqual({
            friend: {
                user_id: 20002,
                nickname: "甲",
                sex: "unknown",
                qid: "",
                remark: "备注甲",
                category: { category_id: 0, category_name: "" },
            },
        });
    });

    it("未命中 → NOT_FOUND（-404）", async () => {
        const registry = profileApi();
        const res = await actionOf(registry, "get_friend_info").handle({ user_id: 99999 });
        expect(res.status).toBe("failed");
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("好友 99999 不存在");
    });
});

describe("set_nickname / set_bio", () => {
    it("透传 new_nickname 给 ProfileApi.setNickName", async () => {
        const setNickName = vi.fn(async () => undefined);
        const registry = profileApi({ profileApi: { setNickName } });
        const res = await actionOf(registry, "set_nickname").handle({ new_nickname: "新名" });
        expect(res.status).toBe("ok");
        expect(setNickName).toHaveBeenCalledWith("新名");
    });

    it("透传 new_bio 给 ProfileApi.setLongNick", async () => {
        const setLongNick = vi.fn(async () => undefined);
        const registry = profileApi({ profileApi: { setLongNick } });
        const res = await actionOf(registry, "set_bio").handle({ new_bio: "新签名" });
        expect(res.status).toBe("ok");
        expect(setLongNick).toHaveBeenCalledWith("新签名");
    });
});

describe("get_cookies / get_csrf_token", () => {
    it("get_cookies：对象 → k=v 分号拼接（domain 透传）", async () => {
        const getCookies = vi.fn(async () => ({ skey: "@abc", uin: "s10000" }));
        const registry = profileApi({ ticketApi: { getCookies } });
        const res = await actionOf(registry, "get_cookies").handle({ domain: "qq.com" });
        expect(res.data).toEqual({ cookies: "skey=@abc; uin=s10000" });
        expect(getCookies).toHaveBeenCalledWith("qq.com", "10000");
    });

    it("get_csrf_token：qun.qq.com skey → bkn（TicketApi.getBkn 口径）", async () => {
        const getCookies = vi.fn(async (domain: string) => ({
            skey: domain === "qun.qq.com" ? "@skey-x" : "",
        }));
        const registry = profileApi({ ticketApi: { getCookies } });
        const res = await actionOf(registry, "get_csrf_token").handle({});
        expect(res.data).toEqual({ csrf_token: TicketApi.getBkn("@skey-x") });
        expect(getCookies).toHaveBeenCalledWith("qun.qq.com", "10000");
    });

    it("skey 缺失 → bkn 按 getBkn('') 口径", async () => {
        const registry = profileApi({ ticketApi: { getCookies: vi.fn(async () => ({})) } });
        const res = await actionOf(registry, "get_csrf_token").handle({});
        expect(res.data).toEqual({ csrf_token: TicketApi.getBkn("") });
    });
});

describe("set_avatar（远程 URI 下载链）", () => {
    let mediaDir = "";

    beforeEach(async () => {
        mediaDir = await mkdtempUnique();
    });

    it("http(s) URI：downloadUrl 落盘 mediaDir，setHeader 收到落盘路径", async () => {
        const setHeader = vi.fn(async () => undefined);
        const registry = profileApi({ profileApi: { setHeader }, mediaDir });
        const res = await actionOf(registry, "set_avatar").handle({
            uri: "http://127.0.0.1:1/a.png",
        });
        expect(res.status).toBe("ok");
        const downloadUrl = (await import("@napuketto/media")).downloadUrl as ReturnType<
            typeof vi.fn
        >;
        expect(downloadUrl).toHaveBeenCalledTimes(1);
        const [url, dest] = downloadUrl.mock.calls[0] as unknown as [string, string];
        expect(url).toBe("http://127.0.0.1:1/a.png");
        expect(dest.startsWith(mediaDir)).toBe(true);
        expect(setHeader).toHaveBeenCalledWith(dest);
    });

    it("mediaDir 未配置 + 远程 URI → INVALID_PARAM（-400）", async () => {
        const registry = profileApi({});
        const res = await actionOf(registry, "set_avatar").handle({
            uri: "http://127.0.0.1:1/a.png",
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("cacheDir");
    });

    it("空 uri → -400（schema min(1)）", async () => {
        const registry = profileApi({ mediaDir });
        const res = await actionOf(registry, "set_avatar").handle({ uri: "" });
        expect(res.retcode).toBe(-400);
    });
});

/** 唯一临时目录（跨平台安全：os.tmpdir + mkdtemp）。 */
async function mkdtempUnique(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "nk-test-milky-avatar-"));
    mediaDirs.push(dir);
    return dir;
}
