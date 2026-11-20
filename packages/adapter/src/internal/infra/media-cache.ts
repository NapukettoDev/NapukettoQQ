import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    readdir,
    readFile,
    realpath,
    rename,
    rmdir,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { errorMessage, kernelError } from "@napuketto/kernel";
import type { AdapterLoggerLike } from "./log.js";

const CACHE_DIR = ".napuketto-media-v1";
const ENTRY_RE = /^entry-(\d+)-[\da-f-]{36}$/;
const EXTENSION_RE = /^\.[a-zA-Z0-9]+$/;
const OWNED_FILE_RE =
    /^(?:media\.[a-zA-Z0-9]+(?:\.part-\d+-[\da-f-]{36})?|\.napuketto-[\da-f]{16}\.pcm|\.owner-next-[\da-f-]{36}\.json|\.lease-\d+-[\da-f-]{36})$/;
const LEASE_RE = /^\.lease-(\d+)-[\da-f-]{36}$/;
const VIDEO_DIR_RE = /^\.napuketto-video-[a-zA-Z0-9]{6}$/;
const DAY = 24 * 60 * 60 * 1000;
const META = ".owner.json";
export const MEDIA_TEMP_ROOT = join(tmpdir(), "napuketto-adapter-media");
type Lifetime = "temporary" | "reference";
interface Owner {
    version: 1;
    lifetime: Lifetime;
    expires: number;
}
interface Entry {
    dir: string;
    owner: Owner;
    bytes: number;
    files: string[];
    directories: string[];
    foreignLive: boolean;
    removable: boolean;
}
interface Contents {
    bytes: number;
    removable: boolean;
    files: string[];
    directories: string[];
}
interface CacheOptions {
    root?: string | undefined;
    logger?: Pick<AdapterLoggerLike, "warn"> | undefined;
    ttlMs?: number;
    orphanTtlMs?: number;
    maxBytes?: number;
    now?: () => number;
}
interface Scope {
    cache: MediaCache;
    owned: Map<string, Lifetime>;
    pinned: Map<string, string>;
    failed: boolean;
}

// Coordination data only: cache services/timers belong to API instances. The locks also
// serialize separate protocol instances configured with the same root in this process.
const locks = new Map<string, Promise<void>>();
const active = new Map<string, number>();
const scopes = new AsyncLocalStorage<Scope>();

async function locked<T>(root: string, task: () => Promise<T>): Promise<T> {
    const prior = locks.get(root) ?? Promise.resolve();
    let release = (): void => undefined;
    const next = new Promise<void>((done) => {
        release = done;
    });
    locks.set(root, next);
    await prior;
    try {
        return await task();
    } finally {
        release();
        if (locks.get(root) === next) locks.delete(root);
    }
}

function pin(dir: string): void {
    active.set(dir, (active.get(dir) ?? 0) + 1);
}
function unpin(dir: string): void {
    const count = active.get(dir) ?? 0;
    if (count <= 1) active.delete(dir);
    else active.set(dir, count - 1);
}
function missing(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "ENOENT";
}
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return !(err instanceof Error && "code" in err && err.code === "ESRCH");
    }
}

function hasLiveLease(files: string[]): boolean {
    return files.some((name) => {
        const lease = LEASE_RE.exec(name);
        return lease !== null && alive(Number(lease[1]));
    });
}

function parseOwner(value: unknown): Owner | undefined {
    if (
        typeof value !== "object" ||
        value === null ||
        !("version" in value) ||
        value.version !== 1 ||
        !("lifetime" in value) ||
        (value.lifetime !== "temporary" && value.lifetime !== "reference") ||
        !("expires" in value) ||
        typeof value.expires !== "number" ||
        !Number.isFinite(value.expires)
    )
        return undefined;
    return { version: 1, lifetime: value.lifetime, expires: value.expires };
}

/** Private adapter cache. Only its marked, flat entries are candidates for deletion. */
export class MediaCache {
    private readonly roots = new Set<string>();
    private timer: NodeJS.Timeout | undefined;
    private starting: Promise<void> | undefined;
    private generation = 0;
    private readonly ttl: number;
    private readonly orphanTtl: number;
    private readonly maxBytes: number;
    private readonly now: () => number;
    private readonly options: CacheOptions;

    constructor(options: CacheOptions = {}) {
        this.options = options;
        this.roots.add(resolve(MEDIA_TEMP_ROOT, CACHE_DIR));
        if (options.root) this.roots.add(resolve(options.root, CACHE_DIR));
        this.ttl = options.ttlMs ?? DAY;
        this.orphanTtl = options.orphanTtlMs ?? 60 * 60 * 1000;
        this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
        this.now = options.now ?? Date.now;
    }

    async start(): Promise<void> {
        if (this.timer !== undefined) return;
        if (this.starting !== undefined) return await this.starting;
        const generation = ++this.generation;
        this.starting = this.sweep().then(() => {
            if (generation !== this.generation) return;
            this.timer = setInterval(() => {
                this.sweep().catch((err: unknown) => {
                    this.options.logger?.warn({ error: errorMessage(err) }, "媒体缓存清理失败");
                });
            }, 60_000);
            this.timer.unref();
        });
        try {
            await this.starting;
        } finally {
            this.starting = undefined;
        }
    }

    stop(): void {
        this.generation++;
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Nested action helpers reuse the lease until the outer action finishes. */
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (scopes.getStore() !== undefined) return await task();
        const scope: Scope = { cache: this, owned: new Map(), pinned: new Map(), failed: false };
        return await scopes.run(scope, async () => {
            let result: T;
            try {
                result = await task();
            } catch (err) {
                await this.finish(scope, false).catch((cleanup: unknown) => {
                    this.options.logger?.warn(
                        { error: errorMessage(cleanup) },
                        "媒体动作失败后的清理失败",
                    );
                });
                throw err;
            }
            await this.finish(scope, !scope.failed);
            return result;
        });
    }

    private async finish(scope: Scope, success: boolean): Promise<void> {
        const cleaned = await Promise.allSettled(
            [...scope.owned].map(([dir, lifetime]) =>
                locked(dirname(dir), async () => {
                    if (success && lifetime === "reference") {
                        await this.mark(dir, "reference", this.now() + this.ttl);
                    } else {
                        await this.remove(dir);
                    }
                }),
            ),
        );
        const released = await Promise.allSettled(
            [...scope.pinned].map(([dir, lease]) =>
                locked(dirname(dir), async () => {
                    try {
                        await this.checkRoot(dirname(dir));
                        if ((await lstat(dir)).isSymbolicLink() || (await realpath(dir)) !== dir) {
                            throw kernelError("媒体缓存租约边界已改变", "INVALID_STATE");
                        }
                        await unlink(join(dir, lease));
                    } finally {
                        unpin(dir);
                    }
                }),
            ),
        );
        for (const dir of scope.owned.keys()) unpin(dir);
        const failure = [...cleaned, ...released].find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }

    /** Allocate before any download/write. Writer may return a renamed output in the same entry. */
    async create(
        base: string,
        extension: string,
        writer: (path: string) => Promise<string> | Promise<void>,
        lifetime: Lifetime = "temporary",
    ): Promise<string> {
        if (!EXTENSION_RE.test(extension)) {
            throw kernelError("非法媒体缓存扩展名", "INVALID_PARAM");
        }
        // Resolve caller-chosen base once; never sweep the base itself or adopt its contents.
        await mkdir(resolve(base), { recursive: true });
        const root = join(await realpath(resolve(base)), CACHE_DIR);
        this.roots.add(root);
        const dir = await locked(root, async () => {
            await mkdir(root, { recursive: true });
            await this.checkRoot(root);
            await this.collect(root);
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidate = join(root, `entry-${process.pid}-${randomUUID()}`);
                try {
                    await mkdir(candidate);
                } catch (err) {
                    if (err instanceof Error && "code" in err && err.code === "EEXIST") continue;
                    throw err;
                }
                pin(candidate);
                try {
                    await this.mark(candidate, "temporary", this.now() + this.orphanTtl);
                } catch (err) {
                    unpin(candidate);
                    await rmdir(candidate);
                    throw err;
                }
                return candidate;
            }
            throw kernelError("媒体缓存命名冲突", "INVALID_STATE");
        });
        const scope = scopes.getStore();
        try {
            const path = join(dir, `media${extension}`);
            const output = (await writer(path)) ?? path;
            const info = await lstat(output);
            if (
                dirname(resolve(output)) !== dir ||
                !OWNED_FILE_RE.test(basename(output)) ||
                !info.isFile() ||
                info.isSymbolicLink()
            ) {
                throw kernelError("媒体缓存输出超出受控目录", "INVALID_STATE");
            }
            await locked(root, async () => {
                const bytes = await this.collect(root);
                if (bytes > this.maxBytes) {
                    throw kernelError(
                        "媒体缓存容量已满（引用期限或使用中租约保护）",
                        "INVALID_STATE",
                    );
                }
                // Without an action scope, the caller consumes the returned path later.
                if (scope === undefined) await this.mark(dir, "reference", this.now() + this.ttl);
            });
            if (scope !== undefined) scope.owned.set(dir, lifetime);
            else unpin(dir);
            return output;
        } catch (err) {
            try {
                await locked(root, () => this.remove(dir));
            } finally {
                unpin(dir);
            }
            throw err;
        }
    }

    async sweep(): Promise<void> {
        for (const configuredRoot of this.roots) {
            let root: string;
            try {
                root = join(await realpath(dirname(configuredRoot)), CACHE_DIR);
            } catch (err) {
                if (missing(err)) continue;
                throw err;
            }
            await locked(root, async () => {
                try {
                    await this.checkRoot(root);
                } catch (err) {
                    if (missing(err)) return;
                    throw err;
                }
                await this.collect(root);
            });
        }
    }

    private async checkRoot(root: string): Promise<void> {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root) {
            throw kernelError("媒体缓存目录不能是符号链接", "INVALID_STATE");
        }
    }

    private async mark(dir: string, lifetime: Lifetime, expires: number): Promise<void> {
        await this.checkRoot(dirname(dir));
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(dir)) !== dir) {
            throw kernelError("媒体缓存条目边界无效", "INVALID_STATE");
        }
        const metadata = join(dir, META);
        const next = join(dir, `.owner-next-${randomUUID()}.json`);
        try {
            await writeFile(next, JSON.stringify({ version: 1, lifetime, expires }), {
                flag: "wx",
            });
            await rename(next, metadata);
        } finally {
            await unlink(next).catch((err: unknown) => {
                if (!missing(err)) throw err;
            });
        }
    }

    private async inspect(dir: string): Promise<Entry | undefined> {
        const match = ENTRY_RE.exec(basename(dir));
        if (match === null) return undefined;
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
        const files = await readdir(dir);
        const summary = await this.summarize(dir, files);
        if (summary === undefined) return undefined;
        if (!files.includes(META)) return undefined;
        const parsed = parseOwner(JSON.parse(await readFile(join(dir, META), "utf8")));
        if (parsed === undefined) return undefined;
        const pid = Number(match[1]);
        return {
            dir,
            owner: parsed,
            bytes: summary.bytes,
            files: summary.files,
            directories: summary.directories,
            foreignLive: (pid !== process.pid && alive(pid)) || hasLiveLease(files),
            removable: summary.removable,
        };
    }

    private async summarize(dir: string, files: string[]): Promise<Contents | undefined> {
        const out: Contents = { bytes: 0, removable: true, files: [], directories: [] };
        for (const file of files) {
            const item = await this.summarizeFile(dir, file);
            if (item === undefined) return undefined;
            out.bytes += item.bytes;
            out.removable &&= item.removable;
            out.files.push(...item.files);
            out.directories.push(...item.directories);
        }
        return out;
    }

    private async summarizeFile(dir: string, file: string): Promise<Contents | undefined> {
        const stat = await lstat(join(dir, file));
        if (stat.isDirectory() && VIDEO_DIR_RE.test(file)) {
            const nested = await this.videoOutput(join(dir, file));
            return nested === undefined
                ? { bytes: Number.POSITIVE_INFINITY, removable: false, files: [], directories: [] }
                : {
                      bytes: nested.bytes,
                      removable: true,
                      files: nested.files.map((name) => join(file, name)),
                      directories: [file],
                  };
        }
        const regular = stat.isFile() && !stat.isSymbolicLink();
        if (file === META && !regular) return undefined;
        return {
            bytes: file === META ? 0 : regular ? stat.size : Number.POSITIVE_INFINITY,
            removable: regular && (file === META || OWNED_FILE_RE.test(file)),
            files: [file],
            directories: [],
        };
    }

    private async videoOutput(
        dir: string,
    ): Promise<{ bytes: number; files: string[] } | undefined> {
        const files = await readdir(dir);
        if (files.length === 0) return { bytes: 0, files };
        if (files.length !== 1 || files[0] !== "output.mp4") return undefined;
        const info = await lstat(join(dir, "output.mp4"));
        return info.isFile() && !info.isSymbolicLink() ? { bytes: info.size, files } : undefined;
    }

    private async collect(root: string): Promise<number> {
        let total = 0;
        for (const name of await readdir(root)) {
            const dir = join(root, name);
            let entry: Entry | undefined;
            try {
                entry = await this.inspect(dir);
            } catch (err) {
                if (missing(err) || err instanceof SyntaxError) continue;
                throw err;
            }
            if (entry === undefined) continue;
            if (
                entry.removable &&
                !active.has(dir) &&
                !entry.foreignLive &&
                entry.owner.expires <= this.now()
            ) {
                await this.remove(dir);
            } else {
                total += entry.bytes;
            }
        }
        return total;
    }

    private async remove(dir: string): Promise<void> {
        await this.checkRoot(dirname(dir));
        const entry = await this.inspect(dir);
        if (entry === undefined || !entry.removable || hasLiveLease(entry.files)) return;
        for (const file of entry.files.filter((name) => name !== META)) {
            // Revalidate both boundaries and file type immediately before unlink; never recurse.
            await this.checkRoot(dirname(dir));
            if ((await realpath(dir)) !== dir || (await lstat(dir)).isSymbolicLink()) {
                throw kernelError("媒体缓存条目边界已改变", "INVALID_STATE");
            }
            const path = join(dir, file);
            if ((await realpath(dirname(path))) !== dirname(path)) return;
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) return;
            await unlink(path);
        }
        for (const name of entry.directories) await rmdir(join(dir, name));
        await unlink(join(dir, META));
        await rmdir(dir);
    }
}

/** Action factories also work independently of an adapter/registry. */
export async function withMediaScope<T>(task: () => Promise<T>): Promise<T> {
    const scope = scopes.getStore();
    if (scope === undefined) return await new MediaCache().run(task);
    try {
        return await task();
    } catch (err) {
        scope.failed = true;
        throw err;
    }
}

export async function cacheMediaFile(
    root: string,
    extension: string,
    writer: (path: string) => Promise<string> | Promise<void>,
    lifetime: Lifetime = "temporary",
): Promise<string> {
    return await (scopes.getStore()?.cache ?? new MediaCache()).create(
        root,
        extension,
        writer,
        lifetime,
    );
}

/** Lease a previously returned cache path; caller/QQ paths are never adopted. */
export async function protectMediaPath(path: string): Promise<string> {
    const scope = scopes.getStore();
    const dir = dirname(resolve(path));
    const root = dirname(dir);
    if (
        scope === undefined ||
        basename(root) !== CACHE_DIR ||
        !ENTRY_RE.test(basename(dir)) ||
        scope.pinned.has(dir) ||
        scope.owned.has(dir)
    )
        return path;
    await locked(root, async () => {
        if (
            (await lstat(root)).isSymbolicLink() ||
            (await realpath(root)) !== root ||
            (await lstat(dir)).isSymbolicLink() ||
            (await realpath(dir)) !== dir
        ) {
            throw kernelError("媒体缓存引用边界无效", "INVALID_STATE");
        }
        const marker = join(dir, META);
        if (
            (await lstat(marker)).isSymbolicLink() ||
            parseOwner(JSON.parse(await readFile(marker, "utf8"))) === undefined
        ) {
            throw kernelError("媒体缓存引用缺少所有权标记", "INVALID_STATE");
        }
        const lease = `.lease-${process.pid}-${randomUUID()}`;
        await writeFile(join(dir, lease), "", { flag: "wx" });
        pin(dir);
        scope.pinned.set(dir, lease);
    });
    return path;
}
