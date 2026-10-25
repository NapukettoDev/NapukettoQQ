/**
 * supervisor.test.ts：多账号编排单测（2026-10-25 渲染决策传播 + 优雅停树）。
 *
 * spawn / loadCliConfig / 哨兵 / runtime 落盘 / logger 均注入假实现；覆盖：
 * 子进程拉起（args + env 注入 NO_BANNER 与渲染决策传播）、pretty 前缀转发 /
 * single-line 原样透传、无账号告警、autoRestart 守护重启、spawn error 兜底、
 * 停止哨兵 → stopAll → 全部退出后 exit 0（退出码契约）。
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    loadCliConfig: vi.fn(),
    writeStopSentinel: vi.fn(),
    watchStopSentinel: vi.fn(),
    writeSupervisorRuntime: vi.fn(),
    writeAccountRuntime: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, spawn: mocks.spawn };
});
vi.mock("./config-cmds.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, loadCliConfig: mocks.loadCliConfig };
});
vi.mock("@napuketto/loader", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        writeStopSentinel: mocks.writeStopSentinel,
        watchStopSentinel: mocks.watchStopSentinel,
    };
});
vi.mock("./runtime-state.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        writeSupervisorRuntime: mocks.writeSupervisorRuntime,
        writeAccountRuntime: mocks.writeAccountRuntime,
    };
});
// logger 换桩（避免真实 stdout 噪音 + 断言 warn/error），渲染决策函数保留真实实现
vi.mock("./logger.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, logger: mocks.logger };
});

import { runSupervisor } from "./supervisor.js";

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
const watchOpts: Array<{ dataRoot: string; onTrigger: () => void }> = [];

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-supervisor-test-"));
    // 渲染决策读全局配置：指向不存在的文件 → 缺省（隔离开发机 napuketto.toml）
    process.env["NAPKETTO_CONFIG"] = join(tmp, "不存在.toml");
    delete process.env["NAPUKETTO_LOG_FORMAT"];
    delete process.env["NAPUKETTO_LOG_COLORIZE"];
    for (const fn of [
        mocks.spawn,
        mocks.loadCliConfig,
        mocks.writeStopSentinel,
        mocks.watchStopSentinel,
        mocks.writeSupervisorRuntime,
        mocks.writeAccountRuntime,
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
    delete process.env["NAPKETTO_CONFIG"];
    vi.restoreAllMocks();
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

/** 配置单账号并启动 supervisor（挂起 promise 属预期，不 await）。 */
function startWithAccounts(accounts: { qq: string }[], autoRestart: boolean): void {
    mocks.loadCliConfig.mockResolvedValue({
        dataDir: tmp,
        accounts,
        autoRestart,
        restartDelayMs: 30,
    });
    void runSupervisor({ dataDir: tmp });
}

describe("runSupervisor 子进程拉起", () => {
    it("args/env 注入（NO_BANNER + 渲染决策传播）+ runtime 落盘", async () => {
        setTty(true);
        const child = makeFakeChild(4242);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const [command, args, opts] = mocks.spawn.mock.calls[0] as unknown as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(command).toBe(process.execPath);
        expect(args).toContain("-q");
        expect(args).toContain("10001");
        expect(args).toContain(tmp);
        expect(opts.env["NAPUKETTO_NO_BANNER"]).toBe("1");
        expect(opts.env["NAPUKETTO_LOG_FORMAT"]).toBe("pretty");
        expect(mocks.writeSupervisorRuntime).toHaveBeenCalledOnce();
    });

    it("管道场景：渲染决策为 single-line 且转发不加前缀", async () => {
        setTty(false);
        const child = makeFakeChild(4243);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], false);
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
        startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        const outSpy = spyStdoutPassthrough();
        child.stdout.write("hello\n");
        await vi.waitFor(() => expect(outSpy).toHaveBeenCalledWith("[10001] hello\n"));
    });
});

describe("runSupervisor 账号退出", () => {
    it("无账号（accounts 为空）：warn 后正常返回", async () => {
        mocks.loadCliConfig.mockResolvedValue({
            dataDir: tmp,
            accounts: [],
            autoRestart: false,
            restartDelayMs: 30,
        });
        await expect(runSupervisor({ dataDir: tmp })).resolves.toBeUndefined();
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("没有启用的账号"));
    });

    it("autoRestart 开启：账号退出后延迟重启", async () => {
        const child = makeFakeChild(4245);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], true);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 1, null);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        expect(mocks.writeAccountRuntime).toHaveBeenLastCalledWith(
            tmp,
            expect.objectContaining({ uin: "10001", status: "running", restartCount: 1 }),
        );
    });

    it("autoRestart 关闭：账号退出写 runtime exited", async () => {
        const child = makeFakeChild(4246);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 1, "SIGTERM");
        await vi.waitFor(() =>
            expect(mocks.writeAccountRuntime).toHaveBeenCalledWith(
                tmp,
                expect.objectContaining({ uin: "10001", status: "exited", exitCode: 1 }),
            ),
        );
    });

    it("spawn error 兜底：logger.error 且不崩进程", async () => {
        const child = makeFakeChild(4247);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("error", new Error("spawn 失败"));
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ qq: "10001" }),
            expect.stringContaining("账号启动失败"),
        );
    });
});

describe("runSupervisor 优雅停树", () => {
    it("停止哨兵触发 → 写 all 哨兵 → 子进程退出后 exit 0", async () => {
        setTty(true);
        const child = makeFakeChild(4248);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(watchOpts.length).toBe(1));
        watchOpts[0]?.onTrigger();
        expect(mocks.writeStopSentinel).toHaveBeenCalledWith(tmp, "all");
        child.emit("exit", 0, null);
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });

    it("无运行账号时哨兵触发直接 exit 0", async () => {
        const child = makeFakeChild(4249);
        mocks.spawn.mockImplementation(() => child);
        startWithAccounts([{ qq: "10001" }], false);
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        child.emit("exit", 0, null);
        watchOpts[0]?.onTrigger();
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });
});
