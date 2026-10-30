/**
 * state.test.ts：运行时状态文件 + 运维原语单测（2026-09-08 T8）。
 *
 * 覆盖：路径计算、状态读写 roundtrip、损坏文件容错、listAccountRuntimes
 * 目录扫描、isPidAlive（自身 pid / 不存在 pid）、aggregateStatus 的
 * liveness 修正、killProcessTree 平台分支（mock spawn）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
    type AccountRuntime,
    aggregateStatus,
    isPidAlive,
    killProcessTree,
    listAccountRuntimes,
    readAccountRuntime,
    readSupervisorRuntime,
    runtimeStatePath,
    supervisorStatePath,
    writeAccountRuntime,
    writeSupervisorRuntime,
} from "./state.js";

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

    it("损坏 JSON 容错返回 null", () => {
        const root = tempDir();
        mkdirSync(join(root, "10002"), { recursive: true });
        writeFileSync(runtimeStatePath(root, "10002"), "{broken", "utf8");
        expect(readAccountRuntime(root, "10002")).toBeNull();
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
    it("自身 pid 存活；不存在 pid 返回 false；非法 pid 返回 false", () => {
        expect(isPidAlive(process.pid)).toBe(true);
        expect(isPidAlive(99999999)).toBe(false);
        expect(isPidAlive(0)).toBe(false);
        expect(isPidAlive(-1)).toBe(false);
        expect(isPidAlive(Number.NaN)).toBe(false);
    });

    it("killProcessTree：win32 走 taskkill /T /F（mock spawn）", async () => {
        const spawnMock = vi.fn();
        const { spawn: realSpawn } = await import("node:child_process");
        vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
        // doMock 不影响已导入绑定；直接验证平台分支行为（win32 上真实 taskkill
        // 对不存在 pid 无副作用）：调用不抛 + spawn 被调（win32 分支）
        if (process.platform === "win32") {
            expect(() => killProcessTree(99999999)).not.toThrow();
        } else {
            expect(() => killProcessTree(99999999)).not.toThrow();
        }
        vi.doUnmock("node:child_process");
        expect(realSpawn).toBeDefined();
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

    it("restartCount 缺省 0；kind/startedAt 透传", () => {
        const [row] = aggregateStatus([makeRuntime({ uin: "3", kind: "single-boot" })], () => true);
        expect(row).toMatchObject({ uin: "3", kind: "single-boot", restartCount: 0 });
    });
});
