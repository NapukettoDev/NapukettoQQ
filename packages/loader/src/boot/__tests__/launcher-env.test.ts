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

import { launchSelfHost } from "../launcher.js";

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
            expect(env["NAPUTO_CFG_DIR"]).toBe(join(tmp, "acct-10001"));
            expect(env["NAPKETTO_CONFIG"]).toBe(join(tmp, "napuketto.toml"));
            expect((env["PATH"] ?? "").includes(stubDir)).toBe(true);
        },
    );
});
