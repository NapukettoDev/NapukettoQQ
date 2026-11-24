/**
 * boot.test.ts：单账号自建宿主启动（runSingleAccount）单测。
 *
 * loader / logger / qr / state / 内联判定全部注入假实现（mock 到边界），
 * 覆盖：QQ 文件定位失败（exitCode 1 不拉起）、单实例锁占用（快速失败）、
 * spawn error 兜底、输出转发（噪音过滤 / QR 标记行渲染 / 坏行静默）、
 * 哨兵与信号触发的优雅停（10s 超时 kill 兜底）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolveQqFiles: vi.fn(),
    checkInstanceLock: vi.fn(),
    defaultStubDir: vi.fn(),
    isNativeNoiseLine: vi.fn(),
    launchSelfHost: vi.fn(),
    watchStopSentinel: vi.fn(),
    writeAccountStopSentinel: vi.fn(),
    isInlineConfigActive: vi.fn(),
    renderQrAnsi: vi.fn(),
    writeAccountRuntime: vi.fn(),
    patchAccountRuntime: vi.fn(),
    killProcessTree: vi.fn(),
    resolveCliLogConfig: vi.fn(),
    effectiveConsoleEnv: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@napuketto/loader", () => ({
    QR_LINE_PREFIX: "NAPUTO_QR ",
    resolveQqFiles: mocks.resolveQqFiles,
    checkInstanceLock: mocks.checkInstanceLock,
    defaultStubDir: mocks.defaultStubDir,
    isNativeNoiseLine: mocks.isNativeNoiseLine,
    launchSelfHost: mocks.launchSelfHost,
    watchStopSentinel: mocks.watchStopSentinel,
    writeAccountStopSentinel: mocks.writeAccountStopSentinel,
}));
vi.mock("../../config/inline.js", () => ({ isInlineConfigActive: mocks.isInlineConfigActive }));
vi.mock("../../logger.js", () => ({
    logger: mocks.logger,
    resolveCliLogConfig: mocks.resolveCliLogConfig,
    effectiveConsoleEnv: mocks.effectiveConsoleEnv,
}));
vi.mock("../qr.js", () => ({ renderQrAnsi: mocks.renderQrAnsi }));
vi.mock("../state.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        writeAccountRuntime: mocks.writeAccountRuntime,
        patchAccountRuntime: mocks.patchAccountRuntime,
        killProcessTree: mocks.killProcessTree,
    };
});

import { runSingleAccount } from "../boot.js";
import { SUPERVISOR_CHILD_ENV } from "../state.js";
import { type FakeChild, flushAsync, makeFakeChild } from "./test-support.js";

let tmp = "";
let child: FakeChild;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let offSpy: ReturnType<typeof vi.spyOn>;
let sentinelCancel: ReturnType<typeof vi.fn>;
const signalHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
let onSpy: ReturnType<typeof vi.spyOn>;
let exitCodeBefore: number | undefined;

/** 清空上一用例残留的信号 handler 捕获（避免跨用例串扰）。 */
function resetSignalHandlers(): void {
    signalHandlers.clear();
}

/** QQ 安装信息假返回值。 */
function fakeQq(): Record<string, unknown> {
    return { version: "9.9.9", qqPath: join(tmp, "QQ.exe"), source: "local" };
}

/** 冲刷异步链直至 launchSelfHost 已调用（等待启动装配完成）。 */
async function untilLaunched(): Promise<void> {
    await vi.waitFor(() => {
        expect(mocks.launchSelfHost).toHaveBeenCalledTimes(1);
    });
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-boot-test-"));
    child = makeFakeChild();
    delete process.env["NAPUKETTO_STUB_DIR"];
    delete process.env[SUPERVISOR_CHILD_ENV];
    process.env["NAPUKETTO_CONFIG"] = join(tmp, "napuketto.toml");
    resetSignalHandlers();
    exitCodeBefore = process.exitCode as number | undefined;
    process.exitCode = undefined;
    for (const fn of [
        mocks.resolveQqFiles,
        mocks.checkInstanceLock,
        mocks.defaultStubDir,
        mocks.isNativeNoiseLine,
        mocks.launchSelfHost,
        mocks.watchStopSentinel,
        mocks.writeAccountStopSentinel,
        mocks.isInlineConfigActive,
        mocks.renderQrAnsi,
        mocks.writeAccountRuntime,
        mocks.patchAccountRuntime,
        mocks.killProcessTree,
        mocks.resolveCliLogConfig,
        mocks.effectiveConsoleEnv,
        ...Object.values(mocks.logger),
    ]) {
        fn.mockReset();
    }
    mocks.resolveQqFiles.mockResolvedValue(fakeQq());
    mocks.checkInstanceLock.mockReturnValue({ occupied: false, pid: null });
    mocks.defaultStubDir.mockReturnValue("/default/stub");
    mocks.isNativeNoiseLine.mockReturnValue(false);
    mocks.isInlineConfigActive.mockReturnValue(false);
    mocks.resolveCliLogConfig.mockReturnValue({ banner: false });
    mocks.effectiveConsoleEnv.mockReturnValue({ NAPUKETTO_LOG_FORMAT: "single-line" });
    mocks.launchSelfHost.mockResolvedValue({ child });
    sentinelCancel = vi.fn();
    mocks.watchStopSentinel.mockReturnValue(sentinelCancel);
    onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: never) => {
        const list = signalHandlers.get(event) ?? [];
        list.push(handler as (...args: unknown[]) => void);
        signalHandlers.set(event, list);
        return process;
    }) as never);
    offSpy = vi.spyOn(process, "off");
    const bound = process.stdout.write.bind(process.stdout);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        bound(chunk);
        return true;
    });
});

afterEach(() => {
    onSpy.mockRestore();
    offSpy.mockRestore();
    stdoutSpy.mockRestore();
    process.exitCode = exitCodeBefore as number | undefined;
    delete process.env["NAPUKETTO_STUB_DIR"];
    delete process.env[SUPERVISOR_CHILD_ENV];
    delete process.env["NAPUKETTO_CONFIG"];
    rmSync(tmp, { recursive: true, force: true });
});

describe("账号目录边界防御（不拉起子进程）", () => {
    it("路径穿越 -q → ConfigError，QQ 文件定位 / 实例锁 / 拉起均不发生", async () => {
        await expect(runSingleAccount({ qq: "../../escape", dataDir: tmp })).rejects.toThrow(
            ConfigError,
        );
        expect(mocks.resolveQqFiles).not.toHaveBeenCalled();
        expect(mocks.checkInstanceLock).not.toHaveBeenCalled();
        expect(mocks.launchSelfHost).not.toHaveBeenCalled();
    });

    it("停止哨兵保留值 all → ConfigError（避免单账号启动污染全局停止）", async () => {
        await expect(runSingleAccount({ qq: "all", dataDir: tmp })).rejects.toThrow(ConfigError);
        expect(mocks.launchSelfHost).not.toHaveBeenCalled();
    });
});

describe("失败前置路径（不拉起子进程）", () => {
    it("QQ 文件定位/下载失败 → 记录可操作提示并置 exitCode 1，不拉起", async () => {
        mocks.resolveQqFiles.mockRejectedValue(new Error("网络不可达"));
        await runSingleAccount({ dataDir: tmp });
        expect(mocks.launchSelfHost).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.anything() }),
            expect.stringContaining("定位/下载 QQ 原生文件失败"),
        );
    });

    it("数据目录实例锁被占用 → 提示占用 PID 并置 exitCode 1，不拉起", async () => {
        mocks.checkInstanceLock.mockReturnValue({ occupied: true, pid: 31337 });
        await runSingleAccount({ qq: "10001", dataDir: tmp });
        expect(mocks.checkInstanceLock).toHaveBeenCalledWith(join(tmp, "10001"));
        expect(mocks.launchSelfHost).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ pid: 31337, dataDir: join(tmp, "10001") }),
            expect.stringContaining("数据目录已被其他实例占用"),
        );
    });
});

describe("运行态落盘与退出等待", () => {
    it("child error（spawn 失败）→ 记录错误并置 exitCode 1（不落 exited）", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.emit("error", new Error("ENOENT"));
        await p;
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.anything() }),
            "自建宿主进程启动失败",
        );
        expect(process.exitCode).toBe(1);
        const statuses = mocks.writeAccountRuntime.mock.calls.map(
            (call) => (call[1] as { status: string }).status,
        );
        expect(statuses).toEqual(["running"]);
    });

    it("非优雅退出 code=1 → 透传 process.exitCode 1（issue #144）", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.emit("exit", 1, null);
        await p;
        expect(process.exitCode).toBe(1);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ code: 1, signal: "none", graceful: false }),
            "自建宿主进程退出",
        );
    });

    it("非优雅退出 code=78 → 透传 process.exitCode 78（supervisor 免重启判定）", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.emit("exit", 78, null);
        await p;
        expect(process.exitCode).toBe(78);
    });

    it("非优雅退出被 signal 杀死（code=null）→ process.exitCode 1", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.emit("exit", null, "SIGKILL");
        await p;
        expect(process.exitCode).toBe(1);
    });

    it("优雅停（isStopping）后退出 → process.exitCode 0，即使 self-host code=1", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        const handler = signalHandlers.get("SIGINT")?.[0] as (signal: string) => void;
        handler("SIGINT");
        child.emit("exit", 1, null);
        await p;
        expect(process.exitCode).toBe(0);
    });

    it("常驻结束统一收尾：解绑三个信号监听 + 取消停止哨兵 watcher", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        expect(signalHandlers.get("SIGINT")).toHaveLength(1);
        child.emit("exit", 0, null);
        await p;
        // watchStopSentinel 返回的取消函数必须被调用（否则哨兵轮询定时器残留）
        expect(sentinelCancel).toHaveBeenCalledOnce();
        for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
            expect(offSpy).toHaveBeenCalledWith(signal, expect.any(Function));
        }
    });

    it("托管模式：合并写入（保留 supervisor 的 kind/restartCount，只补 selfHostPid）", async () => {
        process.env[SUPERVISOR_CHILD_ENV] = "1";
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        expect(mocks.writeAccountRuntime).not.toHaveBeenCalled();
        expect(mocks.patchAccountRuntime).toHaveBeenCalledWith(
            tmp,
            "10001",
            expect.objectContaining({ pid: process.pid, status: "running", selfHostPid: 4242 }),
            expect.objectContaining({ kind: "supervisor-child", restartCount: 0 }),
        );
        child.emit("exit", 0);
        await p;
        expect(mocks.patchAccountRuntime).toHaveBeenLastCalledWith(
            tmp,
            "10001",
            expect.objectContaining({ status: "exited", exitCode: 0, selfHostPid: 4242 }),
            expect.objectContaining({ kind: "supervisor-child" }),
        );
        // 非托管路径（完整覆盖 single-boot）不得触发
        expect(mocks.writeAccountRuntime).not.toHaveBeenCalled();
    });
});

describe("输出转发（forwardFiltered）", () => {
    it("普通行转发 stdout；原生噪音行被过滤", async () => {
        mocks.isNativeNoiseLine.mockImplementation((line: string) => line === "MMKV noise");
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.stdout.write("普通日志行\n");
        child.stdout.write("MMKV noise\n");
        await flushAsync();
        const text = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
        expect(text).toContain("普通日志行");
        expect(text).not.toContain("MMKV noise");
        child.emit("exit", 0);
        await p;
    });

    it("NAPUTO_QR 标记行 → 解析 url 并渲染终端二维码（不透传原文）", async () => {
        mocks.renderQrAnsi.mockReturnValue("QR-ANSI-ART");
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.stdout.write(`NAPUTO_QR ${JSON.stringify({ qrcodeUrl: "https://qr.example/x" })}\n`);
        await flushAsync();
        expect(mocks.renderQrAnsi).toHaveBeenCalledWith("https://qr.example/x");
        const text = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
        expect(text).toContain("QR-ANSI-ART");
        expect(text).not.toContain("https://qr.example/x");
        child.emit("exit", 0);
        await p;
    });

    it("QR 坏行（非 JSON / 无 url / 空 url）静默丢弃，不影响转发", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        child.stdout.write("NAPUTO_QR not-json\n");
        child.stdout.write(`NAPUTO_QR ${JSON.stringify({ foo: 1 })}\n`);
        child.stdout.write(`NAPUTO_QR ${JSON.stringify({ qrcodeUrl: "" })}\n`);
        child.stdout.write("tail line\n");
        await flushAsync();
        expect(mocks.renderQrAnsi).not.toHaveBeenCalled();
        const text = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
        expect(text).toContain("tail line");
        expect(text).not.toContain("not-json");
        child.emit("exit", 0);
        await p;
    });
});

describe("优雅停（哨兵 / 信号 / 超时兜底）", () => {
    it("停止哨兵触发 → 记录等待日志；10s 未退出则 kill 兜底", async () => {
        vi.useFakeTimers();
        try {
            const p = runSingleAccount({ qq: "10001", dataDir: tmp });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.launchSelfHost).toHaveBeenCalledTimes(1);
            const watchOpts = mocks.watchStopSentinel.mock.calls[0]?.[0] as {
                dataRoot: string;
                account: string;
                onTrigger: () => void;
            };
            expect(watchOpts.dataRoot).toBe(tmp);
            expect(watchOpts.account).toBe("10001");
            watchOpts.onTrigger();
            expect(mocks.logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ account: "10001", reason: "停止哨兵" }),
                "收到停止请求，等待自建宿主退出",
            );
            await vi.advanceTimersByTimeAsync(10_000);
            expect(mocks.killProcessTree).toHaveBeenCalledWith(
                4242,
                expect.objectContaining({ onError: expect.any(Function) }),
            );
            expect(mocks.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ account: "10001" }),
                "自建宿主未在限时内退出，强制结束",
            );
            child.emit("exit", 0);
            await p;
        } finally {
            vi.useRealTimers();
        }
    });

    it("SIGINT → 写停止哨兵 + 进入优雅停等待（退出日志 graceful 标注）", async () => {
        const p = runSingleAccount({ qq: "10001", dataDir: tmp });
        await untilLaunched();
        expect(signalHandlers.has("SIGINT")).toBe(true);
        expect(signalHandlers.has("SIGTERM")).toBe(true);
        const handler = signalHandlers.get("SIGINT")?.[0] as (signal: string) => void;
        handler("SIGINT");
        expect(mocks.writeAccountStopSentinel).toHaveBeenCalledWith(tmp, "10001");
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "信号 SIGINT" }),
            "收到停止请求，等待自建宿主退出",
        );
        child.emit("exit", 0);
        await p;
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ graceful: true }),
            "自建宿主进程退出",
        );
    });

    it("已自行退出（exitCode 非空）后超时兜底不重复 kill", async () => {
        vi.useFakeTimers();
        try {
            const p = runSingleAccount({ qq: "10001", dataDir: tmp });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(0);
            const watchOpts = mocks.watchStopSentinel.mock.calls[0]?.[0] as {
                onTrigger: () => void;
            };
            watchOpts.onTrigger();
            child.exitCode = 0;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(mocks.killProcessTree).not.toHaveBeenCalled();
            child.emit("exit", 0);
            await p;
        } finally {
            vi.useRealTimers();
        }
    });
});
