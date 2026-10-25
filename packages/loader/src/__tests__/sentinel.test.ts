/**
 * sentinel.test.ts：停止哨兵单测（2026-10-25 优雅关停）。
 *
 * 覆盖：all/空内容触发、单账号内容精确匹配、他人账号不触发、陈旧 mtime
 * 不触发（utimes 回拨模拟进程启动前遗留）、一次性触发、取消观察。
 * 轮询间隔注入 10ms 加速。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { stopSentinelPath, watchStopSentinel, writeStopSentinel } from "../shutdown.js";

let tmpRoot = "";
afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

function freshDir(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-sentinel-test-"));
    return tmpRoot;
}

/** 等待哨兵轮询若干轮。 */
async function settle(ms = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("writeStopSentinel / watchStopSentinel", () => {
    it("all 内容触发；触发一次后不再触发", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
        // 二次写入不重复触发（一次性守卫）
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("空内容 = all（宿主 touch 文件即可）", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        writeFileSync(stopSentinelPath(dir), "", "utf8");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("单账号内容精确匹配；他人账号不触发", async () => {
        const dir = freshDir();
        const mine = vi.fn();
        const other = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger: mine, pollMs: 10 });
        watchStopSentinel({ dataRoot: dir, account: "20000", onTrigger: other, pollMs: 10 });
        writeStopSentinel(dir, "10000");
        await settle();
        expect(mine).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();
    });

    it("无 account 的观察者只响应 all/空", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, onTrigger, pollMs: 10 });
        writeStopSentinel(dir, "10000");
        await settle();
        expect(onTrigger).not.toHaveBeenCalled();
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("陈旧哨兵（mtime 早于进程启动）不触发——守护重启安全", async () => {
        const dir = freshDir();
        const path = stopSentinelPath(dir);
        writeFileSync(path, "all\n", "utf8");
        // 回拨 mtime 到进程启动前（performance.timeOrigin 之前）
        utimesSync(path, new Date(0), new Date(0));
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        await settle(120);
        expect(onTrigger).not.toHaveBeenCalled();
    });

    it("取消观察后不再触发", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        const cancel = watchStopSentinel({
            dataRoot: dir,
            account: "10000",
            onTrigger,
            pollMs: 10,
        });
        cancel();
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).not.toHaveBeenCalled();
    });
});
