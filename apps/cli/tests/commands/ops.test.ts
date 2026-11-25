/**
 * ops.test.ts：status / stop / restart 运维命令单测（2026-10-25 优雅化）。
 *
 * runtime/state / 哨兵 / logger 全部注入假实现；覆盖：status 聚合输出、
 * stop -q（无运行时拒绝 / 哨兵优先 + 等优雅退出 + 清哨兵）、stop 全量
 * （supervisor 哨兵 + 残留账号兜底树杀）、超时树杀兜底（fake timers 压缩
 * 8s 等待）、restart detached 拉起参数。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRuntime } from "../../src/runtime/state.js";

const mocks = vi.hoisted(() => ({
    writeStopSentinel: vi.fn(),
    removeStopSentinel: vi.fn(),
    writeAccountStopSentinel: vi.fn(),
    removeAccountStopSentinel: vi.fn(),
    isPidAlive: vi.fn(),
    killProcessTree: vi.fn(),
    checkProcessIdentity: vi.fn(),
    listAccountRuntimes: vi.fn(),
    readSupervisorRuntime: vi.fn(),
    aggregateStatus: vi.fn(),
    spawnDetached: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@napuketto/loader", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        writeStopSentinel: mocks.writeStopSentinel,
        removeStopSentinel: mocks.removeStopSentinel,
        writeAccountStopSentinel: mocks.writeAccountStopSentinel,
        removeAccountStopSentinel: mocks.removeAccountStopSentinel,
    };
});
vi.mock("../../src/runtime/state.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        isPidAlive: mocks.isPidAlive,
        killProcessTree: mocks.killProcessTree,
        checkProcessIdentity: mocks.checkProcessIdentity,
        listAccountRuntimes: mocks.listAccountRuntimes,
        readSupervisorRuntime: mocks.readSupervisorRuntime,
        aggregateStatus: mocks.aggregateStatus,
        spawnDetached: mocks.spawnDetached,
    };
});
vi.mock("../../src/logger.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, logger: mocks.logger };
});

import { cmdRestart, cmdStatus, cmdStop } from "../../src/commands/ops.js";

let tmp = "";

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-ops-test-"));
    for (const fn of [
        mocks.writeStopSentinel,
        mocks.removeStopSentinel,
        mocks.writeAccountStopSentinel,
        mocks.removeAccountStopSentinel,
        mocks.isPidAlive,
        mocks.killProcessTree,
        mocks.checkProcessIdentity,
        mocks.listAccountRuntimes,
        mocks.readSupervisorRuntime,
        mocks.aggregateStatus,
        mocks.spawnDetached,
        ...Object.values(mocks.logger),
    ]) {
        fn.mockReset();
    }
    mocks.isPidAlive.mockReturnValue(false);
    mocks.checkProcessIdentity.mockReturnValue("unverified");
    mocks.listAccountRuntimes.mockReturnValue([]);
    mocks.readSupervisorRuntime.mockReturnValue(null);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

/** 单账号运行时桩。 */
function runtimeOf(
    uin: string,
    pid: number,
    overrides: Partial<AccountRuntime> = {},
): AccountRuntime {
    return {
        uin,
        pid,
        startedAt: "2026-10-25T00:00:00.000Z",
        kind: "supervisor-child",
        status: "running",
        restartCount: 0,
        ...overrides,
    } as unknown as AccountRuntime;
}

describe("cmdStatus", () => {
    it("supervisor 未运行 + 无账号运行时：双告警", () => {
        cmdStatus(tmp, {});
        expect(mocks.logger.info).toHaveBeenCalledWith("supervisor 未运行（无状态文件）");
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ dataRoot: tmp }),
            expect.stringContaining("没有账号运行时状态"),
        );
    });

    it("supervisor 运行中 + 账号行聚合输出（含 selfHostPid）", () => {
        mocks.readSupervisorRuntime.mockReturnValue({
            pid: 123,
            accounts: ["10001"],
            startedAt: "t",
        });
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 456)]);
        mocks.aggregateStatus.mockReturnValue([
            {
                uin: "10001",
                alive: true,
                pid: 456,
                selfHostPid: 789,
                kind: "supervisor-child",
                startedAt: "t",
                restartCount: 3,
            },
        ]);
        cmdStatus(tmp, {});
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ pid: 123 }),
            "supervisor",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                uin: "10001",
                alive: true,
                selfHostPid: 789,
                restartCount: 3,
            }),
            "账号状态",
        );
    });

    it("qq 过滤：仅命中指定账号", () => {
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 1), runtimeOf("20002", 2)]);
        mocks.aggregateStatus.mockReturnValue([]);
        cmdStatus(tmp, { qq: "20002" });
        expect(mocks.aggregateStatus).toHaveBeenCalledWith([runtimeOf("20002", 2)]);
    });
});

describe("-q 入口校验（防止路径穿越 / 哨兵污染）", () => {
    it("cmdStatus 非法 -q → ConfigError，不读取运行时状态", () => {
        expect(() => cmdStatus(tmp, { qq: "../escape" })).toThrow(ConfigError);
        expect(mocks.readSupervisorRuntime).not.toHaveBeenCalled();
    });

    it("cmdStop 非法 -q（all / 路径穿越）→ ConfigError，绝不写停止哨兵", async () => {
        await expect(cmdStop(tmp, { qq: "all" })).rejects.toThrow(ConfigError);
        await expect(cmdStop(tmp, { qq: "../../escape" })).rejects.toThrow(ConfigError);
        expect(mocks.writeStopSentinel).not.toHaveBeenCalled();
        expect(mocks.listAccountRuntimes).not.toHaveBeenCalled();
    });

    it("cmdRestart 非法 -q → ConfigError，不 detached 拉起", async () => {
        await expect(cmdRestart(tmp, { qq: "../escape" })).rejects.toThrow(ConfigError);
        expect(mocks.spawnDetached).not.toHaveBeenCalled();
    });
});

describe("cmdStop 单账号（-q）", () => {
    it("无运行时状态：报错并置退出码 1", async () => {
        await cmdStop(tmp, { qq: "10001" });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ uin: "10001" }),
            expect.stringContaining("无运行时状态"),
        );
        expect(process.exitCode).toBe(1);
        expect(mocks.writeStopSentinel).not.toHaveBeenCalled();
    });

    it("哨兵优先：写单账号独立哨兵 → 进程已退 → 只清本账号哨兵", async () => {
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 7777)]);
        await cmdStop(tmp, { qq: "10001" });
        expect(mocks.writeAccountStopSentinel).toHaveBeenCalledWith(tmp, "10001");
        expect(mocks.writeStopSentinel).not.toHaveBeenCalled();
        expect(mocks.removeAccountStopSentinel).toHaveBeenCalledWith(tmp, "10001");
        expect(mocks.removeStopSentinel).not.toHaveBeenCalled();
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
    });

    it("并发 stop 不同账号：各写各的独立哨兵，全局哨兵不被触碰", async () => {
        mocks.listAccountRuntimes.mockReturnValue([
            runtimeOf("10001", 7001),
            runtimeOf("20002", 7002),
        ]);
        await cmdStop(tmp, { qq: "10001" });
        await cmdStop(tmp, { qq: "20002" });
        expect(mocks.writeAccountStopSentinel.mock.calls).toEqual([
            [tmp, "10001"],
            [tmp, "20002"],
        ]);
        expect(mocks.removeAccountStopSentinel.mock.calls).toEqual([
            [tmp, "10001"],
            [tmp, "20002"],
        ]);
        expect(mocks.writeStopSentinel).not.toHaveBeenCalled();
        expect(mocks.removeStopSentinel).not.toHaveBeenCalled();
    });

    it("PID 已被复用（命令行不匹配）：跳过树杀，不误杀无关进程", async () => {
        vi.useFakeTimers();
        mocks.isPidAlive.mockReturnValue(true);
        mocks.checkProcessIdentity.mockReturnValue("mismatch");
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 8888)]);
        const stopping = cmdStop(tmp, { qq: "10001" });
        await vi.advanceTimersByTimeAsync(8300);
        await stopping;
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ uin: "10001", pid: 8888 }),
            expect.stringContaining("PID 已被无关进程复用"),
        );
    });

    it("boot 已退出且缺 self-host 指纹：跳过 selfHostPid 树杀（防误杀复用 pid）", async () => {
        vi.useFakeTimers();
        mocks.isPidAlive.mockImplementation((pid: number) => pid === 9999);
        mocks.listAccountRuntimes.mockReturnValue([
            runtimeOf("10001", 8888, { selfHostPid: 9999 }),
        ]);
        const stopping = cmdStop(tmp, { qq: "10001" });
        await vi.advanceTimersByTimeAsync(8300);
        await stopping;
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ uin: "10001", pid: 9999, role: "self-host" }),
            expect.stringContaining("缺少命令行指纹"),
        );
    });

    it("boot 已退出但 self-host 指纹匹配：继续强杀 selfHostPid", async () => {
        vi.useFakeTimers();
        mocks.isPidAlive.mockImplementation((pid: number) => pid === 9999);
        mocks.checkProcessIdentity.mockReturnValue("match");
        mocks.listAccountRuntimes.mockReturnValue([
            runtimeOf("10001", 8888, {
                selfHostPid: 9999,
                selfHostCmdline: "self-host.cjs",
            }),
        ]);
        const stopping = cmdStop(tmp, { qq: "10001" });
        await vi.advanceTimersByTimeAsync(8300);
        await stopping;
        expect(mocks.killProcessTree).toHaveBeenCalledWith(
            9999,
            expect.objectContaining({ extraPids: [] }),
        );
    });

    it("supervisor 在跑时提示 autoRestart 会拉起", async () => {
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 7777)]);
        mocks.readSupervisorRuntime.mockReturnValue({ pid: 123, accounts: [], startedAt: "t" });
        await cmdStop(tmp, { qq: "10001" });
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ supervisorPid: 123 }),
            expect.stringContaining("自动拉起该账号"),
        );
    });
});

describe("cmdStop 全量", () => {
    it("无 supervisor 无账号：仅告警 + 清哨兵", async () => {
        await cmdStop(tmp, {});
        expect(mocks.logger.warn).toHaveBeenCalledWith("supervisor 未运行（无状态文件）");
        expect(mocks.removeStopSentinel).toHaveBeenCalledWith(tmp);
        expect(mocks.writeStopSentinel).not.toHaveBeenCalled();
    });

    it("supervisor 在跑：写 all 哨兵并等待", async () => {
        mocks.readSupervisorRuntime.mockReturnValue({
            pid: 123,
            accounts: ["10001"],
            startedAt: "t",
        });
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 8888)]);
        await cmdStop(tmp, {});
        expect(mocks.writeStopSentinel).toHaveBeenCalledWith(tmp, "all");
        expect(mocks.removeStopSentinel).toHaveBeenCalledWith(tmp);
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
    });

    it("supervisor PID 已复用（命令行不匹配）：跳过树杀", async () => {
        vi.useFakeTimers();
        mocks.isPidAlive.mockReturnValue(true);
        mocks.checkProcessIdentity.mockReturnValue("mismatch");
        mocks.readSupervisorRuntime.mockReturnValue({
            pid: 123,
            accounts: [],
            startedAt: "t",
        });
        const stopping = cmdStop(tmp, {});
        await vi.advanceTimersByTimeAsync(8300);
        await stopping;
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ role: "supervisor", pid: 123 }),
            expect.stringContaining("PID 已被无关进程复用"),
        );
    });

    it("限时未退：树杀兜底 boot pid + selfHostPid（fake timers 压缩 8s 等待）", async () => {
        vi.useFakeTimers();
        mocks.isPidAlive.mockReturnValue(true);
        mocks.listAccountRuntimes.mockReturnValue([
            runtimeOf("10001", 8888, { selfHostPid: 9999 }),
        ]);
        const stopping = cmdStop(tmp, {});
        await vi.advanceTimersByTimeAsync(8300);
        await stopping;
        expect(mocks.killProcessTree).toHaveBeenCalledWith(
            8888,
            expect.objectContaining({ extraPids: [9999] }),
        );
        expect(mocks.removeStopSentinel).toHaveBeenCalledWith(tmp);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ uin: "10001", pids: [8888, 9999] }),
            expect.stringContaining("树杀"),
        );
    });
});

describe("cmdRestart", () => {
    it("stop 同目标后 detached 拉起单账号 boot", async () => {
        vi.useFakeTimers();
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 7777)]);
        const restarting = cmdRestart(tmp, { qq: "10001" });
        await vi.advanceTimersByTimeAsync(1700);
        await restarting;
        expect(mocks.spawnDetached).toHaveBeenCalledWith([
            process.argv[1],
            "-q",
            "10001",
            "--data-dir",
            tmp,
        ]);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ qq: "10001" }),
            expect.stringContaining("detached 拉起"),
        );
    });

    it("前置停止失败（账号未运行）：中断，不再 detached 拉起", async () => {
        await cmdRestart(tmp, { qq: "10001" });
        expect(process.exitCode).toBe(1);
        expect(mocks.spawnDetached).not.toHaveBeenCalled();
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ qq: "10001" }),
            expect.stringContaining("跳过重新拉起"),
        );
    });

    it("process.argv[1] 为空：拒绝拉起空 node 进程", async () => {
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 7777)]);
        const original = process.argv[1] ?? "";
        process.argv[1] = "";
        try {
            await cmdRestart(tmp, { qq: "10001" });
        } finally {
            process.argv[1] = original;
        }
        expect(mocks.spawnDetached).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining("process.argv[1] 为空"),
        );
    });
});
