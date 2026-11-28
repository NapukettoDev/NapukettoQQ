import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { expect, it, vi } from "vitest";
import { openConfig, type StartOpener } from "../src/open-config.js";

it("保留 Windows 配置文件完整路径，并等待关联启动器结果", async () => {
    const temp = await mkdtemp(join(tmpdir(), "napuketto-create-"));
    const config = join(temp, "with space %PATH% !^&'()[测试]", "napuketto.toml");
    await mkdir(dirname(config));
    await writeFile(config, "fixture");
    const systemRoot = process.env["SystemRoot"] ?? "C:/Windows";
    vi.stubEnv("SystemRoot", systemRoot);
    try {
        const start: StartOpener = (command, args, options) => {
            expect(command).toBe(
                join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
            );
            expect(args).toContain("-NoProfile");
            expect(args.join(" ")).not.toContain(config);
            expect(options.shell).toBeUndefined();
            // 用真实子进程从传入环境读取文件，模拟系统关联程序的进程边界。
            return spawn(
                process.execPath,
                [
                    "-e",
                    "const fs = require('node:fs'); process.exit(fs.readFileSync(process.env.NAPUKETTO_OPEN_CONFIG, 'utf8') === 'fixture' ? 0 : 1)",
                ],
                options,
            );
        };
        expect(await openConfig(config, "win32", start)).toBe(true);
        expect(await openConfig(join(temp, "missing.toml"), "win32", start)).toBe(false);
    } finally {
        vi.unstubAllEnvs();
        await rm(temp, { recursive: true, force: true });
    }
});

it.skipIf(process.platform !== "win32")("系统 Windows 启动器找不到文件时返回失败", async () => {
    const temp = await mkdtemp(join(tmpdir(), "napuketto-create-"));
    try {
        expect(await openConfig(join(temp, "with space %PATH% &.toml"))).toBe(false);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
] as const)("%s 传递单个路径参数并处理异步启动失败", async (platform, opener) => {
    const config = join(tmpdir(), "with space %PATH% &.toml");
    const start: StartOpener = (command, args, options) => {
        expect(command).toBe(opener);
        expect(args).toEqual([config]);
        expect(options.shell).toBeUndefined();
        return spawn(join(config, "missing-opener"), [], options);
    };
    expect(await openConfig(config, platform, start)).toBe(false);
});
