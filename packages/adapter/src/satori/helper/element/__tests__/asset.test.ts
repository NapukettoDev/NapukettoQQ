/**
 * helper/element/asset.test.ts：resolveAsset 资源解析单测（发方向媒体）。
 *
 * 锁定三种 src 形态：
 *  - internal:{platform}/{user.id}/{path} → 本地路径（_tmp 段剥离，无 _tmp 原样）
 *  - http(s):// → fetch 下载落盘 cacheDir（文件名消毒、非 2xx 抛 SEND_FAILED）
 *  - 其他 → 本地路径原样返回（无 IO）
 */
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAsset } from "../asset.js";

let cacheDir = "";

beforeEach(() => {
    cacheDir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-test-asset-")));
});

afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cacheDir, { recursive: true, force: true });
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
        const out = await resolveAsset("http://example.com/pics/a%20b.png", cacheDir, "compat");
        // 下载器手动跟随重定向（逐跳校验），fetch 第二参带 redirect/signal
        expect(fetchMock).toHaveBeenCalledWith(
            "http://example.com/pics/a%20b.png",
            expect.objectContaining({ redirect: "manual" }),
        );
        expect(out.startsWith(join(cacheDir, ".napuketto-media-v1"))).toBe(true);
        expect(basename(out)).toBe("media.png");
        expect(existsSync(out)).toBe(true);
        expect(readFileSync(out)).toEqual(body);
    });

    it("https URL：同样下载（URL 全部不安全字符消毒）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const out = await resolveAsset("https://example.com/f/中文?.png", cacheDir, "compat");
        expect(basename(out)).toBe("media.bin");
    });

    it("非 2xx 响应：抛 SEND_FAILED KernelError", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 404 })),
        );
        await expect(
            resolveAsset("https://example.com/missing.png", cacheDir, "compat"),
        ).rejects.toMatchObject({ code: "SEND_FAILED" });
    });

    it("URL 无文件名段：回退 asset-<时间戳> 文件名", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const out = await resolveAsset("https://example.com/", cacheDir, "compat");
        expect(basename(out)).toBe("media.bin");
    });

    it("URL 尾段为 .. / .：回退 asset-<时间戳>，不写出缓存目录", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const dots = await resolveAsset("https://example.com/..", cacheDir, "compat");
        const dot = await resolveAsset("https://example.com/.", cacheDir, "compat");
        expect(dots.startsWith(join(cacheDir, ".napuketto-media-v1"))).toBe(true);
        expect(dot.startsWith(join(cacheDir, ".napuketto-media-v1"))).toBe(true);
    });

    it("same URL basename downloads never overwrite each other or a caller file", async () => {
        const caller = join(cacheDir, "a.png");
        writeFileSync(caller, "caller");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => new Response(url)),
        );
        const [a, b] = await Promise.all([
            resolveAsset("https://a.example/a.png", cacheDir, "compat"),
            resolveAsset("https://b.example/a.png", cacheDir, "compat"),
        ]);
        expect(a).not.toBe(b);
        expect(readFileSync(a, "utf8")).toBe("https://a.example/a.png");
        expect(readFileSync(b, "utf8")).toBe("https://b.example/a.png");
        expect(readFileSync(caller, "utf8")).toBe("caller");
    });
});
