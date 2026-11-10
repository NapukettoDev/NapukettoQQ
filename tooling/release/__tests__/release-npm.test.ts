/**
 * release-npm.test.ts：npm 逐个发布 CLI（release-npm.ts）单测。
 *
 * 进程执行（spawnSync）与 registry fetch 全部 mock 到边界（绝不真发 npm）；
 * discoverPackages 换桩为临时目录夹具，core 的 planPublish/topoSort/
 * rewriteDependencyProtocols 保留真实实现（纯函数 + 临时目录文件）。覆盖：
 * parseArgs、fetchPublishedVersions（404 空集 / 版本集 / 非 200 抛错）、
 * publishPkg 参数装配（otp / dry-run / no-provenance / Windows ComSpec）、
 * main 全流程（全部已发布跳过、拓扑序发布、workspace:* / catalog: 改写后恢复、
 * 失败中断、OIDC 预检拦截与放行）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spawnSync: vi.fn(),
    discoverPackages: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, spawnSync: mocks.spawnSync };
});

vi.mock("../release-npm-core.ts", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, discoverPackages: mocks.discoverPackages };
});

import {
    fetchPublishedVersions,
    isOidcTrustedPublishing,
    main,
    parseArgs,
    publishedDespiteFailure,
    publishPkg,
} from "../release-npm.ts";

let tmp = "";
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

/** registry 版本查询的 mock 响应体（versions 表）。 */
function registryBody(versions: string[]): { versions: Record<string, unknown> } {
    return { versions: Object.fromEntries(versions.map((v) => [v, {}])) };
}

/** 按请求 URL 分流的 fetch mock：Actions id_token / OIDC 换 token / registry 查询。 */
function makeFetch(opts: {
    registryVersions: Record<string, string[]>;
    exchangeStatus: number;
    exchangeBody?: unknown;
    exchangeReject?: boolean;
}): ReturnType<typeof vi.fn> {
    return vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("token.actions")) {
            return Promise.resolve(new Response(JSON.stringify({ value: "the-id-token" })));
        }
        if (url.includes("/oidc/token/exchange/")) {
            if (opts.exchangeReject === true) {
                return Promise.reject(new Error("exchange-network-down"));
            }
            return Promise.resolve(
                new Response(JSON.stringify(opts.exchangeBody ?? { token: "probe-token" }), {
                    status: opts.exchangeStatus,
                }),
            );
        }
        const versions =
            opts.registryVersions[decodeURIComponent(url.split("/").pop() ?? "")] ?? [];
        return Promise.resolve(new Response(JSON.stringify(registryBody(versions))));
    });
}

/** 写临时工作区包（返回包信息）。 */
function makePkg(
    name: string,
    version: string,
    deps: Record<string, string> = {},
): { name: string; dir: string; version: string; dependencies: Record<string, string> } {
    const dir = join(tmp, name.replace("/", "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, version, dependencies: deps }, null, 4),
        "utf8",
    );
    return { name, dir, version, dependencies: deps };
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nk-release-npm-test-"));
    delete process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    delete process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    delete process.env["NAPKETTO_NPM_OTP"];
    // 失败复核的重试间隔归零（否则失败用例每个包要等 2s×2）
    vi.stubEnv("RELEASE_PUBLISH_CONFIRM_DELAY_MS", "0");
    for (const fn of [mocks.spawnSync, mocks.discoverPackages]) {
        fn.mockReset();
    }
    mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined); // 静音输出
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
});

describe("parseArgs", () => {
    it("--dry-run → dryRun = true；--otp= 提取验证码", () => {
        expect(parseArgs(["--dry-run", "--otp=123456"])).toEqual({ dryRun: true, otp: "123456" });
    });

    it("缺省 → dryRun = false，otp 取 NAPKETTO_NPM_OTP 环境变量", () => {
        process.env["NAPKETTO_NPM_OTP"] = "654321";
        expect(parseArgs([])).toEqual({ dryRun: false, otp: "654321" });
        delete process.env["NAPKETTO_NPM_OTP"];
        expect(parseArgs([])).toEqual({ dryRun: false, otp: undefined });
    });

    it("otp 参数优先于环境变量", () => {
        process.env["NAPKETTO_NPM_OTP"] = "654321";
        expect(parseArgs(["--otp=000000"]).otp).toBe("000000");
    });
});

describe("fetchPublishedVersions", () => {
    it("包从未发布（404）→ 空集合", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve(new Response("{}", { status: 404 }))),
        );
        const versions = await fetchPublishedVersions("@napuketto/kernel");
        expect(versions.size).toBe(0);
    });

    it("已发布 → 返回全部版本号集合；scoped 包名转义为 %2F", async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify({ versions: { "0.0.1": {}, "0.0.2": {} } })),
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const versions = await fetchPublishedVersions("@napuketto/cli");
        expect([...versions].sort()).toEqual(["0.0.1", "0.0.2"]);
        const url = String((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0]);
        expect(url).toContain("@napuketto%2Fcli");
    });

    it("其他非 200 → 抛错（发布链中断）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve(new Response("boom", { status: 502 }))),
        );
        await expect(fetchPublishedVersions("@napuketto/kernel")).rejects.toThrow(
            /registry 查询失败.*502/s,
        );
    });
});

describe("publishPkg", () => {
    it("本地模式（非 OIDC）：npm publish + access public + workspaces=false + no-provenance", () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "");
        const code = publishPkg({ name: "pkg", dir: tmp }, false, undefined);
        expect(code).toBe(0);
        const [cmd, cmdArgs] = mocks.spawnSync.mock.calls[0] as unknown as [
            string,
            string[],
            Record<string, unknown>,
        ];
        expect(mocks.spawnSync.mock.calls[0]?.[2]).toMatchObject({ cwd: tmp, stdio: "inherit" });
        const args = process.platform === "win32" ? (cmdArgs.slice(4) as string[]) : cmdArgs;
        expect(cmd).toBe(
            process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "npm",
        );
        expect(args).toContain("publish");
        expect(args).toContain("--access");
        expect(args).toContain("public");
        expect(args).toContain("--workspaces=false");
        expect(args).toContain("--no-provenance");
        expect(args).not.toContain("--otp");
        expect(args).not.toContain("--dry-run");
    });

    it("otp / dry-run 透传；OIDC 模式下不追加 --no-provenance", () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        publishPkg({ name: "pkg", dir: tmp }, true, "123456");
        const cmdArgs = mocks.spawnSync.mock.calls[0]?.[1] as string[];
        const args = process.platform === "win32" ? cmdArgs.slice(4) : cmdArgs;
        expect(args).toContain("--otp");
        expect(args).toContain("123456");
        expect(args).toContain("--dry-run");
        expect(args).not.toContain("--no-provenance");
    });

    it("spawn 启动失败（npm 不在 PATH）→ 返回 1 而非静默吞错", () => {
        mocks.spawnSync.mockReturnValue({ status: null, error: new Error("ENOENT") });
        expect(publishPkg({ name: "pkg", dir: tmp }, false, undefined)).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("无法启动 npm"));
    });

    it("status 为 null（信号终止）→ 兜底返回 1", () => {
        mocks.spawnSync.mockReturnValue({ status: null, error: undefined });
        expect(publishPkg({ name: "pkg", dir: tmp }, false, undefined)).toBe(1);
    });
});

describe("main 全流程", () => {
    it("未发现任何可发布包 → 0", async () => {
        mocks.discoverPackages.mockResolvedValue([]);
        vi.stubGlobal("fetch", makeFetch({ registryVersions: {}, exchangeStatus: 200 }));
        const code = await main([]);
        expect(code).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("未发现任何可发布包"));
        expect(mocks.spawnSync).not.toHaveBeenCalled();
    });

    it("全部版本已在 registry → 跳过并返回 0（不执行 npm publish）", async () => {
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        mocks.discoverPackages.mockResolvedValue([kernel]);
        vi.stubGlobal(
            "fetch",
            makeFetch({
                registryVersions: { "@napuketto/kernel": ["0.0.9"] },
                exchangeStatus: 200,
            }),
        );
        const code = await main([]);
        expect(code).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("无需发布"));
        expect(mocks.spawnSync).not.toHaveBeenCalled();
    });

    it("全新发布（registry 404）→ 拓扑序逐个 publish；workspace:* 发布前改写、发布后恢复", async () => {
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        const cli = makePkg("@napuketto/cli", "0.1.0", { "@napuketto/kernel": "workspace:*" });
        mocks.discoverPackages.mockResolvedValue([cli, kernel]);
        vi.stubGlobal("fetch", makeFetch({ registryVersions: {}, exchangeStatus: 200 }));
        const code = await main([]);
        expect(code).toBe(0);
        // 拓扑序：被依赖者 kernel 先发布
        const cwds = mocks.spawnSync.mock.calls.map((call) => (call[2] as { cwd: string }).cwd);
        expect(cwds).toEqual([kernel.dir, cli.dir]);
        // 改写已恢复：cli 的 package.json 回到 workspace:*
        const restored = JSON.parse(readFileSync(join(cli.dir, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(restored.dependencies["@napuketto/kernel"]).toBe("workspace:*");
        // 发布日志
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("已发布: @napuketto/kernel"));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("已恢复"));
    });

    it("catalog: 依赖发布前改写为真实范围、发布后恢复（2026-11-10 事故回归）", async () => {
        const network = makePkg("@napuketto/network", "0.3.1", {
            hono: "catalog:",
            ws: "catalog:",
        });
        mocks.discoverPackages.mockResolvedValue([network]);
        vi.stubGlobal("fetch", makeFetch({ registryVersions: {}, exchangeStatus: 200 }));
        // 捕获 publish 时刻磁盘上的 manifest（改写后、恢复前）
        let publishedManifest: { dependencies: Record<string, string> } | undefined;
        mocks.spawnSync.mockImplementation(() => {
            publishedManifest = JSON.parse(
                readFileSync(join(network.dir, "package.json"), "utf8"),
            ) as { dependencies: Record<string, string> };
            return { status: 0, error: undefined };
        });
        const code = await main([]);
        expect(code).toBe(0);
        // 发给 npm 的 manifest 不能有 catalog:（否则用户 npm install 直接失败）
        expect(publishedManifest?.dependencies["hono"]).toMatch(/^\^?\d+\.\d+\.\d+/);
        expect(publishedManifest?.dependencies["ws"]).toMatch(/^\^?\d+\.\d+\.\d+/);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("catalog: → hono@"));
        // 发布后恢复原样（git 里保持 catalog: 约定）
        const restored = JSON.parse(readFileSync(join(network.dir, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(restored.dependencies["hono"]).toBe("catalog:");
    });

    it("发布中途失败 → 立即中断返回非 0，后续包不再发布，恢复已在 finally 完成", async () => {
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        const cli = makePkg("@napuketto/cli", "0.1.0", { "@napuketto/kernel": "workspace:*" });
        mocks.discoverPackages.mockResolvedValue([cli, kernel]);
        vi.stubGlobal("fetch", makeFetch({ registryVersions: {}, exchangeStatus: 200 }));
        // 第一个包（kernel）发布失败
        mocks.spawnSync.mockReturnValue({ status: 1, error: undefined });
        const code = await main([]);
        expect(code).toBe(1);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("发布失败"));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("已中断"));
        // 未及发布的包保持原样（仍是 workspace:*）
        const untouched = JSON.parse(readFileSync(join(cli.dir, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(untouched.dependencies["@napuketto/kernel"]).toBe("workspace:*");
    });

    it("发布 409 但版本已在 registry → 按成功继续，后续包照发（2026-11-10 事故回归）", async () => {
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        const cli = makePkg("@napuketto/cli", "0.1.0", { "@napuketto/kernel": "workspace:*" });
        mocks.discoverPackages.mockResolvedValue([cli, kernel]);
        // registry：首次查询（planPublish）读不到 kernel@0.0.9（缓存滞后）；
        // 发布失败后的复核就能看到——真实事故形态（旧批刚发完，新批读旧 packument）
        const counts = new Map<string, number>();
        vi.stubGlobal(
            "fetch",
            vi.fn((input: unknown) => {
                const name = decodeURIComponent(
                    String(input).replace("https://registry.npmjs.org/", ""),
                );
                const seen = (counts.get(name) ?? 0) + 1;
                counts.set(name, seen);
                const versions = name === "@napuketto/kernel" && seen >= 2 ? { "0.0.9": {} } : {};
                return Promise.resolve(new Response(JSON.stringify({ versions }), { status: 200 }));
            }),
        );
        mocks.spawnSync
            .mockReturnValueOnce({ status: 1, error: undefined })
            .mockReturnValue({ status: 0, error: undefined });
        const code = await main([]);
        expect(code).toBe(0);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("按成功继续"));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("已发布: @napuketto/cli"));
    });

    it("OIDC 模式 + 已有包缺信任配置 → 预检拦截，一个包都不发", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        mocks.discoverPackages.mockResolvedValue([kernel]);
        const fetchMock = makeFetch({
            registryVersions: { "@napuketto/kernel": ["0.0.8"] },
            exchangeStatus: 404,
        });
        vi.stubGlobal("fetch", fetchMock);
        const code = await main([]);
        expect(code).toBe(1);
        expect(mocks.spawnSync).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("OIDC 信任配置"));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("一个包都不发"));
    });

    it("OIDC 预检探测本身失败（网络异常）→ 仅告警不拦截，继续发布", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        mocks.discoverPackages.mockResolvedValue([kernel]);
        vi.stubGlobal(
            "fetch",
            makeFetch({
                registryVersions: { "@napuketto/kernel": ["0.0.8"] },
                exchangeStatus: 200,
                exchangeReject: true,
            }),
        );
        const code = await main([]);
        expect(code).toBe(0);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        // 探测不确定只告警，不据此拦截
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("探测不确定"));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("预检通过"));
    });

    it("OIDC 预检通过（换到 token）→ 继续发布", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        mocks.discoverPackages.mockResolvedValue([kernel]);
        vi.stubGlobal(
            "fetch",
            makeFetch({
                registryVersions: { "@napuketto/kernel": ["0.0.8"] },
                exchangeStatus: 200,
            }),
        );
        const code = await main([]);
        expect(code).toBe(0);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("预检通过"));
    });

    it("dry-run → 跳过 OIDC 预检，仅打包检查（--dry-run 透传）", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        const kernel = makePkg("@napuketto/kernel", "0.0.9");
        mocks.discoverPackages.mockResolvedValue([kernel]);
        vi.stubGlobal("fetch", makeFetch({ registryVersions: {}, exchangeStatus: 200 }));
        const code = await main(["--dry-run"]);
        expect(code).toBe(0);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        const cmdArgs = mocks.spawnSync.mock.calls[0]?.[1] as string[];
        expect(cmdArgs).toContain("--dry-run");
    });
});

describe("publishedDespiteFailure（并发发布 / 缓存滞后幂等）", () => {
    it("registry 已有该版本 → true（立即命中，不重试）", async () => {
        const pkg = makePkg("@napuketto/loader", "0.7.4");
        const fetchVersions = vi.fn(async () => new Set(["0.7.4"]));
        await expect(publishedDespiteFailure(pkg, { fetchVersions, delayMs: 0 })).resolves.toBe(
            true,
        );
        expect(fetchVersions).toHaveBeenCalledTimes(1);
    });

    it("registry 一直没有 → false（用满 attempts 次）", async () => {
        const pkg = makePkg("@napuketto/loader", "0.7.4");
        const fetchVersions = vi.fn(async () => new Set<string>());
        await expect(
            publishedDespiteFailure(pkg, { fetchVersions, attempts: 2, delayMs: 0 }),
        ).resolves.toBe(false);
        expect(fetchVersions).toHaveBeenCalledTimes(2);
    });

    it("传播延迟：首次没有、重试命中 → true", async () => {
        const pkg = makePkg("@napuketto/loader", "0.7.4");
        const fetchVersions = vi
            .fn()
            .mockResolvedValueOnce(new Set<string>())
            .mockResolvedValueOnce(new Set(["0.7.4"]));
        await expect(
            publishedDespiteFailure(pkg, { fetchVersions, attempts: 3, delayMs: 0 }),
        ).resolves.toBe(true);
        expect(fetchVersions).toHaveBeenCalledTimes(2);
    });
});

describe("isOidcTrustedPublishing（补充 release-npm 侧默认入参）", () => {
    it("以 process.env 为默认入参（本地无 Actions 变量 → false）", () => {
        delete process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
        delete process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
        expect(isOidcTrustedPublishing()).toBe(false);
    });
});
