import {
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheMediaFile, MediaCache } from "../../../../internal/infra/media-cache.js";
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
    it("仅允许当前账号的具名缓存引用，TTL 与缓存一致", async () => {
        let now = 0;
        const cache = new MediaCache({
            root: cacheDir,
            owner: { protocol: "satori", account: "10001" },
            ttlMs: 10,
            now: () => now,
        });
        const file = await cache.run(() =>
            cacheMediaFile(
                cacheDir,
                ".png",
                async (path) => {
                    writeFileSync(path, "png");
                },
                "reference",
            ),
        );
        const id = `${basename(dirname(file))}/${basename(file)}`;
        const src = `internal:qq/10001/_tmp/${id}`;
        const resolve = (uri: string, account = "10001") =>
            cache.run(() => resolveAsset(uri, cacheDir, { account }));
        await expect(resolve(src)).resolves.toBe(file);
        for (const uri of [
            `internal:milky/10001/_tmp/${id}`,
            `internal:qq/10002/_tmp/${id}`,
            `internal:qq/10001/other/_tmp/${id}`,
            `internal:qq/10001/_tmp/../${id}`,
            `internal:qq/10001/_tmp/%2f${id}`,
            "internal:qq/10001/Emoji/x.png",
        ]) {
            await expect(resolve(uri)).rejects.toMatchObject({ code: "INVALID_PARAM" });
        }
        now = 11;
        await expect(resolve(src)).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("裸路径缺省拒绝", async () => {
        await expect(resolveAsset("a.png", cacheDir)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });
});

describe("resolveAsset：http(s) 下载", () => {
    it("http URL → fetch 成功后落盘 cacheDir（文件名取 URL 尾段）", async () => {
        const body = Buffer.from("png-data");
        const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const out = await resolveAsset("http://example.com/pics/a%20b.png", cacheDir, {
            outboundPolicy: "compat",
        });
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
        const out = await resolveAsset("https://example.com/f/中文?.png", cacheDir, {
            outboundPolicy: "compat",
        });
        expect(basename(out)).toBe("media.bin");
    });

    it("非 2xx 响应：抛 SEND_FAILED KernelError", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 404 })),
        );
        await expect(
            resolveAsset("https://example.com/missing.png", cacheDir, { outboundPolicy: "compat" }),
        ).rejects.toMatchObject({ code: "SEND_FAILED" });
    });

    it("URL 无文件名段：回退 asset-<时间戳> 文件名", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const out = await resolveAsset("https://example.com/", cacheDir, {
            outboundPolicy: "compat",
        });
        expect(basename(out)).toBe("media.bin");
    });

    it("URL 尾段为 .. / .：回退 asset-<时间戳>，不写出缓存目录", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(Buffer.from("x"), { status: 200 })),
        );
        const dots = await resolveAsset("https://example.com/..", cacheDir, {
            outboundPolicy: "compat",
        });
        const dot = await resolveAsset("https://example.com/.", cacheDir, {
            outboundPolicy: "compat",
        });
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
            resolveAsset("https://a.example/a.png", cacheDir, { outboundPolicy: "compat" }),
            resolveAsset("https://b.example/a.png", cacheDir, { outboundPolicy: "compat" }),
        ]);
        expect(a).not.toBe(b);
        expect(readFileSync(a, "utf8")).toBe("https://a.example/a.png");
        expect(readFileSync(b, "utf8")).toBe("https://b.example/a.png");
        expect(readFileSync(caller, "utf8")).toBe("caller");
    });
});
