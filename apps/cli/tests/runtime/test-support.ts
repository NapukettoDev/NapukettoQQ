/**
 * cli 子域公共测试夹具（test-support）：
 * 微任务冲刷与伪子进程——boot.test.ts 的复用夹具。
 * 只放跨测试文件复用的最小夹具；单文件私有 setup 留在各自测试文件里。
 *
 * 位置跟随使用方：目前只有同目录的 boot.test.ts 用它，故与其同放
 * `tests/runtime/`，与其余包「夹具贴近使用方测试」的布局一致。将来若被
 * 跨目录复用，再上移一级。覆盖率由 vitest 配置的 `tests/` 目录排除覆盖。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

/** 冲刷微任务/Immediate 队列（commander async action 等异步桩落地）。 */
export function flushAsync(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

/** 伪子进程形态（boot 拉起路径用）。 */
export interface FakeChild extends EventEmitter {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
}

/** 构造伪子进程（stdout/stderr 为可写流，kill 可断言）。 */
export function makeFakeChild(pid = 4242): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = pid;
    child.exitCode = null;
    child.killed = false;
    child.kill = vi.fn(() => {
        child.killed = true;
        return true;
    }) as FakeChild["kill"];
    return child;
}
