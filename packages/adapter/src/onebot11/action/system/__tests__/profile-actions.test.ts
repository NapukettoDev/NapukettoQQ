/**
 * 资料动作测试：set_self_longnick / set_qq_profile / set_qq_avatar / download_file。
 *
 * 锁定行为：ProfileApi 参数映射（昵称/签名/头像路径）、本地头像文件校验（缺失 →
 * 102）、URL 头像下载落盘（cacheDir 缺省 → 106、HTTP 非 200 报错、成功写入）、
 * download_file 的缓存目录/文件名/内容与未配置分支。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DownloadFileAction } from "../download-file.js";
import {
    SetQQAvatarAction,
    SetQQProfileAction,
    SetSelfLongnickAction,
} from "../profile-actions.js";

let tmpRoot = "";
afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

/** 就绪临时目录（首次调用创建）。 */
function ensureTmp(): string {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "nk-test-ob11-profile-"));
    }
    return tmpRoot;
}

/** 构造 Response 桩（fetch 全局桩用）。 */
function makeResponse(ok: boolean, body: string, status = ok ? 200 : 500): Response {
    return {
        ok,
        status,
        statusText: ok ? "OK" : "Internal Server Error",
        arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    } as unknown as Response;
}

describe("set_self_longnick / set_qq_profile", () => {
    it("个性签名 → setLongNick", async () => {
        const profileApi = { setLongNick: vi.fn(async () => undefined) };
        const result = await new SetSelfLongnickAction(profileApi as never).handle({
            longNick: "新签名",
        });
        expect(result.retcode).toBe(0);
        expect(profileApi.setLongNick).toHaveBeenCalledWith("新签名");
    });

    it("昵称必调；personal_note 有值才调 setLongNick", async () => {
        const profileApi = {
            setNickName: vi.fn(async () => undefined),
            setLongNick: vi.fn(async () => undefined),
        };
        const action = new SetQQProfileAction(profileApi as never);
        await action.handle({ nickname: "新昵称" });
        expect(profileApi.setNickName).toHaveBeenCalledWith("新昵称");
        expect(profileApi.setLongNick).not.toHaveBeenCalled();
        await action.handle({ nickname: "新昵称", personal_note: "签名" });
        expect(profileApi.setLongNick).toHaveBeenCalledWith("签名");
    });

    it("缺 nickname → retcode 400", async () => {
        const action = new SetQQProfileAction({ setNickName: vi.fn() } as never);
        expect((await action.handle({})).retcode).toBe(400);
    });
});

describe("set_qq_avatar", () => {
    it("本地文件存在 → setHeader(绝对路径)", async () => {
        const dir = ensureTmp();
        const avatar = join(dir, "avatar.png");
        writeFileSync(avatar, "png");
        const profileApi = { setHeader: vi.fn(async () => undefined) };
        const result = await new SetQQAvatarAction({ profileApi } as never).handle({
            file: avatar,
        });
        expect(result.retcode).toBe(0);
        expect(profileApi.setHeader).toHaveBeenCalledWith(avatar);
    });

    it("本地文件不存在 → retcode 102 NOT_FOUND", async () => {
        const dir = ensureTmp();
        const missing = join(dir, "no-such-avatar.png");
        const result = await new SetQQAvatarAction({
            profileApi: { setHeader: vi.fn() },
        } as never).handle({ file: missing });
        expect(result.retcode).toBe(102);
        expect(result.message).toContain("头像文件不存在");
    });

    it("URL 头像：下载落盘后 setHeader（fetch 桩 200）", async () => {
        const dir = ensureTmp();
        const fetchStub = vi.fn(async () => makeResponse(true, "png-bytes"));
        vi.stubGlobal("fetch", fetchStub);
        try {
            const profileApi = { setHeader: vi.fn(async (_path: string) => undefined) };
            const result = await new SetQQAvatarAction({
                profileApi,
                cacheDir: dir,
            } as never).handle({ file: "https://example.com/a.png" });
            expect(result.retcode).toBe(0);
            const written = profileApi.setHeader.mock.calls[0]?.[0] as string;
            expect(written.startsWith(join(dir, "avatar-"))).toBe(true);
            expect(readFileSync(written, "utf8")).toBe("png-bytes");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("URL 头像 pathname 为 / → safeName 兜底 avatar.bin", async () => {
        const dir = ensureTmp();
        const fetchStub = vi.fn(async () => makeResponse(true, "png-bytes"));
        vi.stubGlobal("fetch", fetchStub);
        try {
            const profileApi = { setHeader: vi.fn(async (_path: string) => undefined) };
            const result = await new SetQQAvatarAction({
                profileApi,
                cacheDir: dir,
            } as never).handle({ file: "https://example.com/" });
            expect(result.retcode).toBe(0);
            expect(basename(profileApi.setHeader.mock.calls[0]?.[0] as string)).toContain(
                "avatar.bin",
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("URL 头像：HTTP 非 200 → 抛错（retcode 999 未知错误）", async () => {
        const dir = ensureTmp();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => makeResponse(false, "", 404)),
        );
        try {
            const result = await new SetQQAvatarAction({
                profileApi: { setHeader: vi.fn() },
                cacheDir: dir,
            } as never).handle({ file: "https://example.com/a.png" });
            expect(result.retcode).toBe(999);
            expect(result.message).toContain("头像下载失败");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("URL 头像：未注入 cacheDir → retcode 106", async () => {
        const result = await new SetQQAvatarAction({
            profileApi: { setHeader: vi.fn() },
        } as never).handle({ file: "https://example.com/a.png" });
        expect(result.retcode).toBe(106);
        expect(result.message).toContain("缓存目录");
    });
});

describe("download_file", () => {
    it("成功：写入 cacheDir 并返回绝对路径（headers 透传 fetch）", async () => {
        const dir = ensureTmp();
        const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init?.headers).toEqual({ "x-a": "1" });
            return makeResponse(true, "file-bytes");
        });
        vi.stubGlobal("fetch", fetchStub);
        try {
            const result = await new DownloadFileAction({ cacheDir: dir } as never).handle({
                url: "https://example.com/pkg.bin",
                headers: { "x-a": "1" },
            });
            expect(result.status).toBe("ok");
            const file = result.data?.file ?? "";
            expect(file.startsWith(join(dir, "download-"))).toBe(true);
            expect(readFileSync(file, "utf8")).toBe("file-bytes");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("URL 无文件名（pathname 为 /）→ safeName 兜底 download.bin", async () => {
        const dir = ensureTmp();
        const fetchStub = vi.fn(async () => makeResponse(true, "bytes"));
        vi.stubGlobal("fetch", fetchStub);
        try {
            const result = await new DownloadFileAction({ cacheDir: dir } as never).handle({
                url: "https://example.com/",
            });
            expect(result.status).toBe("ok");
            expect(basename(result.data?.file ?? "")).toContain("download.bin");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("HTTP 非 200 → 抛错（retcode 999）", async () => {
        const dir = ensureTmp();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => makeResponse(false, "", 403)),
        );
        try {
            const result = await new DownloadFileAction({ cacheDir: dir } as never).handle({
                url: "https://example.com/pkg.bin",
            });
            expect(result.retcode).toBe(999);
            expect(result.message).toContain("下载失败");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("cacheDir 未注入 → retcode 106（INVALID_STATE）", async () => {
        const result = await new DownloadFileAction({} as never).handle({
            url: "https://example.com/x",
        });
        expect(result.retcode).toBe(106);
        expect(result.message).toContain("缓存目录");
    });
});
