import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const hostPath = fileURLToPath(new URL("../../../../dist/host/self-host.cjs", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/self-host/", import.meta.url));
const lockFile = "instance.lock";

function spawnHost(t, dir, { held = false } = {}) {
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^NAPU?K?ETTO_|^NAPUKETTO_/.test(name)),
    );
    const trace = join(dir, "trace");
    const child = spawn(process.execPath, [hostPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...inherited,
            NAPUKETTO_IPC: "1",
            NAPUKETTO_SELF_HOST: "1",
            NAPUKETTO_CFG_DIR: dir,
            NAPUKETTO_WRAPPER_PATH: join(dir, "fixture-wrapper.node"),
            NAPUKETTO_KERNEL_ENTRY: join(fixtures, "kernel.mjs"),
            NAPUKETTO_ADAPTER_ENTRY: join(fixtures, "index.mjs"),
            NAPUKETTO_NETWORK_ENTRY: join(fixtures, "network.mjs"),
            NAPUKETTO_TEST_TRACE: trace,
            NAPUKETTO_TEST_HOLD_LOGIN: held ? "1" : "0",
        },
    });
    const closed = once(child, "close");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
        await closed;
    });
    child.stdin.on("error", () => undefined);
    const lines = [];
    const unexpected = [];
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
        try {
            lines.push(JSON.parse(line));
        } catch {
            unexpected.push(line);
        }
    });
    function send(type, payload, id) {
        child.stdin.write(`${JSON.stringify({ v: 1, type, payload, id })}\n`);
    }
    async function waitFor(predicate) {
        for (let attempt = 0; attempt < 450; attempt++) {
            const frame = lines.find(predicate);
            if (frame !== undefined) {
                return frame;
            }
            if (child.exitCode !== null) {
                break;
            }
            await delay(20);
        }
        assert.fail(`missing frame on ${process.platform}: ${stderr} ${JSON.stringify(lines)}`);
    }
    async function exited(code) {
        assert.deepEqual(await closed, [code, null], stderr);
        assert.deepEqual(unexpected, [], "stdout must contain only frames");
    }
    return {
        child,
        closed,
        send,
        waitFor,
        exited,
        steps: () => readFileSync(trace, "utf8").trim().split("\n"),
    };
}

function directory() {
    const path = mkdtempSync(join(tmpdir(), "napuketto-host-"));
    // 子进程注册自己的退出回调。清理目录最后由外层 test.after 完成。
    tempDirs.add(path);
    return path;
}

const tempDirs = new Set();
test.after(() => {
    for (const path of tempDirs) {
        rmSync(path, { recursive: true, force: true });
    }
});

const status = (phase) => (frame) => frame.type === "status" && frame.payload.phase === phase;
const result = (id) => (frame) => frame.type === "result" && frame.id === id;

function assertCleanup(steps, count = 1) {
    assert.deepEqual(steps.slice(0, 3), ["kernel-load", "o3-activate", "attach-wrapper"]);
    assert.equal(steps.filter((step) => step === "protocol-stop").length, count);
    assert.equal(steps.filter((step) => step === "cache-off").length, 2 * count);
    assert.ok(steps.indexOf("protocol-stop") < steps.indexOf("forwarding-off"));
    assert.ok(steps.indexOf("forwarding-off") < steps.indexOf("cache-off"));
    assert.ok(steps.includes("listener-off"));
    assert.ok(steps.includes("bridge-off"));
}

for (const reason of ["stdin", "stdout", "stop", "restart", "bot_exit"]) {
    test(`ready child converges on ${reason}`, { timeout: 12_000 }, async (t) => {
        const dir = directory();
        const host = spawnHost(t, dir);
        await host.waitFor(status("ready"));
        assert.ok(existsSync(join(dir, lockFile)));
        if (reason === "stdin") {
            host.send("action", { action: "wait_forever" }, 1);
            host.send("ping");
            await host.waitFor((frame) => frame.type === "pong");
            host.child.stdin.end();
        } else if (reason === "stdout") {
            host.child.stdout.destroy();
            host.send("ping");
        } else if (reason === "bot_exit") {
            host.send("action", { action: reason }, 1);
        } else {
            host.send("control", { command: reason });
        }
        await host.exited(0);
        assert.equal(existsSync(join(dir, lockFile)), false);
        assertCleanup(host.steps());
    });
}

test("stdin closes during a pending login", { timeout: 12_000 }, async (t) => {
    const dir = directory();
    const host = spawnHost(t, dir, { held: true });
    await host.waitFor(status("logging"));
    host.send("action", { action: "login.getSelf" }, 1);
    assert.equal((await host.waitFor(result(1))).payload.error.code, "INVALID_STATE");
    host.child.stdin.end();
    await host.exited(0);
    assert.equal(existsSync(join(dir, lockFile)), false);
});

test("ready replay and getSelf use one generation across relogin", {
    timeout: 12_000,
}, async (t) => {
    const dir = directory();
    const host = spawnHost(t, dir);
    const ready = await host.waitFor(status("ready"));
    assert.deepEqual(ready.payload.selfInfo, { uin: "10001", uid: "fixture-1", nick: "测试" });
    host.send("action", { action: "login.getSelf" }, 1);
    assert.deepEqual((await host.waitFor(result(1))).payload.value, {
        uin: "10001",
        uid: "fixture-1",
        nickname: "测试",
    });
    host.send("control", { command: "login" });
    // sessioning 也用于首次登录。仅在 transition 确认后查询。
    await host.waitFor(
        (frame) =>
            status("sessioning")(frame) &&
            frame !== undefined &&
            host.steps().includes("protocol-stop"),
    );
    host.send("action", { action: "login.getSelf" }, 2);
    assert.equal((await host.waitFor(result(2))).payload.error.code, "INVALID_STATE");
    writeFileSync(join(dir, "resume-online"), "");
    const second = await host.waitFor(
        (frame) => status("ready")(frame) && frame.payload.selfInfo?.uin === "20002",
    );
    assert.deepEqual(second.payload.selfInfo, { uin: "20002", uid: "fixture-2", nick: "测试" });
    host.send("control", { command: "status" });
    await host.waitFor(
        (frame) =>
            frame !== second && status("ready")(frame) && frame.payload.selfInfo?.uin === "20002",
    );
    host.send("action", { action: "login.getSelf" }, 3);
    assert.equal((await host.waitFor(result(3))).payload.value.uin, "20002");
    host.send("control", { command: "stop" });
    await host.exited(0);
    assertCleanup(host.steps(), 2);
});

test("concurrent hosts arbitrate an empty lock and recover after a crash", {
    timeout: 18_000,
}, async (t) => {
    const dir = directory();
    writeFileSync(join(dir, lockFile), "");
    const hosts = Array.from({ length: 3 }, () => spawnHost(t, dir));
    const winner = await Promise.any(
        hosts.map(async (host) => {
            await host.waitFor(status("ready"));
            return host;
        }),
    );
    await Promise.all(hosts.filter((host) => host !== winner).map((host) => host.exited(1)));
    const record = JSON.parse(readFileSync(join(dir, lockFile), "utf8"));
    assert.equal(record.pid, winner.child.pid);
    assert.equal(typeof record.owner, "string");
    winner.child.kill("SIGKILL");
    await winner.closed;
    const reclaimed = spawnHost(t, dir);
    await reclaimed.waitFor(status("ready"));
    const next = JSON.parse(readFileSync(join(dir, lockFile), "utf8"));
    assert.notEqual(next.owner, record.owner);
    reclaimed.send("control", { command: "stop" });
    await reclaimed.exited(0);
    assert.equal(existsSync(join(dir, lockFile)), false);
});
