import type { LookupAddress } from "node:dns";
import { readdir, readFile, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestListener, RequestOptions } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadPublicUrl } from "../src/downloader.js";
import { MediaError } from "../src/types.js";
import { cleanupTempDir, type HttpStub, listenHttp, makeTempDir } from "./test-support.js";

type HttpGet = (
    url: URL,
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const { lookup, request } = vi.hoisted(() => ({
    lookup: vi.fn<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>(),
    request: vi.fn<HttpGet>(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:http", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:http")>()),
    get: request,
}));
vi.mock("node:https", () => ({
    get() {
        throw new Error("This fixture serves loopback HTTP only");
    },
}));

const publicAddresses: LookupAddress[] = [
    { address: "9.9.9.9", family: 4 },
    { address: "2606:4700::1111", family: 6 },
];

describe("downloadPublicUrl", () => {
    let directory: string;
    let dest: string;
    let server: HttpStub | undefined;
    let responses: IncomingMessage[];
    let acceptedAddresses: (string | LookupAddress[])[];

    beforeEach(() => {
        directory = makeTempDir("nk-public-download-");
        dest = join(directory, "media.bin");
        responses = [];
        acceptedAddresses = [];
        lookup.mockReset();
        request.mockReset();
    });

    afterEach(async () => {
        await server?.close();
        server = undefined;
        cleanupTempDir(directory);
    });

    async function serve(handler: RequestListener): Promise<string> {
        const { get } = await vi.importActual<typeof import("node:http")>("node:http");
        server = await listenHttp(handler);
        const { port } = server;
        request.mockImplementation((url, options, onResponse) => {
            const validateLookup = options.lookup;
            if (url.hostname !== "media.example" || url.port !== String(port) || !validateLookup) {
                throw new Error("HTTP request escaped the fixture");
            }
            return get(
                url,
                {
                    ...options,
                    lookup(hostname, lookupOptions, callback) {
                        validateLookup(hostname, lookupOptions, (error, addresses, family) => {
                            if (error) {
                                callback(error, addresses, family);
                                return;
                            }
                            // DNS 校验成功后才将测试连接转到回环地址。
                            acceptedAddresses.push(addresses);
                            if (lookupOptions.all) {
                                callback(null, [{ address: "127.0.0.1", family: 4 }]);
                            } else {
                                callback(null, "127.0.0.1", 4);
                            }
                        });
                    },
                },
                (response) => {
                    responses.push(response);
                    onResponse(response);
                },
            );
        });
        return `http://media.example:${port}/media`;
    }

    it.each([undefined, "Identity"])("公网 DNS 结果允许写入响应，编码为 %s", async (encoding) => {
        lookup.mockResolvedValue(publicAddresses);
        const payload = Buffer.from([0, 2, 128, 255]);
        const seenEncoding: (string | undefined)[] = [];
        const url = await serve((req, res) => {
            seenEncoding.push(req.headers["accept-encoding"]);
            if (encoding !== undefined) res.setHeader("content-encoding", encoding);
            res.end(payload);
        });

        await expect(
            downloadPublicUrl(url, dest, { headers: { "Accept-Encoding": "gzip" } }),
        ).resolves.toBe(payload.length);
        expect(lookup).toHaveBeenCalledExactlyOnceWith("media.example", { all: true });
        expect(acceptedAddresses).toEqual([publicAddresses]);
        expect(seenEncoding).toEqual(["identity"]);
        expect(await readFile(dest)).toEqual(payload);
        expect(await readdir(directory)).toEqual(["media.bin"]);
    });

    it.each(["127.0.0.1", "10.0.0.1"])(
        "字面非公网地址 %s 不经 DNS 或连接直接拒绝",
        async (host) => {
            lookup.mockResolvedValue(publicAddresses);
            const paths: (string | undefined)[] = [];
            const url = new URL(
                await serve((req, res) => {
                    paths.push(req.url);
                    res.end("unexpected");
                }),
            );
            url.hostname = host;

            await expect(downloadPublicUrl(url.href, dest)).rejects.toThrow(
                new MediaError("公网下载策略拒绝目标地址"),
            );
            expect(lookup).not.toHaveBeenCalled();
            expect(request).not.toHaveBeenCalled();
            expect(paths).toEqual([]);
            expect(await readdir(directory)).toEqual([]);
        },
    );

    it("DNS 返回空列表时拒绝连接，不创建目标或临时文件", async () => {
        lookup.mockResolvedValue([]);
        const paths: (string | undefined)[] = [];
        const url = await serve((req, res) => {
            paths.push(req.url);
            res.end("unexpected");
        });

        await expect(downloadPublicUrl(url, dest)).rejects.toThrow(
            new MediaError("公网下载目标没有可用地址"),
        );
        expect(lookup).toHaveBeenCalledExactlyOnceWith("media.example", { all: true });
        expect(paths).toEqual([]);
        expect(await readdir(directory)).toEqual([]);
    });

    it("同主机跳转重新校验 DNS，公网首条不能掩盖后续映射私网地址", async () => {
        lookup
            .mockResolvedValueOnce(publicAddresses)
            .mockResolvedValueOnce([
                ...publicAddresses,
                { address: "::ffff:192.168.1.1", family: 6 },
            ]);
        const paths: (string | undefined)[] = [];
        const url = await serve((req, res) => {
            paths.push(req.url);
            if (req.url === "/media") res.writeHead(302, { location: "/target" });
            res.end("body");
        });

        await expect(downloadPublicUrl(url, dest)).rejects.toThrow(
            new MediaError("公网下载策略拒绝目标地址"),
        );
        expect(lookup.mock.calls).toEqual([
            ["media.example", { all: true }],
            ["media.example", { all: true }],
        ]);
        expect(paths).toEqual(["/media"]);
        expect(await readdir(directory)).toEqual([]);
    });

    it.each(["首次下载", "覆盖下载"])("拒绝 gzip 响应并清理文件（%s）", async (scenario) => {
        const overwrite = scenario === "覆盖下载";
        if (overwrite) await writeFile(dest, "previous");
        lookup.mockResolvedValue(publicAddresses);
        const url = await serve((_req, res) => {
            res.setHeader("content-encoding", "gzip");
            res.end(gzipSync("fixture media"));
        });

        await expect(downloadPublicUrl(url, dest)).rejects.toThrow(
            new MediaError("公网下载响应使用了不支持的内容编码"),
        );
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ destroyed: true, readableEnded: false });
        expect(await readdir(directory)).toEqual(overwrite ? ["media.bin"] : []);
        if (overwrite) expect(await readFile(dest, "utf8")).toBe("previous");
    });
});
