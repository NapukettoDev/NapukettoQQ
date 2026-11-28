import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const selfHost = fileURLToPath(new URL("../../../dist/host/self-host.cjs", import.meta.url));
const kernel = fileURLToPath(new URL("../../../../kernel/dist/index.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/wrapper.cjs", import.meta.url));

async function runHost(
    t,
    { fail = "", oldKernel = false, diagnostics = false, probe = false } = {},
) {
    const root = await mkdtemp(join(tmpdir(), "napuketto-host-"));
    const cfg = join(root, "account");
    const traceFile = join(root, "trace");
    const wrapper = join(root, "wrapper.node");
    const addon = process.env.HOST_TEST_ADDON;
    await mkdir(cfg);
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(traceFile, "");
    await writeFile(join(root, "major.node"), "QQAppId/123456789");
    if (addon) await copyFile(addon, wrapper);
    if (oldKernel) await writeFile(join(root, "old.mjs"), "export class NapukettoCore {}");
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^NAPUKETTO_/i.test(key)),
    );
    const child = spawn(process.execPath, ["--require", fixture, selfHost], {
        cwd: root,
        env: {
            ...inherited,
            HOST_TEST_TRACE: traceFile,
            HOST_TEST_FAIL: fail,
            HOST_TEST_REAL_DLOPEN: addon ? "1" : "",
            NAPUKETTO_IPC: "1",
            NAPUKETTO_PROBE: probe ? "1" : "0",
            NAPUKETTO_DIAG: diagnostics ? "1" : "0",
            NAPUKETTO_CFG_DIR: cfg,
            NAPUKETTO_DATA_ROOT: root,
            NAPUKETTO_SANDBOX_ROOT: root,
            NAPUKETTO_WRAPPER_PATH: wrapper,
            NAPUKETTO_KERNEL_ENTRY: oldKernel ? join(root, "old.mjs") : kernel,
            NAPUKETTO_QQ_VERSION: "9.9.37-12345",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const frames = [];
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    const stdout = createInterface({ input: child.stdout });
    const send = (frame) => child.stdin.write(`${JSON.stringify({ v: 1, ...frame })}\n`);
    const action = {
        type: "action",
        id: 1,
        payload: { action: "diag.sessionCall", params: { method: "__methods" } },
    };
    const stop = { type: "control", payload: { command: "stop" } };
    stdout.on("line", (line) => {
        try {
            const frame = JSON.parse(line);
            frames.push(frame);
            if (frame.type === "status" && frame.payload.phase === "ready") send(action);
            if (frame.type === "result" && frame.id === 1) send(stop);
        } catch (err) {
            errors.push(String(err));
            child.kill();
        }
    });
    const timeout = setTimeout(() => child.kill(), 12_000);
    let exit;
    try {
        exit = await once(child, "close");
    } finally {
        clearTimeout(timeout);
        stdout.close();
    }
    const trace = (await readFile(traceFile, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(exit[1], null, JSON.stringify({ errors, frames, trace }));
    const bootLog = await readFile(join(cfg, "napuketto-boot.log"), "utf8");
    return { code: exit[0], frames, trace, cfg, bootLog };
}

function phases(frames) {
    return frames.filter((frame) => frame.type === "status").map((frame) => frame.payload.phase);
}

for (const diagnostics of [false, true]) {
    test(`loads, logs in, and shuts down with diagnostics ${diagnostics}`, async (t) => {
        const { code, frames, trace, cfg, bootLog } = await runHost(t, { diagnostics });
        assert.equal(code, 0, bootLog);
        assert.deepEqual(phases(frames), [
            "booting",
            "dlopening",
            "logging",
            "sessioning",
            "ready",
        ]);
        assert.deepEqual(trace.slice(0, 11), [
            "dlopen",
            "add:O3",
            "startup.create",
            "session.get",
            "engine.init",
            "login.list",
            "login.initConfig",
            "login.list",
            "login.quick",
            "session.init",
            "startup.start",
        ]);
        assert.deepEqual(trace.slice(11), [
            "add:Msg",
            "online",
            "add:Group",
            "add:Buddy",
            "add:RecentContact",
            "add:Login",
            "remove:Login",
            "remove:RecentContact",
            "remove:Buddy",
            "remove:Group",
            "remove:Msg",
        ]);
        const result = frames.find((frame) => frame.type === "result" && frame.id === 1);
        assert.equal(result.payload.ok, diagnostics, JSON.stringify(result));
        if (diagnostics) assert.ok(result.payload.value.methods.includes("getGroupService"));
        else assert.equal(result.payload.error.code, "NOT_FOUND");
        await assert.rejects(stat(join(cfg, "instance.lock")), { code: "ENOENT" });
    });
}

test("missing O3 fails before engine initialization or login", async (t) => {
    const { code, frames, trace } = await runHost(t, { fail: "o3" });
    assert.equal(code, 1);
    assert.deepEqual(phases(frames), ["booting", "dlopening", "failed"]);
    assert.equal(frames.at(-1).payload.error.code, "INVALID_STATE");
    assert.deepEqual(trace, ["dlopen"]);
});

test("old kernel reports the missing host contract", async (t) => {
    const { code, frames, trace } = await runHost(t, { oldKernel: true });
    assert.equal(code, 1);
    assert.deepEqual(phases(frames), ["booting", "dlopening", "failed"]);
    assert.match(frames.at(-1).payload.error.message, /prepareSelfHost/);
    assert.deepEqual(trace, []);
});

test("partially registered runtime releases its earlier listener before failure", async (t) => {
    const { code, frames, trace } = await runHost(t, { fail: "register" });
    assert.equal(code, 1);
    assert.deepEqual(phases(frames), ["booting", "dlopening", "logging", "sessioning", "failed"]);
    assert.deepEqual(trace.slice(-4), ["add:Msg", "online", "add:Group", "remove:Msg"]);
});

test("opt-in kernel probe records the group method surface after session initialization", async (t) => {
    const { code, cfg, bootLog } = await runHost(t, { probe: true });
    assert.equal(code, 0, bootLog);
    const evidence = JSON.parse(await readFile(join(cfg, "napuketto-probe.json"), "utf8"));
    assert.ok(evidence.services.getGroupService.methods.includes("kickMemberV2"));
});
