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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRuntime } from "../runtime/state.js";

const mocks = vi.hoisted(() => ({
    writeStopSentinel: vi.fn(),
    removeStopSentinel: vi.fn(),
    isPidAlive: vi.fn(),
    killProcessTree: vi.fn(),
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
    };
});
vi.mock("../runtime/state.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        isPidAlive: mocks.isPidAlive,
        killProcessTree: mocks.killProcessTree,
        listAccountRuntimes: mocks.listAccountRuntimes,
        readSupervisorRuntime: mocks.readSupervisorRuntime,
        aggregateStatus: mocks.aggregateStatus,
        spawnDetached: mocks.spawnDetached,
    };
});
vi.mock("../logger.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, logger: mocks.logger };
});

import { cmdRestart, cmdStatus, cmdStop } from "./ops.js";

let tmp = "";

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-ops-test-"));
    for (const fn of [
        mocks.writeStopSentinel,
        mocks.removeStopSentinel,
        mocks.isPidAlive,
        mocks.killProcessTree,
        mocks.listAccountRuntimes,
        mocks.readSupervisorRuntime,
        mocks.aggregateStatus,
        mocks.spawnDetached,
        ...Object.values(mocks.logger),
    ]) {
        fn.mockReset();
    }
    mocks.isPidAlive.mockReturnValue(false);
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
function runtimeOf(uin: string, pid: number): AccountRuntime {
    return {
        uin,
        pid,
        startedAt: "2026-10-25T00:00:00.000Z",
        kind: "supervisor-child",
        status: "running",
        restartCount: 0,
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

    it("supervisor 运行中 + 账号行聚合输出", () => {
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
                kind: "supervisor-child",
                startedAt: "t",
                restartCount: 0,
            },
        ]);
        cmdStatus(tmp, {});
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ pid: 123 }),
            "supervisor",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ uin: "10001", alive: true }),
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

    it("哨兵优先：写单账号哨兵 → 进程已退 → 清哨兵", async () => {
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 7777)]);
        await cmdStop(tmp, { qq: "10001" });
        expect(mocks.writeStopSentinel).toHaveBeenCalledWith(tmp, "10001");
        expect(mocks.removeStopSentinel).toHaveBeenCalledWith(tmp);
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
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

    it("限时未退：树杀兜底（fake timers 压缩 8s 等待）", async () => {
        vi.useFakeTimers();
        mocks.isPidAlive.mockReturnValue(true);
        mocks.listAccountRuntimes.mockReturnValue([runtimeOf("10001", 8888)]);
        const stopping = cmdStop(tmp, {});
        await vi.advanceTimersByTimeAsync(8300);
        await stopping;
        expect(mocks.killProcessTree).toHaveBeenCalledWith(8888);
        expect(mocks.removeStopSentinel).toHaveBeenCalledWith(tmp);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ uin: "10001", pid: 8888 }),
            expect.stringContaining("树杀"),
        );
    });
});

describe("cmdRestart", () => {
    it("stop 同目标后 detached 拉起单账号 boot", async () => {
        vi.useFakeTimers();
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
});
