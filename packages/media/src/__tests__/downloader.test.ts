/**
 * downloader.ts 测试（node:http 本地桩服务，127.0.0.1 临时端口，不访问外网）
 *
 * downloadUrl：成功写盘与字节数、302 跟随、非 2xx、Content-Length 超限、
 * 流式超限（reader 取消）、空 body、204 无 body、超时、覆盖写；
 * inferExtension：Content-Type 优先（含参数与大小写）、URL 扩展名兜底、
 * 非法输入落 .bin。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadUrl, inferExtension } from "../downloader.js";
import { cleanupTempDir, type HttpStub, listenHttp, makeTempDir } from "./test-support.js";

describe("downloadUrl", () => {
    const stubs: HttpStub[] = [];
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir("nk-media-dl-");
    });
    afterEach(async () => {
        for (const stub of stubs.reverse()) {
            await stub.close();
        }
        stubs.length = 0;
        cleanupTempDir(dir);
    });

    /** 起桩并登记 afterEach 关闭。 */
    async function serve(
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    ): Promise<HttpStub> {
        const stub = await listenHttp(handler);
        stubs.push(stub);
        return stub;
    }

    it("成功下载：内容写盘、返回字节数", async () => {
        const payload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff]);
        const stub = await serve((_req, res) => {
            res.setHeader("content-type", "image/png");
            res.end(payload);
        });
        const dest = join(dir, "out.png");

        const written = await downloadUrl(stub.url, dest);

        expect(written).toBe(payload.length);
        expect(readFileSync(dest)).toEqual(payload);
    });

    it("302 重定向跟随，内容取自 Location 目标", async () => {
        const payload = Buffer.from("redirected-content");
        const stub = await serve((req, res) => {
            if (req.url === "/redirect") {
                res.statusCode = 302;
                res.setHeader("location", `/final`);
                res.end();
                return;
            }
            res.setHeader("content-type", "application/octet-stream");
            res.end(payload);
        });
        const dest = join(dir, "out.bin");

        const written = await downloadUrl(`${stub.url}/redirect`, dest);

        expect(written).toBe(payload.length);
        expect(readFileSync(dest)).toEqual(payload);
    });

    it("非 2xx（404）→ 抛 HTTP 404", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 404;
            res.end("nope");
        });

        await expect(downloadUrl(stub.url, join(dir, "x.bin"))).rejects.toThrow("HTTP 404");
    });

    it("Content-Length 超限 → 抛错（声明即拒绝，body 未读）", async () => {
        const stub = await serve((_req, res) => {
            res.setHeader("content-length", "100");
            res.end(Buffer.alloc(100, 1));
        });

        await expect(downloadUrl(stub.url, join(dir, "x.bin"), { maxBytes: 50 })).rejects.toThrow(
            "文件超过大小上限（100 > 50 字节）",
        );
    });

    it("流式累计超限（无 Content-Length）→ 抛错并取消 reader", async () => {
        const chunk = Buffer.alloc(40, 7);
        const stub = await serve((_req, res) => {
            res.setHeader("transfer-encoding", "chunked");
            res.write(chunk);
            res.write(chunk);
            res.end(chunk);
        });

        await expect(downloadUrl(stub.url, join(dir, "x.bin"), { maxBytes: 50 })).rejects.toThrow(
            /超过大小上限/,
        );
    });

    it("空 body → 抛错（下载内容为空）", async () => {
        const stub = await serve((_req, res) => {
            res.end();
        });

        await expect(downloadUrl(stub.url, join(dir, "x.bin"))).rejects.toThrow("下载内容为空");
    });

    it("204 无 body → 抛错（响应无 body）", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 204;
            res.end();
        });

        await expect(downloadUrl(stub.url, join(dir, "x.bin"))).rejects.toThrow("响应无 body");
    });

    it("服务端挂起 → 超时中止（timeoutMs 生效）", async () => {
        const stub = await serve(() => {
            // 故意不响应，由客户端超时
        });

        await expect(
            downloadUrl(stub.url, join(dir, "x.bin"), { timeoutMs: 60 }),
        ).rejects.toThrow();
    });

    it("覆盖写：目标已有旧内容时被完全覆盖", async () => {
        const payload = Buffer.from("new-content");
        const stub = await serve((_req, res) => {
            res.end(payload);
        });
        const dest = join(dir, "out.txt");
        writeFileSync(dest, "old-content-much-longer-than-new");

        await downloadUrl(stub.url, dest);

        expect(readFileSync(dest, "utf8")).toBe("new-content");
    });

    it("自定义 maxBytes 内正常下载", async () => {
        const payload = Buffer.alloc(32, 9);
        const stub = await serve((_req, res) => {
            res.end(payload);
        });

        const written = await downloadUrl(stub.url, join(dir, "x.bin"), { maxBytes: 32 });
        expect(written).toBe(32);
    });

    it("非 http(s) 协议：拒绝且不发起请求（file:// 不落到 fetch）", async () => {
        const fetchStub = vi.fn();
        vi.stubGlobal("fetch", fetchStub);
        try {
            await expect(downloadUrl("file:///etc/passwd", join(dir, "x.bin"))).rejects.toThrow(
                "不支持的下载协议",
            );
            expect(fetchStub).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("链路本地地址（云元数据 169.254.169.254）：拒绝且不发起请求", async () => {
        const fetchStub = vi.fn();
        vi.stubGlobal("fetch", fetchStub);
        try {
            await expect(
                downloadUrl("http://169.254.169.254/latest/meta-data/", join(dir, "x.bin")),
            ).rejects.toThrow("禁止访问的下载地址");
            expect(fetchStub).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("IPv6 未指定 / 链路本地地址：拒绝", async () => {
        await expect(downloadUrl("http://[::]/x", join(dir, "a.bin"))).rejects.toThrow(
            "禁止访问的下载地址",
        );
        await expect(downloadUrl("http://[fe80::1]/x", join(dir, "b.bin"))).rejects.toThrow(
            "禁止访问的下载地址",
        );
    });

    it("整数 IP 形式（2852039166）经 URL 归一化后仍按字面地址拦截", async () => {
        // WHATWG URL 会把 2852039166 归一化为 169.254.169.254：校验必须发生在归一化之后
        await expect(downloadUrl("http://2852039166/latest", join(dir, "x.bin"))).rejects.toThrow(
            "禁止访问的下载地址",
        );
    });

    it("重定向到被禁地址：逐跳复检后拒绝（首跳合法也不例外）", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 302;
            res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
            res.end();
        });

        await expect(downloadUrl(`${stub.url}/go`, join(dir, "x.bin"))).rejects.toThrow(
            "禁止访问的下载地址",
        );
    });

    it("重定向次数超过上限：拒绝", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 302;
            res.setHeader("location", "/loop");
            res.end();
        });

        await expect(downloadUrl(`${stub.url}/loop`, join(dir, "x.bin"))).rejects.toThrow(
            "重定向次数超过上限",
        );
    });

    it("headers 透传：附加请求头到达服务端", async () => {
        let seen: string | undefined;
        const stub = await serve((req, res) => {
            seen = req.headers["x-token"] as string | undefined;
            res.end("ok");
        });

        await downloadUrl(stub.url, join(dir, "x.bin"), { headers: { "x-token": "t1" } });

        expect(seen).toBe("t1");
    });

    it("失败不留半成品（临时文件已清理）", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 500;
            res.end("boom");
        });

        await expect(downloadUrl(stub.url, join(dir, "x.bin"))).rejects.toThrow("HTTP 500");
        expect(readdirSync(dir)).toEqual([]);
    });
});

describe("inferExtension", () => {
    it.each([
        ["image/png", "http://x/a", ".png"],
        ["image/jpeg; charset=binary", "http://x/a", ".jpeg"],
        ["IMAGE/WEBP", "http://x/a", ".webp"],
        ["audio/mpeg", "http://x/a", ".mpeg"],
        ["video/mp4", "http://x/a", ".mp4"],
        ["image/svg+xml", "http://x/a", ".svg"],
        [null, "http://x/a.jpg", ".jpg"],
        [null, "http://x/a.JPG?token=1", ".jpg"],
        [null, "http://x/path/to/a.png", ".png"],
        [null, "http://x/a.tar.gz", ".gz"],
        [null, "http://x/noext", ".bin"],
        [null, "http://x/a.abcdefg", ".bin"],
        [null, "http://x/a.ab12", ".ab12"],
        ["text/plain", "http://x/noext", ".bin"],
        ["image/", "http://x/noext", ".bin"],
        ["application/json", "http://x/a.png", ".png"],
    ])("inferExtension(%p, %p) → %p", (contentType, url, expected) => {
        expect(inferExtension(contentType, url)).toBe(expected);
    });

    it("URL 解析失败 → 落 .bin", () => {
        expect(inferExtension(null, "not-a-valid-url")).toBe(".bin");
    });
});
