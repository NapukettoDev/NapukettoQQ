import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageRoot } from "../../internal/package-root.js";
import type { QqInstallInfo } from "../../qq/locate-qq.js";
import {
    defaultStubDir,
    ENV,
    isNodeExecutable,
    type LaunchOptions,
    launchSelfHost,
} from "../launcher.js";

/** 默认 self-host 入口（与 launcher 的 packageRoot 推导一致；存在才跑该用例）。 */
const DEFAULT_SELF_HOST_ENTRY = join(packageRoot(), "dist", "host", "self-host.cjs");

/** child_process mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        spawnCalls: [] as Array<{
            command: string;
            args: string[];
            options: Record<string, unknown>;
        }>,
        spawnErrorHandlers: [] as Array<(err: Error) => void>,
        spawnSyncCalls: [] as Array<{ exe: string; args: string[] }>,
        /** spawnSync 行为按 exe 分发（where / node 探测）。 */
        syncResults: new Map<
            string,
            { status: number | null; stdout?: string; error?: { code: string } }
        >(),
        /** ensureWinNode 返回（win32 非 node 宿主）。 */
        winNode: { exePath: "C:\\runtime\\win-node\\node.exe", version: "v24.16.0" } as
            | { exePath: string; version: string }
            | Error,
        ensureWinNodeCalls: 0,
    };
});

vi.mock("node:child_process", () => ({
    spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
        h.spawnCalls.push({ command, args, options });
        const handler = (_err: Error): void => undefined;
        const child = {
            once: (event: string, fn: (err: Error) => void) => {
                if (event === "error") {
                    h.spawnErrorHandlers.push(fn);
                }
            },
        };
        void handler;
        return child;
    }),
    spawnSync: vi.fn((exe: string, args: string[]) => {
        h.spawnSyncCalls.push({ exe, args });
        const result = h.syncResults.get(exe);
        return {
            status: result?.status ?? null,
            stdout: result?.stdout ?? "",
            error: result?.error,
        };
    }),
}));

vi.mock("../win-node.js", () => ({
    ensureWinNode: vi.fn(async () => {
        h.ensureWinNodeCalls += 1;
        if (h.winNode instanceof Error) {
            throw h.winNode;
        }
        return h.winNode;
    }),
}));

/** execPath 可写性切换（非 node 宿主分支）。 */
function withExecPath<T>(execPath: string, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "execPath");
    Object.defineProperty(process, "execPath", {
        value: execPath,
        configurable: true,
        writable: true,
        enumerable: true,
    });
    return fn().finally(() => {
        if (original !== undefined) {
            Object.defineProperty(process, "execPath", {
                value: original.value,
                configurable: true,
                writable: true,
                enumerable: true,
            });
        }
    });
}

/** 平台切换（用后还原）。 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
        value: platform,
        configurable: true,
        writable: true,
        enumerable: true,
    });
    return fn().finally(() => {
        if (original !== undefined) {
            Object.defineProperty(process, "platform", {
                value: original.value,
                configurable: true,
                writable: true,
                enumerable: true,
            });
        }
    });
}

let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-launch-spawn-"));
    h.spawnCalls.length = 0;
    h.spawnErrorHandlers.length = 0;
    h.spawnSyncCalls.length = 0;
    h.syncResults.clear();
    h.winNode = { exePath: "C:\\runtime\\win-node\\node.exe", version: "v24.16.0" };
    h.ensureWinNodeCalls = 0;
    delete process.env["NAPUTO_WIN_NODE_PATH"];
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** 带 QQNT.dll 占位的 stub 目录（空文件 fixture，不触真实闭源二进制）。 */
function makeStubDir(): string {
    const dir = join(tmpRoot, "stub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "QQNT.dll"), "");
    return dir;
}

/** 假 QQ 安装信息。 */
function fakeQq(): QqInstallInfo {
    return {
        qqPath: join(tmpRoot, "QQ.exe"),
        installDir: tmpRoot,
        version: "9.9.33-51802",
        wrapperPath: join(tmpRoot, "versions", "app", "wrapper.node"),
        source: "local",
    };
}

/** 基础 LaunchOptions（selfHostEntry 指向真实临时文件）。 */
function baseOptions(overrides: Partial<LaunchOptions> = {}): LaunchOptions {
    const entry = join(tmpRoot, "self-host.cjs");
    writeFileSync(entry, "");
    return {
        qq: fakeQq(),
        kernelEntry: join(tmpRoot, "kernel.mjs"),
        cfgDir: join(tmpRoot, "account"),
        stubDir: makeStubDir(),
        selfHostEntry: entry,
        ...overrides,
    };
}

describe("launchSelfHost 前置校验", () => {
    it("selfHostEntry 指向不存在文件 → 报错（先构建提示）", async () => {
        const options = baseOptions({ selfHostEntry: join(tmpRoot, "missing.cjs") });
        await expect(launchSelfHost(options)).rejects.toThrow("self-host.cjs 缺失");
        expect(h.spawnCalls).toHaveLength(0);
    });

    it("stub QQNT.dll 缺失 → 报错并提示 --stub-dir/NAPUTO_STUB_DIR", async () => {
        // 平台钉死 win32：Linux 上会先走原生 ELF 分支（不校验 QQNT.dll），断言不成立
        await withPlatform("win32", async () => {
            const options = baseOptions({ stubDir: join(tmpRoot, "no-stub") });
            await expect(launchSelfHost(options)).rejects.toThrow(
                /stub QQNT.dll 未找到[\s\S]*stub-dir/,
            );
            expect(h.spawnCalls).toHaveLength(0);
        });
    });

    it.skipIf(!existsSync(DEFAULT_SELF_HOST_ENTRY))(
        "默认 self-host 入口（dist 产物存在时）+ defaultStubDir 指向包内路径",
        async () => {
            const options = baseOptions({ stubDir: makeStubDir() });
            delete options.selfHostEntry;
            // 平台钉死 win32：否则 Linux 上会走原生 ELF 分支（spawn 被 mock，但断言是 win32 形态）
            await withPlatform("win32", async () => {
                await launchSelfHost(options);
                // selfHostEntry 未传 → 走默认入口分支（dist 产物）
                expect(h.spawnCalls[0]?.args[0]).toBe(DEFAULT_SELF_HOST_ENTRY);
                // defaultStubDir 纯路径推导（不读 native 子模块内容）
                expect(defaultStubDir().endsWith(join("native", "build", "stub-test-env"))).toBe(
                    true,
                );
            });
        },
    );

    it("onStage 播报 stub 就绪与 spawn 命令（win32 形态，平台钉死）", async () => {
        const stages: string[] = [];
        await withPlatform("win32", async () => {
            await launchSelfHost(baseOptions({ onStage: (m) => stages.push(m) }));
        });
        expect(stages.some((m) => m.includes("stub QQNT.dll 就绪"))).toBe(true);
        expect(stages.some((m) => m.includes("启动自建宿主子进程"))).toBe(true);
    });
});

describe("launchSelfHost win32 分支", () => {
    it("标准 node 宿主：spawn node selfHostPath，env 注入 QQ 路径与可选变量，PATH 前置 stub/wrapper", async () => {
        const stubDir = makeStubDir();
        const options = baseOptions({
            selfHost: true,
            quickUin: "10001",
            qrOnly: true,
            ipc: true,
            adapterEntry: join(tmpRoot, "adapter.mjs"),
            networkEntry: join(tmpRoot, "network.mjs"),
            configPath: join(tmpRoot, "napuketto.toml"),
            extraEnv: { NAPUTO_DATA_ROOT: tmpRoot },
            cwd: join(tmpRoot, "data"),
        });
        // 平台钉死 win32：isLinux() 为 false 才走本分支（不真实执行任何外部二进制——
        // spawn/spawnSync 全 mock）
        await withPlatform("win32", async () => {
            await launchSelfHost(options);
            const call = h.spawnCalls[0];
            expect(call?.command).toBe(process.execPath);
            expect(call?.args[0]).toBe(options.selfHostEntry);
            const env = call?.options["env"] as Record<string, string>;
            expect(env[ENV.QQ_PATH]).toBe(join(tmpRoot, "QQ.exe"));
            expect(env[ENV.CFG_DIR]).toBe(join(tmpRoot, "account"));
            expect(env[ENV.QQ_VERSION]).toBe("9.9.33-51802");
            expect(env[ENV.WRAPPER_PATH]).toContain("wrapper.node");
            expect(env[ENV.SELF_HOST]).toBe("1");
            expect(env[ENV.QUICK_UIN]).toBe("10001");
            expect(env[ENV.QR_ONLY]).toBe("1");
            expect(env[ENV.IPC]).toBe("1");
            expect(env[ENV.ADAPTER_ENTRY]).toBe(join(tmpRoot, "adapter.mjs"));
            expect(env[ENV.NETWORK_ENTRY]).toBe(join(tmpRoot, "network.mjs"));
            expect(env[ENV.CONFIG_PATH]).toBe(join(tmpRoot, "napuketto.toml"));
            expect(env["NAPUTO_DATA_ROOT"]).toBe(tmpRoot);
            expect(env[ENV.STUB_DIR]).toBe(stubDir);
            // PATH 前置 stub 目录与 wrapper.node 目录（win32 原样；真实 PATH 仅为
            // 尾部透传，不参与断言——跨平台形态差异不碰）
            const entries = (env["PATH"] as string).split(";");
            expect(entries[0]).toBe(stubDir);
            expect(entries[1]).toBe(dirname(fakeQq().wrapperPath));
            // cwd 显式建目录（QQ 原生层 fallback 落盘不污染项目根）
            expect(call?.options["cwd"]).toBe(join(tmpRoot, "data"));
            expect(existsSync(join(tmpRoot, "data"))).toBe(true);
        });
    });

    it("非 node 宿主（bun.exe execPath）→ 解析真 node（显式路径）后 spawn", async () => {
        await withPlatform("win32", async () => {
            await withExecPath("C:\\runtime\\bun.exe", async () => {
                const explicit = join(tmpRoot, "node.exe");
                writeFileSync(explicit, "");
                await launchSelfHost(baseOptions({ winNodePath: explicit }));
                expect(h.spawnCalls[0]?.command).toBe(explicit);
            });
        });
    });

    it("非 node 宿主且无显式路径 → findSystemNode 系统 node 兜底（spawnSync where）", async () => {
        await withPlatform("win32", async () => {
            await withExecPath("bun.exe", async () => {
                const sysNode = join(tmpRoot, "sys-node.exe");
                writeFileSync(sysNode, "");
                h.syncResults.set("where", { status: 0, stdout: `${sysNode}\r\n` });
                h.syncResults.set(sysNode, { status: 0, stdout: "v24.16.0\r\n" });
                await launchSelfHost(baseOptions());
                expect(h.spawnCalls[0]?.command).toBe(sysNode);
            });
        });
    });

    it("spawn error（ENOENT）→ stderr 兜底输出，宿主进程不崩", async () => {
        await withPlatform("win32", async () => {
            await launchSelfHost(baseOptions());
            const handler = h.spawnErrorHandlers[0];
            expect(handler).toBeTypeOf("function");
            const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            try {
                handler?.(Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
                expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("无法启动子进程"));
            } finally {
                errSpy.mockRestore();
            }
        });
    });

    it("spawn error（非 ENOENT）→ 通用失败消息（无安装指引残留）", async () => {
        await withPlatform("win32", async () => {
            await launchSelfHost(baseOptions());
            const handler = h.spawnErrorHandlers[0];
            const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            try {
                handler?.(new Error("权限不足"));
                expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("子进程启动失败"));
                expect(errSpy).toHaveBeenCalledWith(expect.not.stringContaining("wine"));
            } finally {
                errSpy.mockRestore();
            }
        });
    });
});

describe("findSystemNode / isNodeExecutable（补充分支）", () => {
    it("isNodeExecutable：正反斜杠路径均识别 node.exe/node", () => {
        expect(isNodeExecutable("/opt/node/bin/node")).toBe(true);
        expect(isNodeExecutable("D:\\x\\NODE.EXE")).toBe(true);
        expect(isNodeExecutable("deno")).toBe(false);
    });

    it("where 失败 / 输出空 / 路径不存在 → undefined", async () => {
        const { findSystemNode } = await import("../launcher.js");
        h.syncResults.set("where", { status: 1 });
        expect(findSystemNode()).toBeUndefined();
        h.syncResults.set("where", { status: 0, stdout: "" });
        expect(findSystemNode()).toBeUndefined();
        h.syncResults.set("where", { status: 0, stdout: "C:\\nowhere\\node.exe\r\n" });
        expect(findSystemNode()).toBeUndefined();
    });

    it("node --version 非 v 前缀 / 探测失败 → undefined", async () => {
        const { findSystemNode } = await import("../launcher.js");
        const sysNode = join(tmpRoot, "fake-node.exe");
        writeFileSync(sysNode, "");
        h.syncResults.set("where", { status: 0, stdout: `${sysNode}\n` });
        h.syncResults.set(sysNode, { status: 0, stdout: "24.16.0" });
        expect(findSystemNode()).toBeUndefined();
        h.syncResults.set(sysNode, { status: 1 });
        expect(findSystemNode()).toBeUndefined();
    });

    it("正常探测：首条 + --version → resolve 绝对路径", async () => {
        const { findSystemNode } = await import("../launcher.js");
        const sysNode = join(tmpRoot, "node.exe");
        writeFileSync(sysNode, "");
        h.syncResults.set("where", {
            status: 0,
            stdout: `\r\n${sysNode}\r\nC:\\other\\node.exe\r\n`,
        });
        h.syncResults.set(sysNode, { status: 0, stdout: "v24.16.0\r\n" });
        const info = findSystemNode();
        expect(info?.exePath).toBe(sysNode);
        expect(info?.version).toBe("v24.16.0");
    });
});
