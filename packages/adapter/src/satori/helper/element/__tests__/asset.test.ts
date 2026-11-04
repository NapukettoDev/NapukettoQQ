/**
 * helper/element/asset.test.ts：resolveAsset 资源解析单测（发方向媒体）。
 *
 * 锁定三种 src 形态：
 *  - internal:{platform}/{user.id}/{path} → 本地路径（_tmp 段剥离，无 _tmp 原样）
 *  - http(s):// → fetch 下载落盘 cacheDir（文件名消毒、非 2xx 抛 SEND_FAILED）
 *  - 其他 → 本地路径原样返回（无 IO）
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAsset } from "../asset.js";

let cacheDir = "";

afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "nk-test-asset-"));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("resolveAsset：internal: 路径", () => {
    it("internal:{platform}/{uid}/{path} → 本地路径（剥前缀）", async () => {
        await expect(resolveAsset("internal:qq/10001/Emoji/x.png", cacheDir)).resolves.toBe(
            "Emoji/x.png",
        );
    });

    it("_tmp 段剥离（保留 _tmp/ 之后的部分）", async () => {
        await expect(resolveAsset("internal:qq/10001/_tmp/pic/a.jpg", cacheDir)).resolves.toBe(
            "pic/a.jpg",
        );
    });

    it("只有一段（无第二个斜杠）→ 原样返回", async () => {
        await expect(resolveAsset("internal:onlyname.png", cacheDir)).resolves.toBe("onlyname.png");
    });

    it("两段无 _tmp（platform/uid 形态但 path 缺失）→ 原样 pathPart", async () => {
        await expect(resolveAsset("internal:qq/10001", cacheDir)).resolves.toBe("qq/10001");
    });
});

describe("resolveAsset：本地路径", () => {
    it("非 http / 非 internal 前缀：原样返回（无下载）", async () => {
        await expect(resolveAsset("/abs/path/a.png", cacheDir)).resolves.toBe("/abs/path/a.png");
        await expect(resolveAsset("C:\\dir\\a.png", cacheDir)).resolves.toBe("C:\\dir\\a.png");
    });
});

describe("resolveAsset：http(s) 下载", () => {
    it("http URL → fetch 成功后落盘 cacheDir（文件名取 URL 尾段）", async () => {
        const body = Buffer.from("png-data");
        const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const out = await resolveAsset("http://example.com/pics/a%20b.png", cacheDir);
        expect(fetchMock).toHaveBeenCalledWith("http://example.com/pics/a%20b.png");
        // 文件名消毒：'%' 替换为 _（数字 2/0 是安全字符保留）
        const expected = join(cacheDir, "a_20b.png");
        expect(out).toBe(expected);
        expect(existsSync(expected)).toBe(true);
        expect(readFileSync(expected)).toEqual(body);
    });

    it("https URL：同样下载（URL 全部不安全字符消毒）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const out = await resolveAsset("https://example.com/f/中文?.png", cacheDir);
        expect(out).toBe(join(cacheDir, "___.png"));
    });

    it("非 2xx 响应：抛 SEND_FAILED KernelError", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 404 })),
        );
        await expect(
            resolveAsset("https://example.com/missing.png", cacheDir),
        ).rejects.toMatchObject({ code: "SEND_FAILED" });
    });

    it("URL 无文件名段：回退 asset-<时间戳> 文件名", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const out = await resolveAsset("https://example.com/", cacheDir);
        // split("/") 尾段为空串 → 消毒后空 → 回退 asset-*
        expect(out.startsWith(join(cacheDir, "asset-"))).toBe(true);
    });
});
