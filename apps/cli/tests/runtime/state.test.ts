/**
 * state.test.ts：运行时状态文件 + 运维原语单测（2026-09-08 T8）。
 *
 * 覆盖：路径计算、状态读写 roundtrip、原子替换（无 .tmp 残留 / 失败清理）、
 * 托管模式合并写入、损坏文件容错、listAccountRuntimes 目录扫描、isPidAlive
 * （自身 pid / 不存在 pid）、PID 身份校验、POSIX 强杀信号升级、
 * aggregateStatus 的 liveness 修正。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const loaderMocks = vi.hoisted(() => ({ readCmdlineForPid: vi.fn() }));

vi.mock("@napuketto/loader", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        // 固定可控探针：不真的走 PowerShell / /proc，用例跨平台确定。
        CMDLINE_PROBE_SUPPORTED: true,
        readCmdlineForPid: loaderMocks.readCmdlineForPid,
    };
});

import {
    type AccountRuntime,
    aggregateStatus,
    checkProcessIdentity,
    isPidAlive,
    killProcessTree,
    listAccountRuntimes,
    patchAccountRuntime,
    readAccountRuntime,
    readSupervisorRuntime,
    runtimeStatePath,
    supervisorStatePath,
    writeAccountRuntime,
    writeSupervisorRuntime,
} from "../../src/runtime/state.js";

let tmpRoot = "";

function tempDir(): string {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-runtime-"));
    }
    return tmpRoot;
}

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

function makeRuntime(overrides: Partial<AccountRuntime> = {}): AccountRuntime {
    return {
        uin: "10001",
        pid: 12345,
        startedAt: "2026-09-08T00:00:00.000Z",
        kind: "supervisor-child",
        status: "running",
        ...overrides,
    };
}

describe("runtime-state 读写", () => {
    it("路径计算：数据根/<uin>/runtime.json 与 supervisor.json", () => {
        expect(runtimeStatePath("C:/data", "10001").replaceAll("\\", "/")).toBe(
            "C:/data/10001/runtime.json",
        );
        expect(supervisorStatePath("C:/data").replaceAll("\\", "/")).toBe(
            "C:/data/supervisor.json",
        );
        // 相对数据根保持相对返回（边界校验用绝对路径，但不改变既有路径语义）
        expect(runtimeStatePath(".napuketto", "10001")).toBe(
            join(".napuketto", "10001", "runtime.json"),
        );
    });

    it("账号路径边界：绝对路径 / 分隔符 / .. → ConfigError（不逃出数据根）", () => {
        for (const uin of ["../escape", "..", ".", "/abs", "a/b", "a\\b"]) {
            expect(() => runtimeStatePath("C:/data", uin)).toThrow(ConfigError);
        }
    });

    it("writeAccountRuntime 拒绝越界 uin（不落盘到数据根之外）", () => {
        expect(() => writeAccountRuntime(tempDir(), makeRuntime({ uin: "../escape" }))).toThrow(
            ConfigError,
        );
    });

    it("账号状态 roundtrip（含可选字段保留）", () => {
        const root = tempDir();
        const state = makeRuntime({ selfHostPid: 999, restartCount: 3 });
        writeAccountRuntime(root, state);
        expect(readAccountRuntime(root, "10001")).toEqual(state);
    });

    it("supervisor 状态 roundtrip；缺失返回 null", () => {
        const root = tempDir();
        expect(readSupervisorRuntime(root)).toBeNull();
        writeSupervisorRuntime(root, { pid: 42, startedAt: "t", accounts: ["1", "2"] });
        expect(readSupervisorRuntime(root)).toEqual({
            pid: 42,
            startedAt: "t",
            accounts: ["1", "2"],
        });
    });

    it("supervisor 状态首写自动建数据根（新目录 start 不再 ENOENT）", () => {
        const root = join(tempDir(), "fresh-root");
        writeSupervisorRuntime(root, { pid: 43, startedAt: "t", accounts: [] });
        expect(readSupervisorRuntime(root)).toEqual({
            pid: 43,
            startedAt: "t",
            accounts: [],
        });
    });

    it("原子替换：覆盖后读到新内容，目录内无 .tmp 残留", () => {
        const root = tempDir();
        writeAccountRuntime(root, makeRuntime({ restartCount: 1 }));
        writeAccountRuntime(root, makeRuntime({ restartCount: 7 }));
        expect(readAccountRuntime(root, "10001")).toMatchObject({ restartCount: 7 });
        expect(readdirSync(join(root, "10001"))).toEqual(["runtime.json"]);
        writeSupervisorRuntime(root, { pid: 44, startedAt: "t", accounts: [] });
        writeSupervisorRuntime(root, { pid: 45, startedAt: "t", accounts: [] });
        expect(readSupervisorRuntime(root)).toMatchObject({ pid: 45 });
        expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("替换失败（目标被目录占用）：清理临时文件并抛出原始错误", () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-runtime-atomic-"));
        try {
            // 目标路径被目录占用 → rename 替换失败（POSIX EISDIR / Windows EPERM）
            mkdirSync(join(root, "10001", "runtime.json"), { recursive: true });
            expect(() => writeAccountRuntime(root, makeRuntime())).toThrow();
            expect(
                readdirSync(join(root, "10001")).filter((name) => name.endsWith(".tmp")),
            ).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("损坏 JSON 容错返回 null", () => {
        const root = tempDir();
        mkdirSync(join(root, "10002"), { recursive: true });
        writeFileSync(runtimeStatePath(root, "10002"), "{broken", "utf8");
        expect(readAccountRuntime(root, "10002")).toBeNull();
    });

    it("结构损坏（合法 JSON 但字段缺失 / 类型错 / 非法枚举）→ null（严格形状守卫）", () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-runtime-shape-"));
        const writeAccount = (uin: string, body: unknown): void => {
            mkdirSync(join(root, uin), { recursive: true });
            writeFileSync(runtimeStatePath(root, uin), JSON.stringify(body), "utf8");
        };
        writeAccount("10003", { uin: "10003", pid: "12345", startedAt: "t" });
        writeAccount("10004", { uin: "10004", pid: -1, startedAt: "t" });
        writeAccount("10005", {
            uin: "10005",
            pid: 1,
            startedAt: "t",
            kind: "bogus",
            status: "running",
        });
        for (const uin of ["10003", "10004", "10005"]) {
            expect(readAccountRuntime(root, uin)).toBeNull();
        }
        writeFileSync(
            supervisorStatePath(root),
            JSON.stringify({ pid: 1, startedAt: "t", accounts: [1] }),
            "utf8",
        );
        expect(readSupervisorRuntime(root)).toBeNull();
        rmSync(root, { recursive: true, force: true });
    });

    it("selfHostPid 类型/范围非法 → 整个状态判非法（不把任意值当 PID）", () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-runtime-pid-"));
        const writeAccount = (uin: string, selfHostPid: unknown): void => {
            mkdirSync(join(root, uin), { recursive: true });
            writeFileSync(
                runtimeStatePath(root, uin),
                JSON.stringify({
                    uin,
                    pid: 123,
                    selfHostPid,
                    startedAt: "t",
                    kind: "single-boot",
                    status: "running",
                }),
                "utf8",
            );
        };
        writeAccount("30001", 222);
        expect(readAccountRuntime(root, "30001")).toMatchObject({ pid: 123, selfHostPid: 222 });
        for (const [index, value] of [
            "222",
            0,
            -1,
            1.5,
            Number.NaN,
            0x7fffffff + 1,
            null,
        ].entries()) {
            const uin = `3001${index}`;
            writeAccount(uin, value);
            expect(readAccountRuntime(root, uin)).toBeNull();
        }
        rmSync(root, { recursive: true, force: true });
    });

    it("listAccountRuntimes 扫描数据根一级目录（跳过无状态目录）", () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-runtime-list-"));
        writeAccountRuntime(root, makeRuntime({ uin: "20001" }));
        writeAccountRuntime(root, makeRuntime({ uin: "20002", status: "exited" }));
        writeFileSync(join(root, "20003.log"), "x"); // 非目录项
        const list = listAccountRuntimes(root)
            .map((r) => r.uin)
            .sort();
        expect(list).toEqual(["20001", "20002"]);
        expect(listAccountRuntimes(join(root, "nope"))).toEqual([]);
    });
});

describe("isPidAlive / killProcessTree", () => {
    it("自身 pid 存活；不存在 pid / 非法类型返回 false", () => {
        expect(isPidAlive(process.pid)).toBe(true);
        expect(isPidAlive(99999999)).toBe(false);
        expect(isPidAlive(0)).toBe(false);
        expect(isPidAlive(-1)).toBe(false);
        expect(isPidAlive(Number.NaN)).toBe(false);
    });

    it("超出 PID 范围 / 小数不调用 process.kill（保留合法存活探测）", () => {
        const kill = vi.spyOn(process, "kill");
        try {
            expect(isPidAlive(0x7fffffff + 1)).toBe(false);
            expect(isPidAlive(Number.MAX_SAFE_INTEGER)).toBe(false);
            expect(isPidAlive(1.5)).toBe(false);
            expect(kill).not.toHaveBeenCalled();
            expect(isPidAlive(process.pid)).toBe(true);
            expect(kill).toHaveBeenCalledWith(process.pid, 0);
        } finally {
            kill.mockRestore();
        }
    });
});

describe("aggregateStatus", () => {
    it("liveness 修正：文件 running 但 pid 死 → alive=false；exited 恒 false", () => {
        const rows = aggregateStatus(
            [
                makeRuntime({ uin: "1", pid: 11 }),
                makeRuntime({ uin: "2", pid: 22, status: "exited", exitCode: 1 }),
            ],
            (pid) => pid === 11,
        );
        expect(rows[0]).toMatchObject({ uin: "1", alive: true, restartCount: 0 });
        expect(rows[1]).toMatchObject({ uin: "2", alive: false, exitCode: 1 });
    });

    it("restartCount 缺省 0；kind/startedAt/selfHostPid 透传", () => {
        const [row] = aggregateStatus(
            [makeRuntime({ uin: "3", kind: "single-boot", selfHostPid: 77 })],
            () => true,
        );
        expect(row).toMatchObject({
            uin: "3",
            kind: "single-boot",
            restartCount: 0,
            selfHostPid: 77,
        });
    });
});

describe("patchAccountRuntime（托管模式合并写入）", () => {
    it("保留 supervisor 的 kind/restartCount/cmdline，补充 selfHostPid", () => {
        const root = tempDir();
        writeAccountRuntime(
            root,
            makeRuntime({
                uin: "30001",
                pid: 111,
                restartCount: 4,
                cmdline: "entry.mjs -q 30001 --data-dir x",
            }),
        );
        patchAccountRuntime(
            root,
            "30001",
            {
                pid: 111,
                selfHostPid: 222,
                selfHostCmdline: "self-host.cjs",
                status: "running",
            },
            makeRuntime({ uin: "30001", pid: 111 }),
        );
        expect(readAccountRuntime(root, "30001")).toMatchObject({
            kind: "supervisor-child",
            restartCount: 4,
            selfHostPid: 222,
            selfHostCmdline: "self-host.cjs",
            cmdline: "entry.mjs -q 30001 --data-dir x",
            status: "running",
        });
    });

    it("running 丢弃上一轮 exitCode；exited 保留 selfHostPid 并写退出码", () => {
        const root = tempDir();
        writeAccountRuntime(
            root,
            makeRuntime({
                uin: "30002",
                status: "exited",
                exitCode: 1,
                restartCount: 2,
                selfHostPid: 5,
            }),
        );
        patchAccountRuntime(
            root,
            "30002",
            { status: "running", restartCount: 2 },
            makeRuntime({ uin: "30002" }),
        );
        expect(readAccountRuntime(root, "30002")?.exitCode).toBeUndefined();
        patchAccountRuntime(
            root,
            "30002",
            { status: "exited", exitCode: 78 },
            makeRuntime({ uin: "30002" }),
        );
        expect(readAccountRuntime(root, "30002")).toMatchObject({
            status: "exited",
            exitCode: 78,
            selfHostPid: 5,
            restartCount: 2,
        });
    });

    it("无现有状态时用 fallback 落盘", () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-runtime-patch-"));
        try {
            patchAccountRuntime(
                root,
                "30003",
                { status: "exited", exitCode: 78 },
                makeRuntime({ uin: "30003", restartCount: 1 }),
            );
            expect(readAccountRuntime(root, "30003")).toMatchObject({
                kind: "supervisor-child",
                status: "exited",
                exitCode: 78,
                restartCount: 1,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("checkProcessIdentity（PID 复用校验）", () => {
    beforeEach(() => {
        loaderMocks.readCmdlineForPid.mockReset();
    });

    it("无指纹 / 空指纹 → unverified（不查询命令行）", () => {
        expect(checkProcessIdentity(process.pid, undefined)).toBe("unverified");
        expect(checkProcessIdentity(process.pid, "")).toBe("unverified");
        expect(loaderMocks.readCmdlineForPid).not.toHaveBeenCalled();
    });

    it("PID 类型/范围非法 → mismatch，且不查询命令行", () => {
        for (const pid of [0, -1, 1.5, Number.NaN, 0x7fffffff + 1]) {
            expect(checkProcessIdentity(pid, "index.mjs")).toBe("mismatch");
        }
        expect(loaderMocks.readCmdlineForPid).not.toHaveBeenCalled();
    });

    it("指纹出现在目标命令行中 → match（对可执行文件路径/引号不敏感）", () => {
        loaderMocks.readCmdlineForPid.mockReturnValue(
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\index.mjs" -q 10001 --data-dir "C:\\data"',
        );
        expect(checkProcessIdentity(123, "index.mjs -q 10001 --data-dir C:/data")).toBe("match");
    });

    it("命令行不匹配 / 查不到 → mismatch（PID 已被复用）", () => {
        loaderMocks.readCmdlineForPid.mockReturnValue("C:\\Windows\\notepad.exe");
        expect(checkProcessIdentity(123, "-q 10001 --data-dir C:/data")).toBe("mismatch");
        loaderMocks.readCmdlineForPid.mockReturnValue(null);
        expect(checkProcessIdentity(123, "-q 10001 --data-dir C:/data")).toBe("mismatch");
    });
});

describe("killProcessTree（POSIX 信号升级）", () => {
    it.runIf(process.platform !== "win32")(
        "SIGTERM 后宽限结束仍存活 → 对进程组与单进程补 SIGKILL（含 extraPids）",
        () => {
            vi.useFakeTimers();
            const calls: Array<{ target: number; signal: number | NodeJS.Signals }> = [];
            const killSpy = vi.spyOn(process, "kill").mockImplementation(((
                target: number,
                signal?: number | NodeJS.Signals,
            ) => {
                calls.push({ target, signal: signal ?? 0 });
                return true;
            }) as typeof process.kill);
            try {
                killProcessTree(4321, { extraPids: [4322], graceMs: 100 });
                expect(calls).toEqual(
                    expect.arrayContaining([
                        { target: -4321, signal: "SIGTERM" },
                        { target: 4321, signal: "SIGTERM" },
                        { target: -4322, signal: "SIGTERM" },
                        { target: 4322, signal: "SIGTERM" },
                    ]),
                );
                expect(calls.some((call) => call.signal === "SIGKILL")).toBe(false);
                vi.advanceTimersByTime(100);
                expect(calls).toEqual(
                    expect.arrayContaining([
                        { target: -4321, signal: "SIGKILL" },
                        { target: 4321, signal: "SIGKILL" },
                        { target: -4322, signal: "SIGKILL" },
                        { target: 4322, signal: "SIGKILL" },
                    ]),
                );
            } finally {
                killSpy.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it.runIf(process.platform !== "win32")("目标已退出（ESRCH）→ 不补 SIGKILL", () => {
        vi.useFakeTimers();
        const calls: Array<{ target: number; signal: number | NodeJS.Signals }> = [];
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((
            target: number,
            signal?: number | NodeJS.Signals,
        ) => {
            const effective = signal ?? 0;
            calls.push({ target, signal: effective });
            if (effective === 0) {
                const err = new Error("ESRCH") as NodeJS.ErrnoException;
                err.code = "ESRCH";
                throw err;
            }
            return true;
        }) as typeof process.kill);
        try {
            killProcessTree(4321, { graceMs: 100 });
            vi.advanceTimersByTime(100);
            expect(calls.some((call) => call.signal === "SIGKILL")).toBe(false);
        } finally {
            killSpy.mockRestore();
            vi.useRealTimers();
        }
    });
});
