import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadPublicUrl } from "../src/downloader.js";
import { listenHttp } from "./test-support.js";

const { lookup, httpsGet } = vi.hoisted(() => ({ lookup: vi.fn(), httpsGet: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ get: httpsGet }));

describe("downloadPublicUrl", () => {
    let directory: string;
    let dest: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "napuketto-public-download-"));
        dest = join(directory, "media");
        lookup.mockReset();
        httpsGet.mockReset();
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it.each(["127.0.0.1", "[::ffff:192.168.1.1]", "[fc00::1]", "[2002::1]", "100.64.0.1"])(
        "拒绝非公网字面地址 %s，未发起请求",
        async (host) => {
            await expect(downloadPublicUrl(`https://${host}/media`, dest)).rejects.toThrow();
            expect(httpsGet).not.toHaveBeenCalled();
            expect(lookup).not.toHaveBeenCalled();
        },
    );

    it("保留 HTTPS 主机和认证设置，并将每一跳的已校验地址交给连接", async () => {
        const first = [
            { address: "9.9.9.9", family: 4 },
            { address: "2606:4700::1111", family: 6 },
        ];
        const second = [{ address: "8.8.8.8", family: 4 }];
        lookup
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second);
        const hops = [
            { status: 307, headers: { location: "/same" }, addresses: first },
            { status: 302, headers: { location: "https://cdn.example/file" }, addresses: first },
            { status: 200, headers: {}, addresses: second },
        ];
        httpsGet.mockImplementation(
            (url: URL, options: RequestOptions, respond: (response: IncomingMessage) => void) => ({
                once: (_event: string, reject: (error: unknown) => void) => {
                    options.lookup?.(url.hostname, { all: true }, (error, addresses) => {
                        if (error !== null) return reject(error);
                        const hop = hops.shift();
                        expect(addresses).toEqual(hop?.addresses);
                        const response = Object.assign(Readable.from([Buffer.from("asset")]), {
                            statusCode: hop?.status,
                            headers: hop?.headers,
                        });
                        respond(response as IncomingMessage);
                    });
                },
            }),
        );

        await expect(
            downloadPublicUrl("https://media.example/start", dest, {
                headers: {
                    ["Authorization"]: "Bearer test",
                    "X-API-Key": "test-only",
                    ["Host"]: "ignored.example",
                    "Accept-Encoding": "gzip",
                },
            }),
        ).resolves.toBe(5);
        expect(await readFile(dest, "utf8")).toBe("asset");
        expect(lookup.mock.calls).toEqual([
            ["media.example", { all: true }],
            ["media.example", { all: true }],
            ["cdn.example", { all: true }],
        ]);
        const requests = httpsGet.mock.calls.map(([url, options]) => [
            url.hostname,
            options.agent,
            options.rejectUnauthorized,
            options.headers,
        ]);
        expect(requests).toEqual([
            [
                "media.example",
                false,
                true,
                {
                    authorization: "Bearer test",
                    "x-api-key": "test-only",
                    "accept-encoding": "identity",
                },
            ],
            [
                "media.example",
                false,
                true,
                {
                    authorization: "Bearer test",
                    "x-api-key": "test-only",
                    "accept-encoding": "identity",
                },
            ],
            ["cdn.example", false, true, { "accept-encoding": "identity" }],
        ]);
    });

    it.each([
        { status: 302, headers: { location: "/next" }, error: "重定向次数超过上限", calls: 6 },
        { status: 302, headers: {}, error: "重定向缺少 Location", calls: 1 },
        { status: 404, headers: {}, error: "HTTP 404", calls: 1 },
        { status: 200, headers: { "content-length": "2" }, error: "2 > 1 字节", calls: 1 },
        { status: 200, headers: {}, error: "超过大小上限", calls: 1 },
    ])("HTTP $status 的 $error 分支关闭响应", async ({ status, headers, error, calls }) => {
        const closed = vi.fn();
        httpsGet.mockImplementation(
            (
                _url: URL,
                _options: RequestOptions,
                respond: (
                    response: Readable & Pick<IncomingMessage, "statusCode" | "headers">,
                ) => void,
            ) => ({
                once: () => {
                    // 保持响应打开，直到下载器主动销毁 body。
                    const body = new Readable({
                        read() {
                            // No additional chunks are produced.
                        },
                        destroy(error, done) {
                            closed();
                            done(error);
                        },
                    });
                    body.push(Buffer.from("bytes"));
                    respond(Object.assign(body, { statusCode: status, headers }));
                },
            }),
        );
        await expect(
            downloadPublicUrl("https://9.9.9.9/start", dest, { maxBytes: 1 }),
        ).rejects.toThrow(error);
        expect(httpsGet).toHaveBeenCalledTimes(calls);
        expect(closed).toHaveBeenCalledTimes(calls);
        expect(await readdir(directory)).toEqual([]);
    });

    it("真实 HTTP 连接拒绝混合 DNS 结果，跳转目标未收到请求", async () => {
        const handler = vi.fn();
        const stub = await listenHttp(handler);
        try {
            lookup.mockResolvedValue([
                { address: "9.9.9.9", family: 4 },
                { address: "127.0.0.1", family: 4 },
            ]);
            httpsGet.mockImplementation(
                (
                    _url: URL,
                    _options: RequestOptions,
                    respond: (response: IncomingMessage) => void,
                ) => ({
                    once: () => {
                        respond(
                            Object.assign(Readable.from([]), {
                                statusCode: 302,
                                headers: { location: `http://cdn.example:${stub.port}/file` },
                            }) as IncomingMessage,
                        );
                    },
                }),
            );
            await expect(downloadPublicUrl("https://9.9.9.9/start", dest)).rejects.toThrow(
                "公网下载策略拒绝",
            );
            expect(lookup).toHaveBeenCalledExactlyOnceWith("cdn.example", { all: true });
            expect(handler).not.toHaveBeenCalled();
            expect(await readdir(directory)).toEqual([]);
        } finally {
            await stub.close();
        }
    });

    it("DNS 超时结束请求且清理目标目录", async () => {
        const { promise, resolve } = Promise.withResolvers<[{ address: string; family: number }]>();
        lookup.mockReturnValue(promise);
        const timeoutMs = 20;
        await expect(
            downloadPublicUrl("http://media.example/file", dest, { timeoutMs }),
        ).rejects.toThrow("下载超时");
        resolve([{ address: "127.0.0.1", family: 4 }]);
        expect(await readdir(directory)).toEqual([]);
    });
});
