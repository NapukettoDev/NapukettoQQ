import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheMediaFile, leaseMediaReference, MediaCache, withMediaScope } from "../media-cache.js";

vi.mock("node:crypto", async (original) => ({
    ...(await original<typeof import("node:crypto")>()),
    randomUUID: vi.fn((await original<typeof import("node:crypto")>()).randomUUID),
}));

let root: string;
let time: number;
let cache: MediaCache;
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "nk-cache-lifecycle-")));
    time = 1000;
    cache = new MediaCache({ root, ttlMs: 100, orphanTtlMs: 50, maxBytes: 8, now: () => time });
});
afterEach(async () => {
    cache.stop();
    vi.useRealTimers();
    vi.mocked(randomUUID).mockClear();
    await rm(root, { recursive: true, force: true });
});
const write =
    (value = "1234") =>
    async (path: string): Promise<void> => {
        await writeFile(path, value);
    };
const entries = async (): Promise<string[]> => await readdir(join(root, ".napuketto-media-v1"));

describe("owned media cache", () => {
    it("expires returned references using persisted completion time across restart", async () => {
        const path = await cache.run(() => cacheMediaFile(root, ".png", write(), "reference"));
        cache.stop();
        const restarted = new MediaCache({ root, now: () => time });
        time = 1099;
        await restarted.sweep();
        expect(existsSync(path)).toBe(true);
        time = 1100;
        await restarted.sweep();
        expect(existsSync(dirname(path))).toBe(false);
    });

    it("refuses quota overflow without evicting protected references; expired space is reused", async () => {
        const old = await cache.run(() => cacheMediaFile(root, ".bin", write(), "reference"));
        await expect(
            cache.run(() => cacheMediaFile(root, ".bin", write("12345"), "reference")),
        ).rejects.toMatchObject({ code: "INVALID_STATE" });
        expect(await readFile(old, "utf8")).toBe("1234");
        expect(await entries()).toHaveLength(1);
        time += 101;
        const next = await cache.run(() =>
            cacheMediaFile(root, ".bin", write("12345678"), "reference"),
        );
        expect(existsSync(old)).toBe(false);
        expect(existsSync(next)).toBe(true);
    });

    it("protects an in-flight download and send past TTL, then cleans on success", async () => {
        await cache.run(async () => {
            const path = await cacheMediaFile(root, ".bin", async (dest) => {
                await writeFile(dest, "1234");
                time += 1000;
                await cache.sweep();
                expect(existsSync(dest)).toBe(true);
            });
            time += 1000;
            await cache.sweep();
            expect(existsSync(path)).toBe(true);
        });
        expect(await entries()).toEqual([]);
    });

    it("keeps an already leased reference past expiry and rejects new consumers", async () => {
        const path = await cache.run(() => cacheMediaFile(root, ".bin", write(), "reference"));
        let release = (): void => undefined;
        const held = new Promise<void>((done) => {
            release = done;
        });
        let acquired = (): void => undefined;
        const ready = new Promise<void>((done) => {
            acquired = done;
        });
        const second = new MediaCache({ root, now: () => time });
        const sending = cache.run(async () => {
            await leaseMediaReference(path);
            acquired();
            await held;
            expect(existsSync(path)).toBe(true);
        });
        await ready;
        time += 1000;
        await second.run(async () => {
            await expect(leaseMediaReference(path)).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
            await second.sweep();
            expect(existsSync(path)).toBe(true);
        });
        await second.sweep();
        expect(existsSync(path)).toBe(true);
        release();
        await sending;
        await second.sweep();
        expect(existsSync(path)).toBe(false);
    });

    it("cleans partial download/transcode files and all outputs after a later failure", async () => {
        await expect(
            cache.run(async () => {
                await cacheMediaFile(root, ".png", write());
                await cacheMediaFile(root, ".bin", write(), "reference");
                await cacheMediaFile(root, ".wav", async (path) => {
                    await writeFile(path, "12");
                    await writeFile(join(dirname(path), "media.silk"), "partial");
                    throw new Error("transcode failed");
                });
            }),
        ).rejects.toThrow("transcode failed");
        expect(await entries()).toEqual([]);
    });

    it("nested failures mapped by an action still discard references", async () => {
        await cache.run(async () => {
            await withMediaScope(async () => {
                await cacheMediaFile(root, ".bin", write(), "reference");
                throw new Error("mapped failure");
            }).catch(() => undefined);
        });
        expect(await entries()).toEqual([]);
    });

    it("reclaims restart orphan files, including interrupted downloader .part output", async () => {
        const dir = join(root, ".napuketto-media-v1", `entry-2147483647-${randomUUID()}`);
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, ".owner.json"),
            JSON.stringify({ version: 1, lifetime: "temporary", expires: 1050 }),
        );
        await writeFile(join(dir, `media.png.part-2147483647-${randomUUID()}`), "partial");
        const videoDir = join(dir, ".napuketto-video-Ab123x");
        await mkdir(videoDir);
        await writeFile(join(videoDir, "output.mp4"), "partial video");
        time = 1049;
        await cache.start();
        expect(existsSync(dir)).toBe(true);
        time = 1050;
        await cache.sweep();
        expect(existsSync(dir)).toBe(false);
    });

    it("reclaims the known orphaned staged input and its video output", async () => {
        const dir = join(root, ".napuketto-media-v1", `entry-2147483647-${randomUUID()}`);
        const input = join(dir, "input");
        const video = join(input, ".napuketto-video-Ab123x");
        await mkdir(video, { recursive: true });
        await writeFile(
            join(dir, ".owner.json"),
            JSON.stringify({
                version: 1,
                lifetime: "temporary",
                expires: 0,
                inputName: "clip.webm",
            }),
        );
        await writeFile(join(input, "clip.webm"), "staged");
        await writeFile(join(video, "output.mp4"), "converted");
        await cache.sweep();
        expect(existsSync(dir)).toBe(false);
    });

    it("preserves a live on-disk lease after the original writer exited", async () => {
        const dir = join(root, ".napuketto-media-v1", `entry-2147483647-${randomUUID()}`);
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, ".owner.json"),
            JSON.stringify({ version: 1, lifetime: "reference", expires: 0 }),
        );
        await writeFile(join(dir, "media.png"), "1234");
        const lease = join(dir, `.lease-${process.pid}-${randomUUID()}`);
        await writeFile(lease, "");
        await cache.sweep();
        expect(existsSync(dir)).toBe(true);
        await rm(lease);
        await cache.sweep();
        expect(existsSync(dir)).toBe(false);
    });

    it("does not follow a junction or a sibling boundary hidden inside a marked entry", async () => {
        const path = await cache.create(root, ".bin", write());
        const outside = join(root, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "output.mp4"), "caller data");
        await symlink(outside, join(dirname(path), ".napuketto-video-Ab123x"), "junction");
        time += 1000;
        await cache.sweep();
        expect(existsSync(path)).toBe(true);
        expect(await readFile(join(outside, "output.mp4"), "utf8")).toBe("caller data");
        await expect(cache.create(root, "../outside.png", write())).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });

    it("rejects a new output when active files fill the quota, without interrupting the first send", async () => {
        await cache.run(async () => {
            const path = await cacheMediaFile(root, ".png", write("12345678"));
            await expect(cacheMediaFile(root, ".png", write("1"))).rejects.toMatchObject({
                code: "INVALID_STATE",
            });
            expect(await readFile(path, "utf8")).toBe("12345678");
        });
        expect(await entries()).toEqual([]);
    });

    it("uses exclusive directories and retries UUID collisions without overwriting", async () => {
        const id = "11111111-1111-4111-8111-111111111111";
        const existing = join(root, ".napuketto-media-v1", `entry-${process.pid}-${id}`);
        await mkdir(existing, { recursive: true });
        await writeFile(join(existing, "user.txt"), "keep");
        vi.mocked(randomUUID).mockReturnValueOnce(id);
        const [a, b] = await Promise.all([
            cache.create(root, ".jpg", write("a")),
            cache.create(root, ".jpg", write("b")),
        ]);
        expect(a).not.toBe(b);
        expect(await readFile(a, "utf8")).toBe("a");
        expect(await readFile(b, "utf8")).toBe("b");
        expect(await readFile(join(existing, "user.txt"), "utf8")).toBe("keep");
    });

    it("never adopts user files, unmarked entries, malformed markers or unknown children", async () => {
        await writeFile(join(root, "user.png"), "keep");
        const path = await cache.create(root, ".png", write());
        await writeFile(join(dirname(path), "user.txt"), "keep");
        time += 10000;
        await cache.sweep();
        expect(existsSync(path)).toBe(true);
        expect(await readFile(join(root, "user.png"), "utf8")).toBe("keep");
        await writeFile(join(dirname(path), ".owner.json"), "invalid JSON");
        await cache.sweep();
        expect(existsSync(path)).toBe(true);
    });

    it("rejects a symlink/junction cache root and never follows entry links", async () => {
        const outside = join(root, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "user.png"), "keep");
        const controlled = join(root, ".napuketto-media-v1");
        await symlink(outside, controlled, "junction");
        await expect(cache.create(root, ".png", write())).rejects.toMatchObject({
            code: "INVALID_STATE",
        });
        await rm(controlled);
        await mkdir(controlled);
        const linked = join(controlled, `entry-${process.pid}-${randomUUID()}`);
        await symlink(outside, linked, "junction");
        time += 10000;
        await cache.sweep();
        expect(await readFile(join(outside, "user.png"), "utf8")).toBe("keep");
        expect(existsSync(linked)).toBe(true);
    });

    it("unrefs the sweep timer and releases it on stop/restart", async () => {
        vi.useFakeTimers();
        await Promise.all([cache.start(), cache.start()]);
        expect(vi.getTimerCount()).toBe(1);
        cache.stop();
        cache.stop();
        expect(vi.getTimerCount()).toBe(0);
        await cache.start();
        expect(vi.getTimerCount()).toBe(1);
        cache.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stop during startup does not resurrect a timer", async () => {
        vi.useFakeTimers();
        const starting = cache.start();
        cache.stop();
        await starting;
        expect(vi.getTimerCount()).toBe(0);
    });
});
