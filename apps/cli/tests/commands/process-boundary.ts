import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";
import { mock } from "node:test";

const tracePath = process.env["CLI_TEST_TRACE"];
const fixturePids = process.env["CLI_TEST_PIDS"];
assert.ok(tracePath && fixturePids !== undefined);
const allowedPids = new Set(fixturePids.split(",").map(Number));

const recordTermination = (pid: number, ...args: string[]): void => {
    assert.ok(allowedPids.has(Math.abs(pid)), `Unexpected termination target ${pid}`);
    appendFileSync(tracePath, `${JSON.stringify(["terminate", pid, ...args])}\n`);
};

const probe = process.kill.bind(process);
mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (signal === 0) {
        return probe(pid, signal);
    }
    recordTermination(pid, String(signal));
    return true;
});

const spawn = childProcess.spawn;
mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
    if (command === "taskkill") {
        recordTermination(Number(args[1]), ...args);
    } else {
        assert.equal(command, process.execPath);
        assert.equal(options.detached, true);
        appendFileSync(tracePath, `${JSON.stringify(["restart", ...args])}\n`);
    }
    return spawn(process.execPath, ["--eval", ""], { stdio: "ignore", windowsHide: true });
});

// CLI 的 ESM 命名导入需要同步到已经替换的 Node 内置方法。
syncBuiltinESMExports();
