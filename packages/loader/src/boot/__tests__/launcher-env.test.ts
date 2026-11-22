/**
 * launcher-env.test.ts：launchSelfHost 环境注入单测（2026-10-25 渲染决策传播）。
 *
 * win32 标准 node 直路（resolveNodeExecutable 短路，不触发下载/探测）；
 * spawn 注入假实现拦截。覆盖：extraEnv 覆盖传播（NAPUKETTO_LOG_FORMAT /
 * COLORIZE / NAPUTO_DATA_ROOT）、cfgDir/kernel/config 注入、stub PATH 前置、
 * cwd 建目录、spawn 命令形态（本机 node 直跑 self-host 入口）。
 */
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, spawn: spawnMock };
});

import { applyPathEnv, buildLaunchEnv, ENV, type LaunchEnvInput } from "../launch-env.js";
import { type LaunchOptions, launchSelfHost } from "../launcher.js";

let tmp = "";

afterEach(() => {
    vi.restoreAllMocks();
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

describe("launchSelfHost 环境注入（win32 本机 node）", () => {
    it.skipIf(process.platform !== "win32")(
        "extraEnv / NAPUTO_* 注入 + stub PATH 前置 + cwd 建目录",
        async () => {
            tmp = mkdtempSync(join(tmpdir(), "napuketto-launcher-env-test-"));
            const selfHostEntry = join(tmp, "self-host.cjs");
            writeFileSync(selfHostEntry, "");
            const stubDir = join(tmp, "stub");
            mkdirSync(stubDir);
            writeFileSync(join(stubDir, "QQNT.dll"), "");
            const cwd = join(tmp, "data-root");
            spawnMock.mockImplementation(
                () => new EventEmitter() as unknown as ReturnType<typeof spawn>,
            );
            await launchSelfHost({
                qq: {
                    qqPath: "C:\\QQ",
                    installDir: "C:\\QQ",
                    version: "9.9.9",
                    wrapperPath: join(stubDir, "wrapper.node"),
                    source: "local" as const,
                },
                kernelEntry: join(tmp, "kernel.mjs"),
                cfgDir: join(tmp, "acct-10001"),
                configPath: join(tmp, "napuketto.toml"),
                selfHostEntry,
                stubDir,
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                extraEnv: {
                    NAPUKETTO_LOG_FORMAT: "json",
                    NAPUKETTO_LOG_COLORIZE: "0",
                    NAPUTO_DATA_ROOT: tmp,
                },
            });
            expect(spawnMock).toHaveBeenCalledOnce();
            const [command, args, opts] = spawnMock.mock.calls[0] as unknown as [
                string,
                string[],
                { env: Record<string, string>; cwd: string },
            ];
            expect(command).toBe(process.execPath);
            expect(args[0]).toBe(selfHostEntry);
            expect(opts.cwd).toBe(cwd);
            expect(existsSync(cwd)).toBe(true);
            const env = opts.env;
            expect(env["NAPUKETTO_LOG_FORMAT"]).toBe("json");
            expect(env["NAPUKETTO_LOG_COLORIZE"]).toBe("0");
            expect(env["NAPUTO_DATA_ROOT"]).toBe(tmp);
            expect(env["NAPUKETTO_CFG_DIR"]).toBe(join(tmp, "acct-10001"));
            expect(env["NAPUKETTO_CONFIG"]).toBe(join(tmp, "napuketto.toml"));
            expect((env["PATH"] ?? "").includes(stubDir)).toBe(true);
        },
    );

    it.skipIf(process.platform !== "win32")(
        "nativeMediaPatch 开关注入（issue #105：显式 true 清继承 killswitch / false 注入 / 缺省继承）",
        async () => {
            tmp = mkdtempSync(join(tmpdir(), "napuketto-launcher-patch-test-"));
            const selfHostEntry = join(tmp, "self-host.cjs");
            writeFileSync(selfHostEntry, "");
            const stubDir = join(tmp, "stub");
            mkdirSync(stubDir);
            writeFileSync(join(stubDir, "QQNT.dll"), "");
            const cfgDir = join(tmp, "acct-10001");
            spawnMock.mockImplementation(
                () => new EventEmitter() as unknown as ReturnType<typeof spawn>,
            );
            const base: LaunchOptions = {
                qq: {
                    qqPath: "C:\\QQ",
                    installDir: "C:\\QQ",
                    version: "9.9.9",
                    wrapperPath: join(stubDir, "wrapper.node"),
                    source: "local" as const,
                },
                kernelEntry: join(tmp, "kernel.mjs"),
                cfgDir,
                selfHostEntry,
                stubDir,
                stdio: ["ignore", "pipe", "pipe"],
            };
            const statusPath = join(cfgDir, "media-patch-status.json");

            const prevDisable = process.env["NAPUTO_DISABLE_MEDIA_PATCH"];
            process.env["NAPUTO_DISABLE_MEDIA_PATCH"] = "1";
            try {
                // 显式 true：清除继承的 killswitch，注入状态路径
                await launchSelfHost({ ...base, nativeMediaPatch: true });
                {
                    const [, , opts] = spawnMock.mock.calls.at(-1) as unknown as [
                        string,
                        string[],
                        { env: Record<string, string> },
                    ];
                    expect(opts.env["NAPUTO_DISABLE_MEDIA_PATCH"]).toBeUndefined();
                    expect(opts.env["NAPUTO_MEDIA_PATCH_STATUS"]).toBe(statusPath);
                }

                // 显式 false：注入 killswitch（覆盖继承值），状态路径保留（观测 disabled_by_env）
                spawnMock.mockClear();
                await launchSelfHost({ ...base, nativeMediaPatch: false });
                {
                    const [, , opts] = spawnMock.mock.calls.at(-1) as unknown as [
                        string,
                        string[],
                        { env: Record<string, string> },
                    ];
                    expect(opts.env["NAPUTO_DISABLE_MEDIA_PATCH"]).toBe("1");
                    expect(opts.env["NAPUTO_MEDIA_PATCH_STATUS"]).toBe(statusPath);
                }

                // 缺省：继承环境（killswitch 保留）+ 状态路径注入
                spawnMock.mockClear();
                await launchSelfHost({ ...base });
                {
                    const [, , opts] = spawnMock.mock.calls.at(-1) as unknown as [
                        string,
                        string[],
                        { env: Record<string, string> },
                    ];
                    expect(opts.env["NAPUTO_DISABLE_MEDIA_PATCH"]).toBe("1");
                    expect(opts.env["NAPUTO_MEDIA_PATCH_STATUS"]).toBe(statusPath);
                }
            } finally {
                if (prevDisable === undefined) {
                    delete process.env["NAPUTO_DISABLE_MEDIA_PATCH"];
                } else {
                    process.env["NAPUTO_DISABLE_MEDIA_PATCH"] = prevDisable;
                }
            }
        },
    );
});

/** 纯环境构造输入（不触文件系统；路径仅作字符串断言）。 */
function envInput(overrides: Partial<LaunchEnvInput> = {}): LaunchEnvInput {
    return {
        qq: {
            qqPath: "C:\\QQ\\QQ.exe",
            version: "9.9.9",
            wrapperPath: "C:\\QQ\\resources\\app\\wrapper.node",
        },
        kernelEntry: "C:\\app\\kernel.mjs",
        cfgDir: "C:\\data\\10001",
        selfHost: true,
        ...overrides,
    };
}

describe("buildLaunchEnv：缩小默认继承与优先级（H-06）", () => {
    // Windows 环境变量名大小写不固定（SystemRoot / Path 等），用索引赋值构造测试输入。
    const parentEnv: Record<string, string> = {};
    parentEnv["PATH"] = "C:\\Windows\\System32";
    parentEnv["SystemRoot"] = "C:\\Windows";
    parentEnv["TEMP"] = "C:\\Temp";
    parentEnv["HTTPS_PROXY"] = "http://proxy.example:8080";
    parentEnv["NO_PROXY"] = "localhost";
    parentEnv["NODE_EXTRA_CA_CERTS"] = "C:\\certs\\ca.pem";
    parentEnv["NAPKETTO_CONFIG_JSON"] = '{"accounts":[]}';
    parentEnv["NAPUKETTO_SANDBOX_ROOT"] = "C:\\sandbox";
    parentEnv["NAPUKETTO_LOG_LEVEL"] = "debug";
    parentEnv["NAPUKETTO_LOG_FORMAT"] = "json";
    parentEnv["NAPUTO_QUICK_UIN"] = "10001";
    parentEnv["NAPUTO_QR_ONLY"] = "1";
    parentEnv["NAPUTO_DIAG"] = "1";
    parentEnv["NAPUTO_DISABLE_MEDIA_PATCH"] = "1";
    // 以下必须被白名单挡掉
    parentEnv["SECRET_TOKEN"] = "fake-test-secret";
    parentEnv["NODE_OPTIONS"] = "--require=evil.js";
    parentEnv["LD_PRELOAD"] = "/evil.so";
    parentEnv["LD_LIBRARY_PATH"] = "/evil";
    parentEnv["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

    it("win32：只继承白名单 + 显式透传，清除旧标记并去重 PATH", () => {
        const env = buildLaunchEnv(envInput({ qrOnly: false }), "win32", parentEnv);
        // 白名单 / 透传
        expect(env["SystemRoot"]).toBe("C:\\Windows");
        expect(env["HTTPS_PROXY"]).toBe("http://proxy.example:8080");
        expect(env["NO_PROXY"]).toBe("localhost");
        expect(env["NODE_EXTRA_CA_CERTS"]).toBe("C:\\certs\\ca.pem");
        expect(env["NAPKETTO_CONFIG_JSON"]).toBe('{"accounts":[]}');
        expect(env["NAPUKETTO_SANDBOX_ROOT"]).toBe("C:\\sandbox");
        expect(env["NAPUKETTO_LOG_LEVEL"]).toBe("debug");
        expect(env["NAPUKETTO_LOG_FORMAT"]).toBe("json");
        // 旧控制标记规范化为新前缀（旧标记清除）
        expect(env["NAPUKETTO_QUICK_UIN"]).toBe("10001");
        expect(env["NAPUTO_QUICK_UIN"]).toBeUndefined();
        // 显式 qrOnly:false 删除父进程残留的一次性扫码标记
        expect(env[ENV.QR_ONLY]).toBeUndefined();
        expect(env["NAPUTO_QR_ONLY"]).toBeUndefined();
        expect(env[ENV.DIAG]).toBe("1");
        // 凭据 / 加载器注入面不进入子进程
        expect(env["SECRET_TOKEN"]).toBeUndefined();
        expect(env["NODE_OPTIONS"]).toBeUndefined();
        expect(env["LD_PRELOAD"]).toBeUndefined();
        expect(env["LD_LIBRARY_PATH"]).toBeUndefined();
        expect(env["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined();
        // PATH 只有一个键，且来自父进程
        expect(env["PATH"]).toBe("C:\\Windows\\System32");
        expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    });

    it("linux：不继承 LD_PRELOAD；代理/证书透传；显式字段覆盖 extraEnv 与控制标记", () => {
        const env = buildLaunchEnv(
            envInput({
                extraEnv: {
                    NAPUKETTO_LOG_LEVEL: "warn",
                    NAPUKETTO_QR_ONLY: "1",
                    NAPUKETTO_DIAG: "0",
                },
                log: { level: "error", format: "single-line", noBanner: true, colorize: false },
                qrOnly: false,
                diagnostics: true,
            }),
            "linux",
            {
                PATH: "/usr/bin",
                HOME: "/home/user",
                LD_PRELOAD: "/evil.so",
                LD_LIBRARY_PATH: "/evil",
                HTTP_PROXY: "http://proxy.example:3128",
                SSL_CERT_FILE: "/etc/ssl/custom.pem",
                NAPUTO_QUICK_UIN: "20002",
                NAPUTO_QR_ONLY: "1",
            },
        );
        expect(env["LD_PRELOAD"]).toBeUndefined();
        expect(env["LD_LIBRARY_PATH"]).toBeUndefined();
        expect(env["HTTP_PROXY"]).toBe("http://proxy.example:3128");
        expect(env["SSL_CERT_FILE"]).toBe("/etc/ssl/custom.pem");
        expect(env["NAPUKETTO_QUICK_UIN"]).toBe("20002");
        // 强类型 log 覆盖 extraEnv；typed qrOnly:false / diagnostics:true 覆盖 extraEnv
        expect(env["NAPUKETTO_LOG_LEVEL"]).toBe("error");
        expect(env["NAPUKETTO_LOG_FORMAT"]).toBe("single-line");
        expect(env["NAPUKETTO_NO_BANNER"]).toBe("1");
        expect(env["NAPUKETTO_LOG_COLORIZE"]).toBe("0");
        expect(env[ENV.QR_ONLY]).toBeUndefined();
        expect(env[ENV.DIAG]).toBe("1");
    });

    it("log 非法值显式拒绝（不静默降级）", () => {
        expect(() =>
            buildLaunchEnv(
                envInput({ log: { level: "verbose" as unknown as "debug" } }),
                "linux",
                {},
            ),
        ).toThrow("LaunchOptions.log.level 非法");
        expect(() =>
            buildLaunchEnv(envInput({ log: { format: "xml" as unknown as "json" } }), "linux", {}),
        ).toThrow("LaunchOptions.log.format 非法");
    });

    it("applyPathEnv：Windows 大小写不敏感 PATH 去重，stub/wrapper 目录前置", () => {
        const env: Record<string, string> = {};
        env["Path"] = "C:\\Windows";
        applyPathEnv(
            env,
            { stub: "C:\\stub", wrapperPath: "C:\\QQ\\resources\\app\\wrapper.node" },
            "win32",
        );
        expect(env["PATH"]).toBe("C:\\stub;C:\\QQ\\resources\\app;C:\\Windows");
        expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
        expect(env[ENV.STUB_DIR]).toBe("C:\\stub");
    });
});
