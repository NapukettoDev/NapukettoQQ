/**
 * instance-lock.test.ts：单实例锁单测（含 2026-09-10 pid 复用根治分支）。
 *
 * mock 策略：
 *   - readCmdlineForPid：vi.mock 替换（复用分支的查询返回值由用例控制）；
 *     normalizeCmdline / selfCmdline / CMDLINE_PROBE_SUPPORTED 保持真实现
 *     （规范化比对规则在被测路径内真实执行）。
 *   - process.kill：vi.spyOn 控制探活结果（不依赖真实进程存在性）。
 *   - fs：真实临时目录（与 bootstrap.test.ts 同套路），锁文件真实读写。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    acquireInstanceLock,
    checkInstanceLock,
    INSTANCE_LOCK_FILE,
    releaseInstanceLock,
} from "../instance-lock.js";
import { CMDLINE_PROBE_SUPPORTED, selfCmdline } from "../pid-cmdline.js";

/** node:fs 写入失败注入（vi.hoisted：mock 工厂内可见；null = 透传真实实现）。 */
const fsWrite = vi.hoisted(() => {
    return { fail: false as boolean };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
            if (fsWrite.fail) {
                throw new Error("EACCES");
            }
            return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
        },
    };
});

const readCmdlineMock = vi.hoisted(() => vi.fn<(pid: number) => string | null>());

vi.mock("../pid-cmdline.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../pid-cmdline.js")>();
    return { ...actual, readCmdlineForPid: readCmdlineMock };
});

let tmpRoot = "";
let dataDir = "";
let killSpy: ReturnType<typeof spyOnKill>;

function spyOnKill() {
    return vi.spyOn(process, "kill");
}

/** 写一个锁文件（模拟既有持有者）。 */
function writeLock(info: { pid: number; startedAt?: number; cmdline?: string }): void {
    writeFileSync(
        join(dataDir, INSTANCE_LOCK_FILE),
        JSON.stringify({
            pid: info.pid,
            startedAt: info.startedAt ?? Date.now(),
            ...(info.cmdline !== undefined ? { cmdline: info.cmdline } : {}),
        }),
        "utf-8",
    );
}

function readLockFile(): { pid: number; cmdline?: string } | null {
    try {
        return JSON.parse(readFileSync(join(dataDir, INSTANCE_LOCK_FILE), "utf-8")) as {
            pid: number;
            cmdline?: string;
        };
    } catch {
        return null;
    }
}

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-lock-test-"));
    dataDir = join(tmpRoot, "account");
    mkdirSync(dataDir, { recursive: true });
    // 缺省探活成功（复用分支被测的前提）；个别用例覆盖为 throw
    killSpy = spyOnKill().mockImplementation(() => true);
    readCmdlineMock.mockReset();
});

afterEach(() => {
    killSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
});

describe("checkInstanceLock：基础判活", () => {
    it("锁不存在 → 可启动", () => {
        const r = checkInstanceLock(dataDir);
        expect(r.occupied).toBe(false);
        expect(r.pid).toBeNull();
    });

    it("锁内容损坏 → 可启动", () => {
        writeFileSync(join(dataDir, INSTANCE_LOCK_FILE), "{not json", "utf-8");
        expect(checkInstanceLock(dataDir).occupied).toBe(false);
    });

    it("pid 无效（0/负数/NaN）→ 可启动", () => {
        writeLock({ pid: 0 });
        expect(checkInstanceLock(dataDir).occupied).toBe(false);
    });

    it("pid 已死（探活失败）→ 崩溃残留，可接管", () => {
        writeLock({ pid: 4242, cmdline: "node self-host.cjs" });
        killSpy.mockImplementation(() => {
            throw new Error("ESRCH");
        });
        expect(checkInstanceLock(dataDir).occupied).toBe(false);
        expect(readCmdlineMock).not.toHaveBeenCalled();
    });
});

describe("checkInstanceLock：pid 复用校验（2026-09-10 根治）", () => {
    // 复用分支仅在支持 cmdline 查询的平台生效（本仓开发/CI 均为 win32）
    it.skipIf(!CMDLINE_PROBE_SUPPORTED)("pid 存活但 cmdline 不一致 → pid 复用，可接管", () => {
        writeLock({ pid: 4242, cmdline: "node.exe C:\\app\\self-host.cjs --uin 123" });
        readCmdlineMock.mockReturnValue("C:\\Windows\\explorer.exe"); // 无关进程
        const r = checkInstanceLock(dataDir);
        expect(r.occupied).toBe(false);
        expect(r.pid).toBeNull();
    });

    it.skipIf(!CMDLINE_PROBE_SUPPORTED)("pid 存活但 cmdline 查询失败 → 视为死亡，可接管", () => {
        writeLock({ pid: 4242, cmdline: "node.exe C:\\app\\self-host.cjs" });
        readCmdlineMock.mockReturnValue(null);
        expect(checkInstanceLock(dataDir).occupied).toBe(false);
    });

    it.skipIf(!CMDLINE_PROBE_SUPPORTED)(
        "pid 存活且 cmdline 一致（引号/大小写/斜杠差异经规范化等价）→ 占用",
        () => {
            writeLock({
                pid: 4242,
                cmdline: "C:\\Node\\NODE.exe C:\\app\\self-host.cjs --uin 123",
            });
            readCmdlineMock.mockReturnValue('"c:/node/node.exe" "c:/app/self-host.cjs" --uin 123');
            const r = checkInstanceLock(dataDir);
            expect(r.occupied).toBe(true);
            expect(r.pid).toBe(4242);
        },
    );

    it("旧锁无 cmdline 摘要（无法校验）→ 保守维持占用", () => {
        writeLock({ pid: 4242 });
        const r = checkInstanceLock(dataDir);
        expect(r.occupied).toBe(true);
        expect(r.pid).toBe(4242);
        expect(readCmdlineMock).not.toHaveBeenCalled();
    });
});

describe("acquireInstanceLock", () => {
    it("无锁 → 获取成功且自动写入本进程 cmdline 摘要", () => {
        expect(acquireInstanceLock(dataDir)).toBe(true);
        const lock = readLockFile();
        expect(lock?.pid).toBe(process.pid);
        expect(lock?.cmdline).toBe(selfCmdline());
    });

    it("显式传入 cmdline → 优先使用", () => {
        expect(acquireInstanceLock(dataDir, "custom marker")).toBe(true);
        expect(readLockFile()?.cmdline).toBe("custom marker");
    });

    it("持有者存活且 cmdline 一致 → 拒绝", () => {
        writeLock({ pid: 4242, cmdline: "holder" });
        readCmdlineMock.mockReturnValue("holder");
        expect(acquireInstanceLock(dataDir)).toBe(false);
        // 锁未被覆盖
        expect(readLockFile()?.pid).toBe(4242);
    });

    it("持有者 pid 复用（cmdline 不一致）→ 接管并重写锁", () => {
        writeLock({ pid: 4242, cmdline: "old holder cmdline" });
        readCmdlineMock.mockReturnValue("some unrelated process");
        expect(acquireInstanceLock(dataDir)).toBe(true);
        expect(readLockFile()?.pid).toBe(process.pid);
    });

    it("占用者是本进程 → 幂等返回 true（不重写）", () => {
        writeLock({ pid: process.pid, cmdline: "me" });
        readCmdlineMock.mockReturnValue("me");
        expect(acquireInstanceLock(dataDir)).toBe(true);
        expect(readLockFile()?.cmdline).toBe("me");
    });
});

describe("releaseInstanceLock", () => {
    it("持有者是本进程 → 删除锁", () => {
        writeLock({ pid: process.pid, cmdline: "me" });
        releaseInstanceLock(dataDir);
        expect(readLockFile()).toBeNull();
    });

    it("持有者是他人（pid 复用/快速重启场景）→ 保留锁", () => {
        writeLock({ pid: 4242, cmdline: "other" });
        releaseInstanceLock(dataDir);
        expect(readLockFile()?.pid).toBe(4242);
    });

    it("锁不存在 → 无操作", () => {
        expect(() => releaseInstanceLock(dataDir)).not.toThrow();
    });
});

describe("锁写入失败（磁盘/权限）", () => {
    it("writeFileSync 抛错 → acquire 返回 false（不假装拿到锁）", () => {
        fsWrite.fail = true;
        try {
            expect(acquireInstanceLock(dataDir, "me")).toBe(false);
        } finally {
            fsWrite.fail = false;
        }
    });
});
