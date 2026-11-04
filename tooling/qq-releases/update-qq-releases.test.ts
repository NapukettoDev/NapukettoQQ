/**
 * update-qq-releases.test.ts：qq-releases.json 自动维护脚本单测。
 *
 * 脚本无导出——main 由「直接执行」判定触发（process.argv[1] 指向本模块路径
 * 后动态 import）。node:https / global fetch / execFile（7z）/ 清单读写全部
 * mock 到边界：不访问外网、不写真实清单、不拉起 7z。覆盖：官方配置两源降级
 * 与结构不符、URL 未变 no-op、防降级跳过、dry-run、下载 sha256 流式计算、
 * Content-Length 完整性校验、5s/15s 重试与穷尽失败、7z 列归档解析 / 字节扫描
 * 回退、清单合并落盘（按版本递增、官方 URL 原样入库）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    httpsGet: vi.fn(),
    execFile: vi.fn(),
}));

vi.mock("node:https", () => ({ get: mocks.httpsGet }));

// 失败清理 rm 改为瞬时桩：真实 rm 走 libuv 线程池，时序不确定会破坏 fake-timers 重试节奏
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    // rm 换瞬时桩（失败清理路径）；真实 rm 走线程池，fake timers 下时序不确定
    return { ...actual, rm: vi.fn(async () => undefined) };
});

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, execFile: mocks.execFile };
});

// 清单读写分流：仅拦截脚本自己的 MANIFEST_PATH（<仓根>/packages/loader/qq-releases.json，
// 与被测模块同一解析方式），其余（安装包临时文件）走真实 fs——真实清单零读写
let manifestPath = "";
let manifestContent: string | undefined;
let writtenManifests: string[] = [];
/** 内存文件表（createWriteStream 桩写入；字节扫描经 readFileSync 桩读回）。 */
const memFiles = new Map<string, Buffer[]>();

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const real = actual as typeof import("node:fs");
    return {
        ...actual,
        // 安装包写入换内存流：真实文件写入走线程池，fake timers 下事件不轮转会卡住
        // stream finish（rm 已同样换桩）；写入内容记入 memFiles，hash 与字节扫描照常工作
        createWriteStream: vi.fn(((dest: unknown) => {
            const chunks: Buffer[] = [];
            memFiles.set(String(dest), chunks);
            const sink = new PassThrough();
            sink.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });
            return sink;
        }) as unknown as typeof real.createWriteStream),
        readFileSync: ((path: unknown, encoding?: unknown) => {
            if (String(path) === manifestPath && manifestContent !== undefined) {
                return manifestContent;
            }
            const chunks = memFiles.get(String(path));
            if (chunks !== undefined) {
                return Buffer.concat(chunks);
            }
            return real.readFileSync(
                path as Parameters<typeof real.readFileSync>[0],
                encoding as never,
            );
        }) as typeof real.readFileSync,
        writeFileSync: ((path: unknown, data: unknown, encoding?: unknown) => {
            if (String(path) === manifestPath) {
                writtenManifests.push(String(data));
                return;
            }
            return real.writeFileSync(path as string, data as never, encoding as never);
        }) as typeof real.writeFileSync,
    };
});

/** 被测模块文件路径（同时用作 argv[1] 触发直接执行判定）。 */
const MODULE_PATH = fileURLToPath(new URL("./update-qq-releases.ts", import.meta.url));

/** 官方 rainbow 配置夹具（URL 含 QQNTV2 大写段，验证下载归一化）。 */
function rainbowConfig(url: string): string {
    // rainbow 配置键为 Windows（官方结构），经计算键满足命名规范
    return JSON.stringify({
        ["Windows"]: { version: "9.99.91", updateDate: "2026-02-02", ntDownloadX64Url: url },
    });
}

const OFFICIAL_URL = "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.99.91/QQ_x64.exe";

/** 既有清单夹具（单条旧版本；url 覆写为官方 URL 以便 no-op 判定）。 */
function fixtureManifest(latestUrl: string): string {
    return JSON.stringify({
        schema: 1,
        known: [
            {
                version: "9.99.90-100000",
                url: latestUrl,
                sha256: "aa".repeat(32),
                appid: 42,
                source: "official",
                buildDate: "2026-01-01",
            },
        ],
    });
}

/** 安装包假字节（含 UTF-16LE 版本串，供字节扫描回退）。 */
function installerBytes(): Buffer {
    return Buffer.concat([
        Buffer.from("junk-header-"),
        Buffer.from("9.99.91.777777", "utf16le"),
        Buffer.from("-suffix"),
    ]);
}

/** 期望 sha256（与 downloadFile 的流式计算同口径）。 */
function expectedSha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
}

/** fetch mock：按 URL 分流（rainbow 配置源 / 其他一律 404）；reject 项模拟 fetch 本身异常。 */
function stubConfigFetch(
    responses: Array<{ status?: number; body?: string; reject?: unknown }>,
): void {
    let next = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(() => {
            const res = responses[Math.min(next, responses.length - 1)] ?? {
                status: 404,
                body: "",
            };
            next += 1;
            if (res.reject !== undefined) {
                return Promise.reject(res.reject);
            }
            return Promise.resolve(new Response(res.body ?? "", { status: res.status ?? 200 }));
        }),
    );
}

/**
 * 下载行为队列：每次 https get 消耗一个。
 * error = 连接失败；error-string = 非 Error 拒因；truncated = 少发字节；
 * redirect = 302 + location；http403 = 非 200；ok-no-length = 无 Content-Length。
 */
type DownloadBehavior =
    | "error"
    | "error-string"
    | "ok"
    | "truncated"
    | "redirect"
    | "http403"
    | "ok-no-length";
let downloadBehaviors: DownloadBehavior[];
let installerBuf: Buffer;

/** 装配 node:https.get 假实现（流式回放安装包字节；行为驱动数据化，避免分支膨胀）。 */
function stubHttpsGet(): void {
    mocks.httpsGet.mockImplementation(
        (
            _url: string,
            _options: unknown,
            callback: (
                res: PassThrough & { statusCode: number; headers: Record<string, string> },
            ) => void,
        ) => {
            const behavior = downloadBehaviors.shift() ?? "ok";
            const req = new PassThrough() as PassThrough & {
                setTimeout: (ms: number, cb: () => void) => unknown;
                destroy: (err?: Error) => unknown;
            };
            req.setTimeout = vi.fn();
            req.destroy = vi.fn((err?: Error) => {
                if (err !== undefined) {
                    req.emit("error", err);
                }
                return req;
            });
            queueMicrotask(() => {
                if (behavior === "error") {
                    req.emit("error", new Error("fake-connection-reset"));
                    return;
                }
                if (behavior === "error-string") {
                    req.emit("error", "plain-string-reason");
                    return;
                }
                // 各行为的响应三元组查表构造（无分支）
                const table: Record<
                    Exclude<DownloadBehavior, "error" | "error-string">,
                    { statusCode: number; headers: Record<string, string>; body: Buffer }
                > = {
                    ok: {
                        statusCode: 200,
                        headers: { "content-length": String(installerBuf.length) },
                        body: installerBuf,
                    },
                    truncated: {
                        statusCode: 200,
                        headers: { "content-length": String(installerBuf.length) },
                        body: installerBuf.subarray(0, 8),
                    },
                    redirect: {
                        statusCode: 302,
                        headers: { location: "https://cdn.example/redirected.exe" },
                        body: Buffer.alloc(0),
                    },
                    http403: { statusCode: 403, headers: {}, body: Buffer.alloc(0) },
                    "ok-no-length": { statusCode: 200, headers: {}, body: installerBuf },
                };
                const spec = table[behavior];
                const res = new PassThrough() as PassThrough & {
                    statusCode: number;
                    headers: Record<string, string>;
                };
                res.statusCode = spec.statusCode;
                res.headers = spec.headers;
                callback(res);
                res.write(spec.body);
                res.end();
            });
            return req;
        },
    );
}

// 模块加载期捕获的真实 setTimeout（vi.useFakeTimers 会替换全局；此前捕获即真实版本）
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/** 真实 macrotask 等待：fake timers 激活下让事件轮转，安装包落盘的线程池 I/O 得以完成。 */
async function pumpRealIo(): Promise<void> {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
}

/** 等待 main 收尾（exitCode 被设置）。 */
async function untilExit(): Promise<void> {
    await vi.waitFor(() => {
        expect(process.exitCode).toBeDefined();
    });
}

let originalArgv: string[];
let exitCodeBefore: number | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let tmp: string;

beforeEach(() => {
    vi.resetModules();
    tmp = mkdtempSync(join(tmpdir(), "nk-qqrel-test-"));
    // 与被测模块的 MANIFEST_PATH 同口径解析（REPO_ROOT/packages/loader/qq-releases.json），
    // 读写均被拦截 → 真实清单文件零触碰
    manifestPath = join(dirname(MODULE_PATH), "..", "..", "packages", "loader", "qq-releases.json");
    manifestContent = undefined;
    memFiles.clear();
    writtenManifests = [];
    downloadBehaviors = ["ok"];
    installerBuf = installerBytes();
    originalArgv = process.argv;
    exitCodeBefore = process.exitCode as number | undefined;
    process.exitCode = undefined;
    // argv[1] 指向模块自身 → 触发「直接执行」分支跑 main；slice(2) 作为 CLI 参数
    process.argv = ["node", MODULE_PATH];
    delete process.env["NAPUTO_7Z_PATH"];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined); // 静音输出
    stubHttpsGet();
});

afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = exitCodeBefore as number | undefined;
    stderrSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
    vi.useRealTimers();
});

describe("官方配置获取与解析", () => {
    it("两源全部失败 → 抛「官方下载配置解析失败」，不下载不写清单", async () => {
        manifestContent = fixtureManifest(OFFICIAL_URL);
        stubConfigFetch([
            { status: 500, body: "" },
            { status: 404, body: "" },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(1);
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("官方下载配置解析失败"));
        expect(writtenManifests).toEqual([]);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
    });

    it("主源结构不符 → 备源接管（降级链路）", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([
            {
                status: 200,
                // rainbow 配置键为 Windows（官方结构），经计算键满足命名规范
                body: JSON.stringify({ ["Windows"]: { version: "bad" } }),
            },
            { status: 200, body: rainbowConfig("https://backup.example/QQNTV2/new.exe") },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: Error | null) => void,
        ) => {
            cb(new Error("7z unavailable"));
        }) as never);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
    });

    it("版本回退（官方营销版本低于清单）→ 跳过防降级，exitCode 0", async () => {
        manifestContent = JSON.stringify({
            schema: 1,
            known: [
                {
                    version: "9.99.98-999999",
                    url: "https://old.example/qq.exe",
                    sha256: "bb".repeat(32),
                    appid: 7,
                    source: "official",
                },
            ],
        });
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toEqual([]);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        // 防降级提示走 info（console.log）
        expect(
            logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("防降级")),
        ).toBe(true);
    });
});

describe("清单比对与 dry-run", () => {
    it("URL 未变 → no-op（清单已是最新），不下载不写", async () => {
        manifestContent = fixtureManifest(OFFICIAL_URL);
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toEqual([]);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
    });

    it("--dry-run → 只打印计划（新版本条目），不下载、不写清单", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        process.argv = ["node", MODULE_PATH, "--dry-run"];
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        expect(writtenManifests).toEqual([]);
        const logs = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
        expect(logs).toContain("[dry-run]");
        expect(logs).toContain("9.99.91");
    });

    it("清单结构不合法（schema 非 1）→ 抛错退出 1，不写清单", async () => {
        manifestContent = JSON.stringify({ schema: 2, known: [] });
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(1);
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("结构不合法"));
        expect(writtenManifests).toEqual([]);
    });
});

describe("下载与版本解析、清单落盘", () => {
    it("全新版本：下载 sha256 → 7z 列归档解析版本目录 → 合并落盘（官方 URL 原样、递增排序）", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Date   Time   Attr   Name\n  Files\\versions\\9.99.91-777777\\wrapper.node");
        }) as never);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            schema: number;
            known: Array<{
                version: string;
                url: string;
                sha256: string;
                appid: number;
                source: string;
                buildDate?: string;
            }>;
        };
        expect(saved.schema).toBe(1);
        expect(saved.known.map((entry) => entry.version)).toEqual([
            "9.99.90-100000",
            "9.99.91-777777",
        ]);
        const added = saved.known[1];
        expect(added?.url).toBe(OFFICIAL_URL); // 清单存官方原样 URL（未归一化）
        expect(added?.sha256).toBe(expectedSha256(installerBuf));
        expect(added?.appid).toBe(0);
        expect(added?.source).toBe("official");
        expect(added?.buildDate).toBe("2026-02-02");
        // 实际请求使用归一化 URL（/QQNTV2/ → /qqntv2/）
        const requestedUrl = String(mocks.httpsGet.mock.calls[0]?.[0]);
        expect(requestedUrl).toContain("/qqntv2/");
        // 7z 以「l 安装包路径」调用
        expect(mocks.execFile.mock.calls[0]?.[1]).toEqual([
            "l",
            expect.stringContaining("installer"),
        ]);
    });

    it("7z 不可用 → 回退字节扫描（UTF-16LE 版本串）仍能解析版本并落盘", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: Error) => void,
        ) => {
            cb(new Error("7z missing"));
        }) as never);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ version: string }>;
        };
        expect(saved.known.at(-1)?.version).toBe("9.99.91-777777");
    });

    it("下载瞬态失败按 5s/15s 重试，第三次成功 → 正常落盘", async () => {
        vi.useFakeTimers();
        try {
            manifestContent = fixtureManifest("https://old.example/qq.exe");
            stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
            mocks.execFile.mockImplementation(((
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: null, stdout: string) => void,
            ) => {
                cb(null, "Files\\versions\\9.99.91-777777\\x.node");
            }) as never);
            downloadBehaviors = ["error", "error", "ok"];
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.runAllTimersAsync();
            await pumpRealIo();
            expect(process.exitCode).toBe(0);
            expect(writtenManifests).toHaveLength(1);
            // 三次下载尝试
            expect(mocks.httpsGet).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("下载重试穷尽（3 次均失败）→ exitCode 1 + ❌ 输出，不写清单", async () => {
        vi.useFakeTimers();
        try {
            manifestContent = fixtureManifest("https://old.example/qq.exe");
            stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
            downloadBehaviors = ["error", "error", "error"];
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.runAllTimersAsync();
            await pumpRealIo();
            expect(process.exitCode).toBe(1);
            expect(mocks.httpsGet).toHaveBeenCalledTimes(3);
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining("下载失败（重试 2 次后仍放弃）"),
            );
            expect(writtenManifests).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("Content-Length 与实际接收不一致（截断）→ 完整性校验失败，不写清单", async () => {
        vi.useFakeTimers();
        try {
            manifestContent = fixtureManifest("https://old.example/qq.exe");
            stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
            downloadBehaviors = ["truncated", "truncated", "truncated"];
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.advanceTimersByTimeAsync(5_000);
            await pumpRealIo();
            await vi.advanceTimersByTimeAsync(15_000);
            await pumpRealIo();
            await vi.advanceTimersByTimeAsync(0);
            await pumpRealIo();
            expect(process.exitCode).toBe(1);
            expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("下载不完整"));
            expect(writtenManifests).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("下载传输边角", () => {
    it("302 重定向跟随一次后 200 → 正常下载落盘", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["redirect", "ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
        // 首跳 302 + 重定向目标请求 = 两次 get
        expect(mocks.httpsGet).toHaveBeenCalledTimes(2);
    });

    it("重定向次数过多（单次尝试连跳 6 跳）→ 报错重试，第二次尝试成功落盘", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = [
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "redirect",
            "ok",
        ];
        vi.useFakeTimers();
        try {
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.runAllTimersAsync();
            await pumpRealIo();
            expect(process.exitCode).toBe(0);
            expect(writtenManifests).toHaveLength(1);
            expect(
                stderrSpy.mock.calls.some((call: unknown[]) =>
                    String(call[0]).includes("重定向次数过多"),
                ),
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("下载 403（穷尽 3 次）→ exitCode 1，不写清单", async () => {
        vi.useFakeTimers();
        try {
            manifestContent = fixtureManifest("https://old.example/qq.exe");
            stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
            downloadBehaviors = ["http403", "http403", "http403"];
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.runAllTimersAsync();
            await pumpRealIo();
            expect(process.exitCode).toBe(1);
            expect(mocks.httpsGet).toHaveBeenCalledTimes(3);
            expect(writtenManifests).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("无 Content-Length 头 → 完整性校验跳过，正常落盘", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["ok-no-length"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
    });

    it("req error 为非 Error（字符串拒因）→ warn 带出字符串，重试后成功", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["error-string", "error-string", "ok"];
        vi.useFakeTimers();
        try {
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.runAllTimersAsync();
            await pumpRealIo();
            expect(process.exitCode).toBe(0);
            expect(
                stderrSpy.mock.calls.some((call: unknown[]) =>
                    String(call[0]).includes("plain-string-reason"),
                ),
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("版本解析与清单合并边角", () => {
    it("NAPUTO_7Z_PATH 环境变量优先（指向存在文件）→ execFile 使用该路径", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        process.env["NAPUTO_7Z_PATH"] = MODULE_PATH; // 存在的文件即可（execFile 已 mock）
        try {
            downloadBehaviors = ["ok"];
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await pumpRealIo();
            expect(process.exitCode).toBe(0);
            expect(mocks.execFile.mock.calls[0]?.[0]).toBe(MODULE_PATH);
        } finally {
            delete process.env["NAPUTO_7Z_PATH"];
        }
    });

    it("7z ENOENT（可执行文件缺失）→ 提示未找到并回退字节扫描（ASCII 版本串）", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        const enoent = new Error("spawn 7z ENOENT");
        (enoent as NodeJS.ErrnoException).code = "ENOENT";
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: Error) => void,
        ) => {
            cb(enoent);
        }) as never);
        // 安装包仅含 ASCII 版本串：utf16le 候选全部落空，ASCII 候选命中
        installerBuf = Buffer.concat([
            Buffer.from("pad-"),
            Buffer.from("9.99.91.777777-rc"),
            Buffer.from("tail"),
        ]);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        expect(
            stderrSpy.mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("未找到 7-Zip"),
            ),
        ).toBe(true);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ version: string }>;
        };
        expect(saved.known.at(-1)?.version).toBe("9.99.91-777777");
    });

    it("7z 列表无匹配版本目录（旧版本前缀不符）→ 回退字节扫描成功", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\8.8.8-11111\\x.node");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ version: string }>;
        };
        expect(saved.known.at(-1)?.version).toBe("9.99.91-777777");
    });

    it("安装包无数字后缀（版本串残缺）→ 解析失败 exitCode 1，不写清单", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: Error) => void,
        ) => {
            cb(new Error("7z missing"));
        }) as never);
        // utf16le "9.99.91-" 后无数字 → scanEncoding 返回 null → 全候选落空
        installerBuf = Buffer.concat([Buffer.from("9.99.91-abc", "utf16le")]);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(1);
        expect(writtenManifests).toEqual([]);
        expect(stderrSpy).toHaveBeenCalledWith(
            expect.stringContaining("无法从安装包解析版本目录名"),
        );
    });

    it("同版本替换保留已有非零 appid；下载 URL 无 QQNTV2 段时不打印归一化日志", async () => {
        manifestContent = JSON.stringify({
            schema: 1,
            known: [
                {
                    version: "9.99.91-777777",
                    url: "https://old.example/qq.exe",
                    sha256: "cc".repeat(32),
                    appid: 42,
                    source: "official",
                },
            ],
        });
        stubConfigFetch([
            { status: 200, body: rainbowConfig("https://qqdl.gtimg.cn/qqfile/QQNT/x.exe") },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ version: string; appid: number; url: string }>;
        };
        expect(saved.known).toHaveLength(1);
        expect(saved.known[0]?.version).toBe("9.99.91-777777");
        expect(saved.known[0]?.appid).toBe(42); // 保留已有 appid
        expect(saved.known[0]?.url).toBe("https://qqdl.gtimg.cn/qqfile/QQNT/x.exe");
        // URL 无 /QQNTV2/ 段 → 归一化前后相同 → 不打印归一化日志
        expect(
            logSpy.mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("请求 URL 归一化"),
            ),
        ).toBe(false);
    });
});

describe("官方配置结构变体", () => {
    it("主源根非对象（数组）→ 备源成功（PC_CONFIG_URLS 共两源：坏源 + 好源）", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([
            { status: 200, body: JSON.stringify([1, 2]) },
            { status: 200, body: rainbowConfig("https://third.example/QQNTV2/x.exe") },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ url: string }>;
        };
        expect(saved.known.at(-1)?.url).toBe("https://third.example/QQNTV2/x.exe");
    });

    it("主源 Windows 段缺失 → 备源成功", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([
            {
                status: 200,
                // rainbow 配置键为 Windows（官方结构），经计算键满足命名规范
                body: JSON.stringify({ ["Windows"]: { updateDate: "2026-01-01" } }),
            },
            { status: 200, body: rainbowConfig("https://third.example/QQNTV2/x.exe") },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ url: string }>;
        };
        expect(saved.known.at(-1)?.url).toBe("https://third.example/QQNTV2/x.exe");
    });

    it("主源版本非三段数字 → 备源成功", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([
            {
                status: 200,
                body: JSON.stringify({
                    ["Windows"]: {
                        version: "bad",
                        updateDate: "2026-01-01",
                        ntDownloadX64Url: OFFICIAL_URL,
                    },
                }),
            },
            { status: 200, body: rainbowConfig("https://third.example/QQNTV2/x.exe") },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ url: string }>;
        };
        expect(saved.known.at(-1)?.url).toBe("https://third.example/QQNTV2/x.exe");
    });

    it("配置源 fetch 抛出非 Error（字符串）→ warn 带出字符串，下一源接管", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([
            { reject: "fetch-network-string" },
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await pumpRealIo();
        await pumpRealIo();
        expect(process.exitCode).toBe(0);
        expect(
            stderrSpy.mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("fetch-network-string"),
            ),
        ).toBe(true);
    });
});
