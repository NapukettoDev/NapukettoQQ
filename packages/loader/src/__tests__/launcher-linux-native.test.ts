/**
 * launcher-linux-native.test.ts：`launchLinuxNative` 的 spawn 装配（Stage 3c HOME 收敛）。
 *
 * ADR-027 起 Linux 恒走原生分支——平台用 withPlatform 钉成 linux（不再是环境变量开关），
 * spawn / spawnSync 打桩，stub 用临时空 fixture——不触真实 ELF 与外部二进制。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV, type LaunchOptions, launchSelfHost } from "../launcher.js";
import type { QqInstallInfo } from "../locate-qq.js";

/** spawn 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => ({
    spawnCalls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock("node:child_process", () => ({
    spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
        h.spawnCalls.push({ command, args, options });
        return { once: (_event: string, _fn: (err: Error) => void) => undefined };
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", error: undefined })),
}));

/** 只替换探测函数：纯函数（resolveLinuxHome / linuxHomeEnv / linuxPreload）保留真实实现。 */
vi.mock("../linux-native.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../linux-native.js")>();
    return {
        ...actual,
        resolveGnutls: () => "/usr/lib/x86_64-linux-gnu/libgnutls.so.30",
        resolveLinuxNode: () => process.execPath,
    };
});

/** 平台切换（用后还原；Linux 分支判定只看 process.platform）。 */
function withLinux<T>(fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
        writable: true,
        enumerable: true,
    });
    return fn().finally(() => {
        if (original !== undefined) {
            Object.defineProperty(process, "platform", original);
        }
    });
}

let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-linux-native-"));
    h.spawnCalls.length = 0;
    delete process.env["NAPUTO_LINUX_HOME"];
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** 假 QQ 安装信息。 */
function fakeQq(): QqInstallInfo {
    return {
        qqPath: join(tmpRoot, "QQ"),
        installDir: tmpRoot,
        version: "3.2.35-54395",
        wrapperPath: join(tmpRoot, "app", "wrapper.node"),
        source: "local",
    };
}

/** stub `.so` 空 fixture（只过 existsSync 校验）。 */
function makeStubPath(): string {
    const dir = join(tmpRoot, "native", "build", "linux-x64");
    mkdirSync(dir, { recursive: true });
    const stub = join(dir, "libnapuketto_stub.so");
    writeFileSync(stub, "");
    return stub;
}

/** 基础 LaunchOptions（selfHostEntry 指向真实临时文件，cwd = 数据根）。 */
function baseOptions(overrides: Partial<LaunchOptions> = {}): LaunchOptions {
    const entry = join(tmpRoot, "self-host.cjs");
    writeFileSync(entry, "");
    return {
        qq: fakeQq(),
        kernelEntry: join(tmpRoot, "kernel.mjs"),
        cfgDir: join(tmpRoot, "data", "10001"),
        selfHostEntry: entry,
        cwd: join(tmpRoot, "data"),
        linuxStubPath: makeStubPath(),
        selfHost: true,
        ...overrides,
    };
}

/** 取 spawn 收到的 env。 */
function spawnedEnv(call = h.spawnCalls[0]): Record<string, string> {
    expect(call).toBeDefined();
    return (call?.options["env"] ?? {}) as Record<string, string>;
}

describe("launchLinuxNative：HOME/XDG 收敛", () => {
    it("spawn 标准 node，HOME 指向 <数据根>/home，XDG_* 同目录派生", async () => {
        const options = baseOptions();
        await withLinux(async () => {
            await launchSelfHost(options);
        });

        expect(h.spawnCalls).toHaveLength(1);
        const call = h.spawnCalls[0];
        expect(call?.command).toBe(process.execPath);
        expect(call?.args).toEqual([options.selfHostEntry]);

        const home = join(tmpRoot, "data", "home");
        const env = spawnedEnv(call);
        expect(env["HOME"]).toBe(home);
        expect(env["XDG_CONFIG_HOME"]).toBe(join(home, ".config"));
        expect(env["XDG_DATA_HOME"]).toBe(join(home, ".local", "share"));
        expect(env["XDG_CACHE_HOME"]).toBe(join(home, ".cache"));
        expect(env["XDG_STATE_HOME"]).toBe(join(home, ".local", "state"));
    });

    it("受管 HOME 目录被提前创建（原生层只 mkdir 自己的子目录）", async () => {
        await withLinux(async () => {
            await launchSelfHost(baseOptions());
        });
        const home = spawnedEnv()["HOME"] ?? "";
        expect(home !== "" && existsSync(home)).toBe(true);
    });

    it("同时保留 Linux 原生分支的 LD_PRELOAD 与 STUB_DIR", async () => {
        const options = baseOptions();
        const stub = options.linuxStubPath ?? "";
        await withLinux(async () => {
            await launchSelfHost(options);
        });
        const env = spawnedEnv();
        expect(env["LD_PRELOAD"]).toBe(`${stub}:/usr/lib/x86_64-linux-gnu/libgnutls.so.30`);
        expect(env[ENV.STUB_DIR]).toBe(stub);
    });

    it("NAPUTO_LINUX_HOME 显式覆盖受管 HOME（调试/特殊部署）", async () => {
        const custom = join(tmpRoot, "custom-home");
        vi.stubEnv("NAPUTO_LINUX_HOME", custom);
        await withLinux(async () => {
            await launchSelfHost(baseOptions());
        });
        expect(spawnedEnv()["HOME"]).toBe(custom);
    });

    it("无 cwd（未传数据根）时退到 <账号目录>/home", async () => {
        const options = baseOptions();
        const withoutCwd: LaunchOptions = { ...options };
        delete (withoutCwd as { cwd?: string }).cwd;
        await withLinux(async () => {
            await launchSelfHost(withoutCwd);
        });
        expect(spawnedEnv()["HOME"]).toBe(join(tmpRoot, "data", "10001", "home"));
    });

    it("NAPUTO_LINUX_NATIVE=0 已退役：只播报一句，行为不变（不走 stub QQNT.dll 校验）", async () => {
        const stages: string[] = [];
        vi.stubEnv("NAPUTO_LINUX_NATIVE", "0");
        await withLinux(async () => {
            // 未传 stubDir（win32 分支会因缺 QQNT.dll 抛错）——能正常 spawn 即证明走了原生分支
            await launchSelfHost(
                baseOptions({
                    onStage: (m) => stages.push(m),
                }),
            );
        });
        expect(stages.some((m) => m.includes("NAPUTO_LINUX_NATIVE=0 已失效"))).toBe(true);
        expect(h.spawnCalls[0]?.command).toBe(process.execPath);
    });
});
