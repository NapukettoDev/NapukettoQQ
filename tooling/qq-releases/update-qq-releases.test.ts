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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        schema: 2,
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
            schema: 2,
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

    it("清单结构不合法（schema 非 2）→ 抛错退出 1，不写清单", async () => {
        manifestContent = JSON.stringify({ schema: 3, known: [] });
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
        expect(saved.schema).toBe(2);
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
            schema: 2,
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

// —— Linux（deb）条目自动维护（2026-11-10）——

/** 官方 linuxConfig.js 的 deb URL（含大写 QQNTV2 段，验证下载归一化）。 */
const LINUX_X64_DEB =
    "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_amd64_01.deb";
const LINUX_ARM_DEB =
    "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_arm64_01.deb";

/** linuxConfig.js 夹具（脚本只解析 `var params = {...};` 载荷）。 */
function linuxConfig(x64Deb = LINUX_X64_DEB, armDeb = LINUX_ARM_DEB, version = "3.2.35"): string {
    const params = JSON.stringify({
        version,
        x64DownloadUrl: { deb: x64Deb, rpm: "https://x/x.rpm" },
        armDownloadUrl: { deb: armDeb },
        updateDate: "2026-11-03",
    });
    // 夹具刻意只保留 `var params = {…};` 这一行、不包 IIFE 函数体：
    // CodeQL 的 code-construction 规则会把「从参数拼出函数体字符串」当可疑的代码生成
    // （这里只是测试夹具文本，脚本只做正则 + JSON.parse）。
    return `var params = ${params};`;
}

/** 清单夹具：Windows 一条（url 可设成官方 URL 触发 no-op）+ Linux x64/arm64 两条旧条目。 */
function fixtureManifestWithLinux(x64Url: string, armUrl: string): string {
    return JSON.stringify({
        schema: 2,
        known: [
            {
                version: "9.99.91-777777",
                url: OFFICIAL_URL,
                sha256: "bb".repeat(32),
                appid: 42,
                source: "official",
                buildDate: "2026-02-02",
            },
            {
                version: "3.2.35-54395",
                platform: "linux",
                arch: "x64",
                coreVersion: "9.9.37",
                url: x64Url,
                sha256: "cc".repeat(32),
                appid: 537403759,
                source: "official",
                buildDate: "2026-11-03",
            },
            {
                version: "3.2.35-54395",
                platform: "linux",
                arch: "arm64",
                coreVersion: "9.9.36",
                url: armUrl,
                sha256: "dd".repeat(32),
                appid: 0,
                source: "official",
                buildDate: "2026-10-01",
            },
        ],
    });
}

/** 7z 桩：Linux 三层解包后只留 data.tar(.xz) 与 resources/app/package.json。 */
function stubLinuxSevenZip(version = "3.2.35-54395"): void {
    mocks.execFile.mockImplementation(((
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, stdout: string) => void,
    ) => {
        const [op = "", source = ""] = args;
        const outDir = String(args[args.length - 2] ?? "").replace(/^-o/, "");
        mkdirSync(outDir, { recursive: true });
        if (op === "x" && source.endsWith(".deb")) {
            writeFileSync(join(outDir, "data.tar.xz"), "");
            cb(null, "");
            return;
        }
        if (op === "x") {
            writeFileSync(join(outDir, "data.tar"), "");
            cb(null, "");
            return;
        }
        writeFileSync(join(outDir, "package.json"), JSON.stringify({ name: "QQ", version }));
        cb(null, "");
    }) as never);
}

describe("Linux（deb）条目自动维护", () => {
    /** 跑一次「Windows no-op + Linux 有新版」的更新，返回落盘清单（Linux 侧断言共用）。 */
    async function runLinuxUpdate(): Promise<{
        known: Array<{
            version: string;
            platform?: string;
            arch?: string;
            coreVersion?: string;
            url: string;
            sha256: string;
            appid: number;
        }>;
    }> {
        manifestContent = fixtureManifestWithLinux(
            "https://old.example/qq-x64.deb",
            "https://old.example/qq-arm64.deb",
        );
        // fetch 路由：Windows rainbow 配置 + Linux linuxConfig（按 URL 分流）
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) =>
                Promise.resolve(
                    new Response(
                        String(url).includes("linuxConfig")
                            ? linuxConfig()
                            : rainbowConfig(OFFICIAL_URL),
                        { status: 200 },
                    ),
                ),
            ),
        );
        stubLinuxSevenZip();
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
        return JSON.parse(writtenManifests[0] as string) as {
            known: Array<{
                version: string;
                platform?: string;
                arch?: string;
                coreVersion?: string;
                url: string;
                sha256: string;
                appid: number;
            }>;
        };
    }

    it("x64 deb URL 变化 → 下载 + 从 deb 取版本 → 写入 platform/arch/coreVersion（appid 沿用）", async () => {
        const saved = await runLinuxUpdate();
        const x64Entry = saved.known.find(
            (entry) => entry.platform === "linux" && entry.arch === "x64",
        );
        expect(x64Entry).toBeDefined();
        expect(x64Entry?.version).toBe("3.2.35-54395"); // 版本取自 deb 内 package.json
        expect(x64Entry?.coreVersion).toBe("9.9.37"); // 核心版本取自 URL 段
        expect(x64Entry?.url).toBe(LINUX_X64_DEB); // 清单存官方原样 URL（大写 QQNTV2）
        expect(x64Entry?.sha256).toBe(expectedSha256(installerBuf));
        expect(x64Entry?.appid).toBe(537403759); // 沿用已有非零 appid
    });

    it("arm64 不自动维护（真机验证前）：原条目不动、只下一个 deb、Windows 仍在最前", async () => {
        const saved = await runLinuxUpdate();
        const armEntry = saved.known.find(
            (entry) => entry.platform === "linux" && entry.arch === "arm64",
        );
        expect(armEntry?.url).toBe("https://old.example/qq-arm64.deb");
        expect(armEntry?.coreVersion).toBe("9.9.36");
        expect(armEntry?.sha256).toBe("dd".repeat(32));
        // 平台分段排序：Windows 段在前，Linux 段在后且 x64 在 arm64 前
        expect(saved.known[0]?.version).toBe("9.99.91-777777");
        expect(
            saved.known.filter((entry) => entry.platform === "linux").map((entry) => entry.arch),
        ).toEqual(["x64", "arm64"]);
        // 只下载了 x64 一个 deb，且请求走小写路径段
        const requestedUrls = mocks.httpsGet.mock.calls.map((call) => String(call[0]));
        expect(requestedUrls).toHaveLength(1);
        expect(requestedUrls[0]).toContain("/qqntv2/");
    });

    it("Linux 配置不可用（HTTP 404）→ 只更新 Windows、不抛错、不写 Linux 条目", async () => {
        manifestContent = fixtureManifest("https://old.example/qq.exe");
        stubConfigFetch([{ status: 200, body: rainbowConfig(OFFICIAL_URL) }, { status: 404 }]);
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
        await untilExit();
        expect(process.exitCode).toBe(0);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ platform?: string }>;
        };
        expect(saved.known.some((entry) => entry.platform === "linux")).toBe(false);
    });

    it("Linux 两个架构 URL 都未变 → 完全不下载、不写清单", async () => {
        manifestContent = fixtureManifestWithLinux(LINUX_X64_DEB, LINUX_ARM_DEB);
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
            { status: 200, body: linuxConfig() },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(0);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
    });

    it("清单保留历史版本时，跳过判定看最新那条（否则每次 cron 都重下 190MB）", async () => {
        // 两条 x64 记录：旧版（3.2.34，过期 URL）+ 最新版（3.2.35，等于官方 URL）
        manifestContent = JSON.stringify({
            schema: 2,
            known: [
                {
                    version: "9.99.91-777777",
                    url: OFFICIAL_URL,
                    sha256: "bb".repeat(32),
                    appid: 42,
                    source: "official",
                    buildDate: "2026-02-02",
                },
                {
                    version: "3.2.34-54000",
                    platform: "linux",
                    arch: "x64",
                    coreVersion: "9.9.36",
                    url: "https://old.example/qq-amd64.deb",
                    sha256: "cc".repeat(32),
                    appid: 537403759,
                    source: "official",
                    buildDate: "2026-10-01",
                },
                {
                    version: "3.2.35-54395",
                    platform: "linux",
                    arch: "x64",
                    coreVersion: "9.9.37",
                    url: LINUX_X64_DEB,
                    sha256: "dd".repeat(32),
                    appid: 537403759,
                    source: "official",
                    buildDate: "2026-11-03",
                },
            ],
        });
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
            { status: 200, body: linuxConfig() },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(0);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        expect(
            logSpy.mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("Linux x64 已是最新（3.2.35-54395）"),
            ),
        ).toBe(true);
    });

    it("--dry-run 且 Linux 有新版 → 只打印计划，不下载、不写清单", async () => {
        manifestContent = fixtureManifestWithLinux("https://old.example/qq-x64.deb", LINUX_ARM_DEB);
        process.argv = ["node", MODULE_PATH, "--dry-run"];
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
            { status: 200, body: linuxConfig() },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(0);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        expect(
            logSpy.mock.calls.some((call: unknown[]) =>
                String(call[0]).includes("将更新 Linux x64 条目"),
            ),
        ).toBe(true);
    });

    // —— Linux 失败路径（只 warn、不写清单、退出码仍 0）——

    /** 7z 行为签名（测试按需造出解包产物或注入错误）。 */
    type SevenZipBehavior = (ctx: {
        op: string;
        source: string;
        outDir: string;
    }) => Error | undefined;

    /** 跑一次「x64 有新版」的更新，7z 行为可定制（Windows 侧 no-op 不落盘）。 */
    async function runLinuxUpdateWithSevenZip(behavior: SevenZipBehavior): Promise<void> {
        manifestContent = fixtureManifestWithLinux(
            "https://old.example/qq-x64.deb",
            "https://old.example/qq-arm64.deb",
        );
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) =>
                Promise.resolve(
                    new Response(
                        String(url).includes("linuxConfig")
                            ? linuxConfig()
                            : rainbowConfig(OFFICIAL_URL),
                        { status: 200 },
                    ),
                ),
            ),
        );
        mocks.execFile.mockImplementation(((
            _cmd: string,
            args: string[],
            _opts: unknown,
            cb: (err: Error | null, stdout?: string, stderr?: string) => void,
        ) => {
            const [op = "", source = ""] = args;
            const outDir = String(args[args.length - 2] ?? "").replace(/^-o/, "");
            const err = behavior({ op, source, outDir });
            cb(err ?? null, "", "");
        }) as never);
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await untilExit();
    }

    /** stderr 里是否出现某段提示。 */
    function warned(fragment: string): boolean {
        return stderrSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(fragment));
    }

    it("7z 不存在（ENOENT）→ warn「未找到 7-Zip」，不写清单、退出码 0", async () => {
        await runLinuxUpdateWithSevenZip(() => {
            const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            return err;
        });
        expect(process.exitCode).toBe(0);
        expect(warned("未找到 7-Zip")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("7z 其他失败 → warn「7z 执行失败」，不写清单", async () => {
        await runLinuxUpdateWithSevenZip(() => new Error("corrupt archive"));
        expect(process.exitCode).toBe(0);
        expect(warned("7z 执行失败")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("deb 内没有 data.tar(.xz) → warn 并跳过该架构", async () => {
        await runLinuxUpdateWithSevenZip(() => undefined);
        expect(warned("deb 内未找到 data.tar(.xz)")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("data.tar.xz 解包后没有 data.tar → warn 并跳过", async () => {
        await runLinuxUpdateWithSevenZip(({ op, source, outDir }) => {
            mkdirSync(outDir, { recursive: true });
            if (op === "x" && source.endsWith(".deb")) {
                writeFileSync(join(outDir, "data.tar.xz"), "");
            }
            return undefined;
        });
        expect(warned("deb 载荷内未找到 data.tar")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("deb 内找不到 resources/app/package.json → warn 并跳过", async () => {
        await runLinuxUpdateWithSevenZip(({ op, source, outDir }) => {
            mkdirSync(outDir, { recursive: true });
            if (op === "x" && source.endsWith(".deb")) {
                writeFileSync(join(outDir, "data.tar.xz"), "");
            } else if (op === "x") {
                writeFileSync(join(outDir, "data.tar"), "");
            }
            return undefined;
        });
        expect(warned("deb 内未找到")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("package.json 非法 JSON → warn 解析失败并跳过", async () => {
        await runLinuxUpdateWithSevenZip(({ op, source, outDir }) => {
            mkdirSync(outDir, { recursive: true });
            if (op === "x" && source.endsWith(".deb")) {
                writeFileSync(join(outDir, "data.tar.xz"), "");
            } else if (op === "x") {
                writeFileSync(join(outDir, "data.tar"), "");
            } else {
                writeFileSync(join(outDir, "package.json"), "not-json");
            }
            return undefined;
        });
        expect(warned("package.json 解析失败")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("package.json 不是对象（JSON null）→ warn 无法解析版本并跳过", async () => {
        await runLinuxUpdateWithSevenZip(({ op, source, outDir }) => {
            mkdirSync(outDir, { recursive: true });
            if (op === "x" && source.endsWith(".deb")) {
                writeFileSync(join(outDir, "data.tar.xz"), "");
            } else if (op === "x") {
                writeFileSync(join(outDir, "data.tar"), "");
            } else {
                writeFileSync(join(outDir, "package.json"), "null");
            }
            return undefined;
        });
        expect(warned("无法从 deb 解析客户端版本")).toBe(true);
        expect(writtenManifests).toHaveLength(0);
    });

    it("deb URL 缺核心版本段 → warn 并跳过（不下载）", async () => {
        manifestContent = fixtureManifestWithLinux(
            "https://old.example/qq-x64.deb",
            "https://old.example/qq-arm64.deb",
        );
        const noCoreUrl = "https://qqdl.gtimg.cn/qqfile/QQNTV2/release/QQ_amd64.deb";
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
            { status: 200, body: linuxConfig(noCoreUrl) },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(warned("无法解析 QQNT 核心版本")).toBe(true);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        expect(writtenManifests).toHaveLength(0);
    });

    it.each([
        ["JSON 载荷非法", `var params = {oops};`],
        [
            "营销版本不是三段数字",
            `var params = ${JSON.stringify({
                version: "3.2",
                x64DownloadUrl: { deb: LINUX_X64_DEB },
                armDownloadUrl: { deb: LINUX_ARM_DEB },
                updateDate: "2026-11-03",
            })};`,
        ],
        [
            "deb 字段不是对象",
            `var params = ${JSON.stringify({
                version: "3.2.35",
                x64DownloadUrl: "https://x/x.deb",
                armDownloadUrl: { deb: LINUX_ARM_DEB },
                updateDate: "2026-11-03",
            })};`,
        ],
    ])("linuxConfig 结构不符（%s）→ warn 并跳过 Linux，不下载不写清单", async (_label, body) => {
        manifestContent = fixtureManifestWithLinux(
            "https://old.example/qq-x64.deb",
            "https://old.example/qq-arm64.deb",
        );
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
            { status: 200, body: body as string },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(warned("Linux 官方配置结构不符")).toBe(true);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        expect(writtenManifests).toHaveLength(0);
    });

    // —— 旧版配置（CDN 边缘缓存滞后）与 Linux 失败隔离（issue #100）——

    it("官方配置回退旧版（3.2.33 < 清单 3.2.35）→ 防降级跳过，不下载不写清单", async () => {
        manifestContent = fixtureManifestWithLinux(
            "https://old.example/qq-x64.deb",
            "https://old.example/qq-arm64.deb",
        );
        // 2026-11-11 真实失败的 URL：旧 deb 早已下架（请求 404），正是靠版本判定挡住它
        const staleDeb =
            "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.35/release/1763096b/QQ_3.2.33_260902_amd64_01.deb";
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) }, // Windows URL 未变 → no-op
            { status: 200, body: linuxConfig(staleDeb, LINUX_ARM_DEB, "3.2.33") },
        ]);
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(mocks.httpsGet).not.toHaveBeenCalled();
        expect(writtenManifests).toEqual([]);
        expect(
            logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("防降级")),
        ).toBe(true);
    });

    it("Linux deb 下载失败（非 200 重试穷尽）→ 只 warn 跳过该架构，Windows 侧更新照常落盘", async () => {
        vi.useFakeTimers();
        try {
            manifestContent = JSON.stringify({
                schema: 2,
                known: [
                    {
                        version: "9.99.90-100000",
                        url: "https://old.example/qq.exe",
                        sha256: "aa".repeat(32),
                        appid: 42,
                        source: "official",
                    },
                    {
                        version: "3.2.35-54395",
                        platform: "linux",
                        arch: "x64",
                        coreVersion: "9.9.37",
                        url: "https://old.example/qq-x64.deb",
                        sha256: "cc".repeat(32),
                        appid: 537403759,
                        source: "official",
                        buildDate: "2026-11-03",
                    },
                ],
            });
            stubConfigFetch([
                { status: 200, body: rainbowConfig(OFFICIAL_URL) }, // Windows 有新版本要落盘
                { status: 200, body: linuxConfig() },
            ]);
            mocks.execFile.mockImplementation(((
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: null, stdout: string) => void,
            ) => {
                cb(null, "Files\\versions\\9.99.91-777777\\x.node");
            }) as never);
            // 第 1 次给 Windows 安装包；Linux deb 连续 3 次非 200（与 404 同路径：重试穷尽后抛错）
            downloadBehaviors = ["ok", "http403", "http403", "http403"];
            await import("./update-qq-releases.ts");
            await pumpRealIo();
            await vi.runAllTimersAsync();
            await pumpRealIo();
            // Linux 不再是致命失败：退出码 0、不开追踪 issue
            expect(process.exitCode).toBe(0);
            expect(writtenManifests).toHaveLength(1);
            const saved = JSON.parse(writtenManifests[0] as string) as {
                known: Array<{ version: string; platform?: string; url: string }>;
            };
            // Windows 侧更新没有被 Linux 的失败拖掉
            expect(saved.known.some((entry) => entry.version === "9.99.91-777777")).toBe(true);
            // Linux 条目保持原样（旧 URL / 旧 sha256 不被半成品污染）
            expect(saved.known.find((entry) => entry.platform === "linux")?.url).toBe(
                "https://old.example/qq-x64.deb",
            );
            expect(warned("跳过该架构")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("清单还没有 Linux 条目（首次登记）→ 下载并追加 platform=linux 条目", async () => {
        manifestContent = fixtureManifest(OFFICIAL_URL); // 只有 Windows 条目，且已是最新
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) },
            { status: 200, body: linuxConfig() },
        ]);
        stubLinuxSevenZip();
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{
                version: string;
                platform?: string;
                arch?: string;
                coreVersion?: string;
                appid: number;
            }>;
        };
        const linuxEntry = saved.known.find((entry) => entry.platform === "linux");
        expect(linuxEntry?.version).toBe("3.2.35-54395"); // 版本取自 deb 内 package.json
        expect(linuxEntry?.arch).toBe("x64");
        expect(linuxEntry?.coreVersion).toBe("9.9.37");
        expect(linuxEntry?.appid).toBe(0); // 无既有条目 → appid 记 0，运行时从 major.node 重解析
        expect(mocks.httpsGet).toHaveBeenCalledTimes(1); // Windows no-op，只下载 deb
    });

    it("Linux 步骤漏网异常（多层隔离之外的 bug）→ 只 warn，Windows 侧更新仍落盘", async () => {
        manifestContent = JSON.stringify({
            schema: 2,
            known: [
                {
                    version: "9.99.90-100000",
                    url: "https://old.example/qq.exe",
                    sha256: "aa".repeat(32),
                    appid: 42,
                    source: "official",
                },
            ],
        });
        stubConfigFetch([
            { status: 200, body: rainbowConfig(OFFICIAL_URL) }, // Windows 有新版本要落盘
            { status: 200, body: linuxConfig() },
        ]);
        mocks.execFile.mockImplementation(((
            _cmd: string,
            _args: string[],
            _opts: unknown,
            cb: (err: null, stdout: string) => void,
        ) => {
            cb(null, "Files\\versions\\9.99.91-777777\\x.node");
        }) as never);
        // 注入点：Linux 侧第一条 info 抛错，模拟 updateLinuxStep 内部未被单架构隔离覆盖的
        // 意外异常（正常路径下单架构失败已被 safeLinuxEntry 挡住，这是 main 的最后一层兜底）
        logSpy.mockImplementation((...args: unknown[]) => {
            if (String(args[0]).includes("Linux 官方最新")) {
                throw new Error("injected-linux-failure");
            }
        });
        downloadBehaviors = ["ok"];
        await import("./update-qq-releases.ts");
        await untilExit();
        expect(process.exitCode).toBe(0);
        expect(writtenManifests).toHaveLength(1);
        const saved = JSON.parse(writtenManifests[0] as string) as {
            known: Array<{ version: string }>;
        };
        expect(saved.known.some((entry) => entry.version === "9.99.91-777777")).toBe(true);
        expect(warned("Linux 更新异常")).toBe(true);
        expect(warned("injected-linux-failure")).toBe(true);
    });
});
