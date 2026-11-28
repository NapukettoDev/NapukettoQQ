import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checkInstanceLock, INSTANCE_LOCK_FILE } from "../../src/lifecycle/instance-lock.js";
import { isRecord } from "../../src/shared/type-guards.js";
import type { LockCommand } from "./fixtures/instance-lock-process.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/instance-lock-process.ts", import.meta.url));

interface LockParticipant {
    readonly pid: number;
    request(command: LockCommand): Promise<unknown>;
    exit(): Promise<void>;
    dispose(): Promise<void>;
}

interface ParticipantExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

function startParticipant(dataDir: string, root: string): LockParticipant {
    const child = fork(fixturePath, [dataDir], {
        execArgv: [],
        env: { ...process.env, NAPUKETTO_CFG_DIR: root },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const stopped = new AbortController();
    const exited = new Promise<ParticipantExit>((resolve) => {
        child.on("error", (error) => {
            stopped.abort(error);
            if (child.pid === undefined) resolve({ code: null, signal: null });
        });
        child.once("exit", (code, signal) => {
            stopped.abort(new Error(`Lock participant exited with code ${code}, signal ${signal}`));
            resolve({ code, signal });
        });
    });

    return {
        get pid(): number {
            assert.ok(child.pid);
            return child.pid;
        },
        async request(command: LockCommand): Promise<unknown> {
            const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(25_000)]);
            const response = once(child, "message", { signal });
            child.send(command, (error) => {
                if (error) stopped.abort(error);
            });
            const [result]: unknown[] = await response;
            return result;
        },
        async exit(): Promise<void> {
            child.send("exit");
            expect(await exited).toEqual({ code: 0, signal: null });
        },
        async dispose(): Promise<void> {
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
            }
            await exited;
        },
    };
}

const lockTest = test.extend("lock", async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "napuketto-instance-lock-"));
    const dataDir = join(root, "account");
    const children: LockParticipant[] = [];
    onTestFinished(async () => {
        await Promise.all(children.map((child) => child.dispose()));
        await rm(root, { recursive: true, force: true });
    });
    await mkdir(dataDir);
    return {
        dataDir,
        lockPath: join(dataDir, INSTANCE_LOCK_FILE),
        start() {
            const participant = startParticipant(dataDir, root);
            children.push(participant);
            return participant;
        },
    };
});

function expectOwner(record: string, pid: number): string {
    const info: unknown = JSON.parse(record);
    expect(info).toMatchObject({ pid, startedAt: expect.any(Number) });
    assert.ok(isRecord(info) && typeof info["owner"] === "string" && info["owner"].length > 0);
    return info["owner"];
}

lockTest(
    "keeps the same owner's record and rejects acquisition and release by a rival",
    async ({ lock }) => {
        const { dataDir, lockPath } = lock;
        const holder = lock.start();
        const rival = lock.start();

        expect(await holder.request("acquire")).toBe(true);
        const original = await readFile(lockPath, "utf8");
        expectOwner(original, holder.pid);
        expect(await holder.request("acquire")).toBe(true);
        expect(await readFile(lockPath, "utf8")).toBe(original);
        expect(checkInstanceLock(dataDir)).toEqual({ occupied: true, pid: holder.pid, lockPath });

        expect(await rival.request("acquire")).toBe(false);
        expect(await rival.request("release")).toBe("released");
        expect(await readFile(lockPath, "utf8")).toBe(original);
        expect(await rival.request("acquire")).toBe(false);

        expect(await holder.request("release")).toBe("released");
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await rival.request("acquire")).toBe(true);
        expectOwner(await readFile(lockPath, "utf8"), rival.pid);
        expect(await rival.request("release")).toBe("released");
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
);

lockTest(
    "replaces the exited holder's record and lets the successor release it",
    async ({ lock }) => {
        const { dataDir, lockPath } = lock;
        const holder = lock.start();
        const successor = lock.start();

        expect(await holder.request("acquire")).toBe(true);
        const original = await readFile(lockPath, "utf8");
        const originalOwner = expectOwner(original, holder.pid);
        expect(await successor.request("acquire")).toBe(false);
        await holder.exit();

        expect(checkInstanceLock(dataDir)).toEqual({ occupied: false, pid: null, lockPath });
        expect(await readFile(lockPath, "utf8")).toBe(original);
        expect(await successor.request("acquire")).toBe(true);
        expect(expectOwner(await readFile(lockPath, "utf8"), successor.pid)).not.toBe(
            originalOwner,
        );
        expect(checkInstanceLock(dataDir)).toEqual({
            occupied: true,
            pid: successor.pid,
            lockPath,
        });

        expect(await successor.request("release")).toBe("released");
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(checkInstanceLock(dataDir)).toEqual({ occupied: false, pid: null, lockPath });
    },
    60_000,
);

lockTest(
    "leaves a newer lock from the same PID intact when the old exit cleanup runs",
    async ({ lock }) => {
        const { dataDir, lockPath } = lock;
        const holder = lock.start();

        expect(await holder.request("acquire")).toBe(true);
        const originalOwner = expectOwner(await readFile(lockPath, "utf8"), holder.pid);
        expect(await holder.request("register-cleanup")).toBe("registered");
        expect(await holder.request("release")).toBe("released");
        expect(await holder.request("acquire")).toBe(true);
        const newer = await readFile(lockPath, "utf8");
        const newerOwner = expectOwner(newer, holder.pid);
        expect(newerOwner).not.toBe(originalOwner);

        await holder.exit();
        expect(await readFile(lockPath, "utf8")).toBe(newer);
        expect(checkInstanceLock(dataDir)).toEqual({ occupied: false, pid: null, lockPath });
        const successor = lock.start();
        expect(await successor.request("acquire")).toBe(true);
        expect(expectOwner(await readFile(lockPath, "utf8"), successor.pid)).not.toBe(newerOwner);
        expect(await successor.request("release")).toBe("released");
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
);

const damagedRecords = [
    { kind: "empty", content: "" },
    { kind: "malformed JSON", content: "{not json" },
    { kind: "invalid PID", content: JSON.stringify({ pid: 0, startedAt: 1 }) },
];

lockTest.for(damagedRecords)(
    "rebuilds a lock with $kind after leaving it intact in preflight",
    { timeout: 60_000 },
    async ({ content }, { lock }) => {
        const { dataDir, lockPath } = lock;
        await writeFile(lockPath, content);
        expect(checkInstanceLock(dataDir)).toEqual({ occupied: false, pid: null, lockPath });
        expect(await readFile(lockPath, "utf8")).toBe(content);

        const participant = lock.start();
        expect(await participant.request("acquire")).toBe(true);
        expectOwner(await readFile(lockPath, "utf8"), participant.pid);
        expect(checkInstanceLock(dataDir)).toEqual({
            occupied: true,
            pid: participant.pid,
            lockPath,
        });
        expect(await participant.request("release")).toBe("released");
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
);

lockTest(
    "reclaims an exited process's mutation directory once only known entries remain",
    async ({ lock }) => {
        const { dataDir, lockPath } = lock;
        const holder = lock.start();
        const successor = lock.start();
        expect(await holder.request("acquire")).toBe(true);
        expect(await holder.request("release")).toBe("released");
        const guard = `${lockPath}.guard`;
        const token = randomUUID();
        const marker = join(guard, token);
        const temporary = `${marker}.lock`;
        const record = JSON.stringify({ pid: holder.pid, startedAt: Date.now() });
        await mkdir(guard);
        await writeFile(marker, record);
        await writeFile(temporary, "incomplete record");

        expect(checkInstanceLock(dataDir)).toEqual({ occupied: false, pid: null, lockPath });
        expect(await successor.request("acquire")).toBe(false);
        await holder.exit();
        const foreignEntry = join(guard, "unexpected");
        await writeFile(foreignEntry, "preserve me");
        expect(await successor.request("acquire")).toBe(false);
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(marker, "utf8")).toBe(record);
        expect(await readFile(temporary, "utf8")).toBe("incomplete record");
        expect(await readFile(foreignEntry, "utf8")).toBe("preserve me");

        await unlink(foreignEntry);
        expect(await successor.request("acquire")).toBe(true);
        expect(await readdir(dataDir)).toEqual([INSTANCE_LOCK_FILE]);
        expectOwner(await readFile(lockPath, "utf8"), successor.pid);
        expect(await successor.request("release")).toBe("released");
        expect(await readdir(dataDir)).toEqual([]);
    },
    60_000,
);
