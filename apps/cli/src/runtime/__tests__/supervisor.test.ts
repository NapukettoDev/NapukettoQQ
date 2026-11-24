/**
 * supervisor.test.ts：多账号编排单测（2026-10-25 渲染决策传播 + 优雅停树）。
 *
 * spawn / loadCliConfig / 哨兵 / runtime 落盘 / logger 均注入假实现；覆盖：
 * 渲染决策传播（pretty 加 [uin] 前缀 / single-line 原样透传）、无账号告警、
 * autoRestart 守护重启、退出码 78 不重启、spawn error 兜底、停止哨兵 →
 * stopAll → 全部退出后 exit 0（退出码契约）。
 *
 * runSupervisor 常驻（内部 await 永不 resolve 的 Promise，由 stopAll 的
 * process.exit 结束）——测试内 mock process.exit，不真正退出。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    loadCliConfigWithSource: vi.fn(),
    writeStopSentinel: vi.fn(),
    watchStopSentinel: vi.fn(),
    writeSupervisorRuntime: vi.fn(),
    writeAccountRuntime: vi.fn(),
    patchAccountRuntime: vi.fn(),
    killProcessTree: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, spawn: mocks.spawn };
});
vi.mock("../../config/store.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, loadCliConfigWithSource: mocks.loadCliConfigWithSource };
});
vi.mock("@napuketto/loader", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        writeStopSentinel: mocks.writeStopSentinel,
        watchStopSentinel: mocks.watchStopSentinel,
    };
});
vi.mock("../state.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        writeSupervisorRuntime: mocks.writeSupervisorRuntime,
        writeAccountRuntime: mocks.writeAccountRuntime,
        patchAccountRuntime: mocks.patchAccountRuntime,
        killProcessTree: mocks.killProcessTree,
    };
});
// logger 换桩（避免真实 stdout 噪音 + 断言 warn/error），渲染决策函数保留真实实现
vi.mock("../../logger.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, logger: mocks.logger };
});

import { SUPERVISOR_CHILD_ENV } from "../state.js";
import { computeRestartDelayMs, runSupervisor } from "../supervisor.js";

interface FakeChild extends EventEmitter {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(pid: number): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = pid;
    child.kill = vi.fn();
    return child;
}

function setTty(value: boolean | undefined): void {
    if (value === undefined) {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
        Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
    }
}

/** stdout 透传 spy（记录调用的同时不吞掉测试运行器输出）。 */
function spyStdoutPassthrough(): ReturnType<typeof vi.spyOn> {
    const bound = process.stdout.write.bind(process.stdout);
    return vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        bound(chunk);
        return true;
    });
}

let tmp = "";
let exitSpy: ReturnType<typeof vi.spyOn>;
let exitCodeBefore: number | undefined;
const watchOpts: Array<{ dataRoot: string; onTrigger: () => void }> = [];

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-supervisor-test-"));
    // 渲染决策读全局配置：指向不存在的文件 → 缺省（隔离开发机 napuketto.toml）
    process.env["NAPUKETTO_CONFIG"] = join(tmp, "不存在.toml");
    delete process.env["NAPUKETTO_LOG_FORMAT"];
    delete process.env["NAPUKETTO_LOG_COLORIZE"];
    exitCodeBefore = process.exitCode as number | undefined;
    process.exitCode = undefined;
    for (const fn of [
        mocks.spawn,
        mocks.loadCliConfigWithSource,
        mocks.writeStopSentinel,
        mocks.watchStopSentinel,
        mocks.writeSupervisorRuntime,
        mocks.writeAccountRuntime,
        mocks.patchAccountRuntime,
        mocks.killProcessTree,
        ...Object.values(mocks.logger),
    ]) {
        fn.mockReset();
    }
    watchOpts.length = 0;
    mocks.watchStopSentinel.mockImplementation(
        (opts: { dataRoot: string; onTrigger: () => void }) => {
            watchOpts.push(opts);
            return () => {
                // 取消桩（测试不触发取消路径）
            };
        },
    );
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
    setTty(undefined);
    delete process.env["NAPUKETTO_CONFIG"];
    process.exitCode = exitCodeBefore as number | undefined;
    vi.restoreAllMocks();
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

/** 配置单账号并启动 supervisor（返回常驻 promise；多数用例无需等待其结束）。 */
function startWithAccounts(accounts: { qq: string }[], autoRestart: boolean): Promise<void> {
    mocks.loadCliConfigWithSource.mockResolvedValue({
        config: {
            dataDir: tmp,
            accounts,
            autoRestart,
            restartDelayMs: 30,
        },
        source: "file",
        path: join(tmp, "napuketto.toml"),
    });
    return runSupervisor({ dataDir: tmp });
}

describe("runSupervisor 子进程拉起", () => {
    it("管道场景：渲染决策为 single-line 且转发不加前缀", async () => {
        setTty(false);
        const child = makeFakeChild(4243);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const opts = mocks.spawn.mock.calls[0]?.[2] as { env: Record<string, string> };
        expect(opts.env["NAPUKETTO_LOG_FORMAT"]).toBe("single-line");
        const outSpy = spyStdoutPassthrough();
        child.stdout.write("raw-json-line\n");
        await vi.waitFor(() => expect(outSpy).toHaveBeenCalledWith("raw-json-line\n"));
        expect(outSpy).not.toHaveBeenCalledWith("[10001] raw-json-line\n");
    });

    it("pretty 场景：子进程行加 [uin] 前缀转发", async () => {
        setTty(true);
        const child = makeFakeChild(4244);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const outSpy = spyStdoutPassthrough();
        child.stdout.write("hello\n");
        await vi.waitFor(() => expect(outSpy).toHaveBeenCalledWith("[10001] hello\n"));
    });

    it("注入托管标记 + 落 supervisor-child 状态与命令行指纹", async () => {
        setTty(false);
        const child = makeFakeChild(4245);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const opts = mocks.spawn.mock.calls[0]?.[2] as { env: Record<string, string> };
        expect(opts.env[SUPERVISOR_CHILD_ENV]).toBe("1");
        expect(mocks.writeAccountRuntime).toHaveBeenCalledWith(
            tmp,
            expect.objectContaining({
                uin: "10001",
                kind: "supervisor-child",
                status: "running",
                cmdline: expect.stringContaining(`-q 10001 --data-dir ${tmp}`),
            }),
        );
        child.emit("exit", 0, null);
    });

    it("--qq-path 透传子进程参数与 runtime.json 命令行指纹", async () => {
        setTty(false);
        const child = makeFakeChild(4260);
        mocks.spawn.mockImplementation(() => child);
        mocks.loadCliConfigWithSource.mockResolvedValue({
            config: {
                dataDir: tmp,
                accounts: [{ qq: "10001" }],
                autoRestart: false,
                restartDelayMs: 30,
            },
            source: "file",
            path: join(tmp, "napuketto.toml"),
        });
        const running = runSupervisor({ dataDir: tmp, qqPath: "/opt/qq" });
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const args = mocks.spawn.mock.calls[0]?.[1] as string[];
        expect(args.slice(-2)).toEqual(["--qq-path", "/opt/qq"]);
        expect(mocks.writeAccountRuntime).toHaveBeenCalledWith(
            tmp,
            expect.objectContaining({ cmdline: expect.stringContaining("--qq-path /opt/qq") }),
        );
        child.emit("exit", 0, null);
        await running;
    });
});

describe("runSupervisor 显式 -q 校验", () => {
    beforeEach(() => {
        mocks.loadCliConfigWithSource.mockResolvedValue({
            config: {
                dataDir: tmp,
                accounts: [],
                autoRestart: false,
                restartDelayMs: 30,
            },
            source: "file",
            path: join(tmp, "napuketto.toml"),
        });
    });

    it("重复 -q → ConfigError，不 spawn、不写 supervisor 状态", async () => {
        await expect(runSupervisor({ dataDir: tmp, qqs: ["10001", "10001"] })).rejects.toThrow(
            ConfigError,
        );
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.writeSupervisorRuntime).not.toHaveBeenCalled();
    });

    it("非法 -q → ConfigError，不进入编排", async () => {
        await expect(runSupervisor({ dataDir: tmp, qqs: ["all"] })).rejects.toThrow(ConfigError);
        await expect(runSupervisor({ dataDir: tmp, qqs: ["../escape"] })).rejects.toThrow(
            ConfigError,
        );
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});

describe("runSupervisor 账号退出", () => {
    it("无账号（accounts 为空）：warn 后正常返回", async () => {
        mocks.loadCliConfigWithSource.mockResolvedValue({
            config: {
                dataDir: tmp,
                accounts: [],
                autoRestart: false,
                restartDelayMs: 30,
            },
            source: "file",
            path: join(tmp, "napuketto.toml"),
        });
        await expect(runSupervisor({ dataDir: tmp })).resolves.toBeUndefined();
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("没有启用的账号"));
    });

    it("autoRestart 开启：账号退出后延迟重启", async () => {
        const child = makeFakeChild(4245);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], true);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 1, null);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        expect(mocks.writeAccountRuntime).toHaveBeenLastCalledWith(
            tmp,
            expect.objectContaining({ uin: "10001", status: "running", restartCount: 1 }),
        );
    });

    it("autoRestart 关闭：账号退出合并写 runtime exited", async () => {
        const child = makeFakeChild(4246);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 1, "SIGTERM");
        await vi.waitFor(() =>
            expect(mocks.patchAccountRuntime).toHaveBeenCalledWith(
                tmp,
                "10001",
                expect.objectContaining({ status: "exited", exitCode: 1 }),
                expect.objectContaining({ uin: "10001", kind: "supervisor-child" }),
            ),
        );
    });

    it("退出码 78（配置校验失败）：autoRestart 开启也不重启（2026-10-25 契约）", async () => {
        const child = makeFakeChild(4250);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], true);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 78, null);
        await vi.waitFor(() =>
            expect(mocks.patchAccountRuntime).toHaveBeenCalledWith(
                tmp,
                "10001",
                expect.objectContaining({ status: "exited", exitCode: 78 }),
                expect.objectContaining({ uin: "10001", kind: "supervisor-child" }),
            ),
        );
        // 不重启：延迟（30ms）后 spawn 仍只发生一次
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ qq: "10001" }),
            expect.stringContaining("不自动重启"),
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(mocks.spawn).toHaveBeenCalledOnce();
    });

    it("spawn error 兜底：logger.error 且不崩进程", async () => {
        const child = makeFakeChild(4247);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("error", new Error("spawn 失败"));
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ qq: "10001" }),
            expect.stringContaining("账号启动失败"),
        );
    });
});

describe("runSupervisor 秒退指数退避（issue #144）", () => {
    it("computeRestartDelayMs：按 2^n 增长并封顶 60s", () => {
        expect(computeRestartDelayMs(2000, 1)).toBe(2000);
        expect(computeRestartDelayMs(2000, 2)).toBe(4000);
        expect(computeRestartDelayMs(30_000, 2)).toBe(60_000);
        expect(computeRestartDelayMs(30_000, 3)).toBe(60_000);
        expect(computeRestartDelayMs(30_000, 100)).toBe(60_000);
    });

    it("连续秒退 → 延迟从 30ms 翻倍到 60ms，日志带连续失败次数与下次延迟", async () => {
        const first = makeFakeChild(4300);
        const second = makeFakeChild(4301);
        const third = makeFakeChild(4302);
        mocks.spawn
            .mockImplementationOnce(() => first)
            .mockImplementationOnce(() => second)
            .mockImplementation(() => third);
        void startWithAccounts([{ qq: "10001" }], true);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));

        first.emit("exit", 1, null);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                qq: "10001",
                consecutiveFailures: 1,
                nextDelayMs: 30,
            }),
            expect.stringContaining("指数退避"),
        );

        // 第二次仍在阈值内退出 → 退避翻倍（60ms），由日志延迟值断言（不依赖墙钟）
        second.emit("exit", 1, null);
        await vi.waitFor(() => {
            expect(mocks.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    qq: "10001",
                    consecutiveFailures: 2,
                    nextDelayMs: 60,
                }),
                expect.stringContaining("指数退避"),
            );
        });
        // 退避到期后第三次拉起
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(3));

        // 收尾：停止守护，避免常驻
        await vi.waitFor(() => expect(watchOpts.length).toBe(1));
        watchOpts[0]?.onTrigger();
        third.emit("exit", 0, null);
    });

    it("稳定运行超过 30s → 退避计数清零，恢复基础延迟", async () => {
        const first = makeFakeChild(4310);
        const second = makeFakeChild(4311);
        const third = makeFakeChild(4312);
        mocks.spawn
            .mockImplementationOnce(() => first)
            .mockImplementationOnce(() => second)
            .mockImplementation(() => third);
        void startWithAccounts([{ qq: "10001" }], true);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));

        first.emit("exit", 1, null);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));

        // 第二次进程「已稳定运行 31s」→ Date.now 前移跨过阈值
        const stableNow = Date.now() + 31_000;
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(stableNow);
        try {
            second.emit("exit", 1, null);
            await vi.waitFor(() => {
                expect(mocks.logger.info).toHaveBeenCalledWith(
                    expect.objectContaining({
                        qq: "10001",
                        consecutiveFailures: 0,
                        nextDelayMs: 30,
                    }),
                    expect.stringContaining("准备重启"),
                );
            });
        } finally {
            nowSpy.mockRestore();
        }

        // 收尾：阻止退避定时器再拉起子进程
        await vi.waitFor(() => expect(watchOpts.length).toBe(1));
        watchOpts[0]?.onTrigger();
        third.emit("exit", 0, null);
    });
});

describe("runSupervisor 空闲收尾（无子进程且无待重启）", () => {
    it("autoRestart 关闭：唯一子进程退出后结束常驻并返回 0", async () => {
        const child = makeFakeChild(4400);
        mocks.spawn.mockImplementation(() => child);
        const running = startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 0, null);
        await running;
        expect(process.exitCode).toBe(0);
    });

    it("全部账号因 78 退出（autoRestart 开启）：结束常驻并透传 78", async () => {
        const first = makeFakeChild(4401);
        const second = makeFakeChild(4402);
        mocks.spawn.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
        const running = startWithAccounts([{ qq: "10001" }, { qq: "20002" }], true);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        first.emit("exit", 78, null);
        second.emit("exit", 78, null);
        await running;
        expect(process.exitCode).toBe(78);
    });

    it("spawn error 且无其他子进程：结束常驻并返回 1", async () => {
        const child = makeFakeChild(4405);
        mocks.spawn.mockImplementation(() => child);
        const running = startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("error", new Error("spawn 失败"));
        await running;
        expect(process.exitCode).toBe(1);
    });

    it("stopAll 清理待重启定时器：停止后不再拉起子进程", async () => {
        vi.useFakeTimers();
        try {
            const first = makeFakeChild(4403);
            mocks.spawn
                .mockImplementationOnce(() => first)
                .mockImplementation(() => makeFakeChild(4404));
            void startWithAccounts([{ qq: "10001" }], true);
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.spawn).toHaveBeenCalledOnce();
            // 子进程退出 → 30ms 退避重启定时器已排程（尚未到期）
            first.emit("exit", 1, null);
            watchOpts[0]?.onTrigger();
            await vi.advanceTimersByTimeAsync(1000);
            expect(mocks.spawn).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("runSupervisor 优雅停树", () => {
    it("停止哨兵触发 → 写 all 哨兵 → 子进程退出后 exit 0", async () => {
        setTty(true);
        const child = makeFakeChild(4248);
        mocks.spawn.mockImplementation(() => child);
        void startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(watchOpts.length).toBe(1));
        watchOpts[0]?.onTrigger();
        expect(mocks.writeStopSentinel).toHaveBeenCalledWith(tmp, "all");
        child.emit("exit", 0, null);
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });

    it("无运行账号（子进程已退出）：空闲收尾直接结束，不再依赖哨兵", async () => {
        const child = makeFakeChild(4249);
        mocks.spawn.mockImplementation(() => child);
        const running = startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 0, null);
        await running;
        expect(process.exitCode).toBe(0);
        // 已结束常驻：迟到的哨兵不再触发 stopAll（避免重复退出路径）
        watchOpts[0]?.onTrigger();
        expect(exitSpy).not.toHaveBeenCalled();
    });
});
