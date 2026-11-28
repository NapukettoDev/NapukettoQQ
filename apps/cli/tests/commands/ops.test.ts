import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { expect } from "vitest";
import type { AccountRuntime, SupervisorRuntime } from "../../src/runtime/state-store.js";
import { cliEntry, cliTest, inheritedEnv } from "./support.js";

const UIN = "10001";
const FIXTURE_ARG = "cli-ops-process-fixture";
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const PRELOAD = new URL("./process-boundary.ts", import.meta.url).href;
const supportsCmdline = process.platform === "win32" || process.platform === "linux";

interface TargetProcess {
    child: ChildProcess;
    closed: Promise<void>;
}

interface OpsFixture {
    target(exited?: boolean): Promise<number>;
    account(pid: number, fields: AccountFields): Promise<void>;
    supervisor(pid: number, cmdline?: string): Promise<void>;
    run(command: "stop" | "restart"): Promise<{ stdout: string; actions: string[] }>;
}

type AccountFields = Pick<AccountRuntime, "cmdline" | "selfHostPid" | "selfHostCmdline">;

const opsTest = cliTest.extend<{ ops: OpsFixture }>({
    ops: async ({ cli }, use) => {
        const targets: TargetProcess[] = [];
        const tracePath = join(cli.root, "actions.jsonl");
        await mkdir(cli.dataDir);
        await writeFile(tracePath, "");

        try {
            await use({
                async target(exited = false) {
                    const code = exited ? "" : "setInterval(() => {}, 1000)";
                    const child = spawn(process.execPath, ["--eval", code, "--", FIXTURE_ARG], {
                        stdio: "ignore",
                        windowsHide: true,
                        env: inheritedEnv,
                    });
                    const closed = new Promise<void>((resolve) => child.once("close", resolve));
                    targets.push({ child, closed });
                    await once(child, "spawn");
                    const pid = child.pid;
                    if (pid === undefined) {
                        throw new Error("Fixture process has no PID");
                    }
                    if (exited) {
                        await closed;
                    }
                    return pid;
                },
                async account(pid, fields) {
                    const state: AccountRuntime = {
                        uin: UIN,
                        pid,
                        kind: "single-boot",
                        status: "running",
                        startedAt: STARTED_AT,
                        ...fields,
                    };
                    const path = join(cli.dataDir, UIN, "runtime.json");
                    await mkdir(dirname(path));
                    await writeFile(path, JSON.stringify(state));
                },
                async supervisor(pid, cmdline) {
                    const state: SupervisorRuntime = {
                        pid,
                        accounts: [UIN],
                        startedAt: STARTED_AT,
                        ...(cmdline === undefined ? {} : { cmdline }),
                    };
                    await writeFile(join(cli.dataDir, "supervisor.json"), JSON.stringify(state));
                },
                async run(command) {
                    const env = {
                        CLI_TEST_TRACE: tracePath,
                        CLI_TEST_PIDS: targets.map(({ child }) => child.pid).join(","),
                    };
                    const result = await cli.run([command], env, ["--import", PRELOAD]);
                    expect(result.code, result.stdout + result.stderr).toBe(0);
                    const actions = (await readFile(tracePath, "utf8"))
                        .trim()
                        .split("\n")
                        .filter(Boolean);
                    return { stdout: result.stdout, actions };
                },
            });
        } finally {
            for (const { child, closed } of targets) {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill();
                }
                await closed;
            }
        }
    },
});

function terminationActions(pid: number): string[] {
    if (process.platform === "win32") {
        return [JSON.stringify(["terminate", pid, "/PID", String(pid), "/T", "/F"])];
    }
    return [-pid, pid].map((target) => JSON.stringify(["terminate", target, "SIGTERM"]));
}

opsTest.runIf(supportsCmdline)(
    "stop 跳过命令行不匹配的 supervisor",
    { timeout: 40_000, concurrent: true },
    async ({ cli, ops }) => {
        const pid = await ops.target();
        await ops.supervisor(pid, "unrelated-supervisor-fingerprint");

        const { stdout, actions } = await ops.run("stop");
        expect(actions).toEqual([]);
        expect(stdout).toContain("命令行不匹配");
        await expect(readFile(join(cli.dataDir, "napuketto.stop"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    },
);

opsTest.runIf(supportsCmdline)(
    "restart 跳过命令行不匹配的 boot，仍请求 detached 拉起",
    { timeout: 40_000, concurrent: true },
    async ({ cli, ops }) => {
        const pid = await ops.target();
        await ops.account(pid, { cmdline: "unrelated-boot-fingerprint" });

        const { stdout, actions } = await ops.run("restart");
        expect(actions).toEqual([JSON.stringify(["restart", cliEntry, "--data-dir", cli.dataDir])]);
        expect(stdout).toContain("命令行不匹配");
        expect(stdout).toContain("已 detached 拉起");
    },
);

opsTest(
    "stop 兼容旧 supervisor 状态缺少指纹",
    { timeout: 40_000, concurrent: true },
    async ({ ops }) => {
        const pid = await ops.target();
        await ops.supervisor(pid);

        const { stdout, actions } = await ops.run("stop");
        expect(actions).toEqual(terminationActions(pid));
        expect(stdout).toContain("supervisor 限时内未退出，树杀兜底");
    },
);

opsTest(
    "stop 兼容旧 boot 和 self-host 状态均缺少指纹",
    { timeout: 40_000, concurrent: true },
    async ({ ops }) => {
        const pid = await ops.target();
        const selfHostPid = await ops.target();
        await ops.account(pid, { selfHostPid });

        const { stdout, actions } = await ops.run("stop");
        expect(actions).toEqual([...terminationActions(pid), ...terminationActions(selfHostPid)]);
        expect(stdout).toContain("已发送停止（树杀）");
    },
);

opsTest(
    "stop 在 boot 已退出时跳过无指纹的 self-host",
    { timeout: 40_000, concurrent: true },
    async ({ ops }) => {
        const pid = await ops.target(true);
        const selfHostPid = await ops.target();
        await ops.account(pid, { selfHostPid });

        const { stdout, actions } = await ops.run("stop");
        expect(actions).toEqual([]);
        expect(stdout).toContain("缺少命令行指纹且无同树存活进程可佐证");
    },
);

opsTest.runIf(supportsCmdline)(
    "stop 仅终止指纹匹配的 boot 并跳过不匹配的 self-host",
    { timeout: 40_000, concurrent: true },
    async ({ ops }) => {
        const pid = await ops.target();
        const selfHostPid = await ops.target();
        await ops.account(pid, {
            cmdline: FIXTURE_ARG,
            selfHostPid,
            selfHostCmdline: "unrelated-self-host-fingerprint",
        });

        const { stdout, actions } = await ops.run("stop");
        expect(actions).toEqual(terminationActions(pid));
        expect(stdout).toContain("命令行不匹配");
    },
);
