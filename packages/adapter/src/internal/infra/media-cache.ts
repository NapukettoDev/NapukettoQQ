import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { errorMessage, kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { AdapterLoggerLike } from "./log.js";

const CACHE_DIR = ".napuketto-media-v1";
const ENTRY_RE = /^entry-(\d+)-[\da-f-]{36}$/;
const EXTENSION_RE = /^\.[a-zA-Z0-9]+$/;
const OWNED_FILE_RE =
    /^(?:media\.[a-zA-Z0-9]+(?:\.part-\d+-[\da-f-]{36})?|\.napuketto-[\da-f]{16}\.pcm|\.owner-next-[\da-f-]{36}\.json|\.lease-\d+-[\da-f-]{36})$/;
const PATH_SEPARATOR_RE = /[\\/]/;
const STAGED_NAME_INVALID_RE = /[\\/:]/;
const CACHE_COMPONENT_RE = /^\.napuketto-media-v[12](?:-[\da-f]+)?$/i;
const CACHE_FILE_RE = /^media\.[a-zA-Z0-9]+$/;
const COLLECT_RE = /^\.collect-(\d+)-[\da-f-]{36}$/;
const STAGED_DIR = "input";
const LEASE_RE = /^\.lease-(\d+)-[\da-f-]{36}$/;
const VIDEO_DIR_RE = /^\.napuketto-video-[a-zA-Z0-9]{6}$/;
const DAY = 24 * 60 * 60 * 1000;
const META = ".owner.json";
const uid = process.getuid?.();
export const MEDIA_TEMP_ROOT = join(
    tmpdir(),
    uid === undefined ? "napuketto-adapter-media" : `napuketto-adapter-media-${uid}`,
);
type Lifetime = "temporary" | "reference";
const cacheOwnerSchema = z.object({
    version: z.literal(1),
    lifetime: z.enum(["temporary", "reference"]),
    expires: z.number(),
    file: z.string().regex(CACHE_FILE_RE).optional(),
    inputName: z.string().refine(isStagedName).optional(),
});
type Owner = z.infer<typeof cacheOwnerSchema>;
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
    owner?: { protocol: string; account: string };
    logger?: Pick<AdapterLoggerLike, "warn"> | undefined;
    ttlMs?: number;
    orphanTtlMs?: number;
    maxBytes?: number;
    now?: () => number;
}
interface Scope {
    cache: MediaCache;
    owned: Map<string, { lifetime: Lifetime; file: string }>;
    pinned: Map<string, { lease: string; path: string }>;
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

function hasLiveClaim(name: string, pattern: RegExp): boolean {
    const match = pattern.exec(name);
    return match !== null && alive(Number(match[1]));
}

function hasLiveLease(files: string[]): boolean {
    return files.some((name) => hasLiveClaim(name, LEASE_RE));
}

/** Staged copies keep their basename for native file uploads. */
function isStagedName(name: string): boolean {
    return name !== "" && name !== "." && name !== ".." && !STAGED_NAME_INVALID_RE.test(name);
}

export function isMediaCachePath(path: string): boolean {
    return path.split(PATH_SEPARATOR_RE).some((part) => CACHE_COMPONENT_RE.test(part));
}

async function readOwner(dir: string): Promise<Owner | undefined> {
    const marker = join(dir, META);
    const info = await lstat(marker);
    if (!info.isFile() || info.nlink !== 1) return undefined;
    return cacheOwnerSchema.safeParse(JSON.parse(await readFile(marker, "utf8"))).data;
}

/** Private adapter cache. Only its marked, flat entries are candidates for deletion. */
export class MediaCache {
    private readonly roots = new Set<string>();
    private readonly cacheName: string;
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
        const owner = options.owner;
        const key =
            owner === undefined
                ? undefined
                : createHash("sha256").update(JSON.stringify(owner)).digest("hex").slice(0, 32);
        this.cacheName = key === undefined ? CACHE_DIR : `.napuketto-media-v2-${key}`;
        this.roots.add(resolve(MEDIA_TEMP_ROOT, this.cacheName));
        if (options.root) this.roots.add(resolve(options.root, this.cacheName));
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
        if (scopes.getStore()?.cache === this) return await task();
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
            [...scope.owned].map(([dir, { lifetime, file }]) =>
                locked(dirname(dir), async () => {
                    if (success && lifetime === "reference") {
                        await this.mark(dir, "reference", this.now() + this.ttl, { file });
                    } else {
                        await this.remove(dir);
                    }
                }),
            ),
        );
        const released = await Promise.allSettled(
            [...scope.pinned].map(([dir, { lease }]) =>
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
        inputName?: string,
    ): Promise<string> {
        if (!EXTENSION_RE.test(extension)) {
            throw kernelError("非法媒体缓存扩展名", "INVALID_PARAM");
        }
        if (inputName !== undefined && (!isStagedName(inputName) || lifetime !== "temporary")) {
            throw kernelError("非法媒体副本文件名", "INVALID_PARAM");
        }
        await mkdir(resolve(base), { recursive: true, mode: 0o700 });
        const baseDir = await realpath(resolve(base));
        await this.checkDirectory(baseDir);
        const root = join(baseDir, this.cacheName);
        this.roots.add(root);
        const dir = await this.allocate(root, inputName);
        const scope = scopes.getStore();
        try {
            const output = await this.writeEntry(dir, extension, writer, inputName);
            await locked(root, async () => {
                const bytes = await this.collect(root);
                if (bytes > this.maxBytes) {
                    throw kernelError(
                        "媒体缓存容量已满（引用期限或使用中租约保护）",
                        "INVALID_STATE",
                    );
                }
                // Without an action scope, the caller consumes the returned path later.
                if (scope === undefined && inputName === undefined) {
                    await this.mark(dir, "reference", this.now() + this.ttl, {
                        file: basename(output),
                    });
                }
            });
            if (scope !== undefined) scope.owned.set(dir, { lifetime, file: basename(output) });
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

    private async allocate(root: string, inputName: string | undefined): Promise<string> {
        return await locked(root, async () => {
            await mkdir(root, { recursive: true, mode: 0o700 });
            await this.checkRoot(root);
            await this.collect(root);
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidate = join(root, `entry-${process.pid}-${randomUUID()}`);
                try {
                    await mkdir(candidate, { mode: 0o700 });
                } catch (err) {
                    if (err instanceof Error && "code" in err && err.code === "EEXIST") continue;
                    throw err;
                }
                pin(candidate);
                try {
                    await this.mark(candidate, "temporary", this.now() + this.orphanTtl, {
                        inputName,
                    });
                } catch (err) {
                    unpin(candidate);
                    await rmdir(candidate);
                    throw err;
                }
                return candidate;
            }
            throw kernelError("媒体缓存命名冲突", "INVALID_STATE");
        });
    }

    private async writeEntry(
        dir: string,
        extension: string,
        writer: (path: string) => Promise<string> | Promise<void>,
        inputName: string | undefined,
    ): Promise<string> {
        const path =
            inputName === undefined
                ? join(dir, `media${extension}`)
                : join(dir, STAGED_DIR, inputName);
        if (inputName !== undefined) await mkdir(dirname(path), { mode: 0o700 });
        const output = (await writer(path)) ?? path;
        const info = await lstat(output);
        const validPath =
            inputName === undefined
                ? dirname(resolve(output)) === dir && CACHE_FILE_RE.test(basename(output))
                : output === path;
        if (!validPath || !info.isFile()) {
            throw kernelError("媒体缓存输出超出受控目录", "INVALID_STATE");
        }
        return output;
    }

    async sweep(): Promise<void> {
        for (const configuredRoot of this.roots) {
            let root: string;
            try {
                root = join(await realpath(dirname(configuredRoot)), this.cacheName);
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
        if (basename(root) === this.cacheName) await this.checkDirectory(dirname(root));
        await this.checkDirectory(root);
    }

    private async checkDirectory(root: string): Promise<void> {
        const info = await lstat(root);
        if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (uid !== undefined && (info.uid !== uid || (info.mode & 0o022) !== 0)) ||
            (await realpath(root)) !== root
        ) {
            throw kernelError("媒体缓存目录归属或边界无效", "INVALID_STATE");
        }
    }

    private async leaseReference(scope: Scope, path: string): Promise<string> {
        const dir = dirname(path);
        const root = dirname(dir);
        if (
            basename(root) !== this.cacheName ||
            !ENTRY_RE.test(basename(dir)) ||
            !CACHE_FILE_RE.test(basename(path)) ||
            !(await this.ownsRoot(root))
        ) {
            throw kernelError("媒体缓存引用归属无效", "INVALID_PARAM");
        }
        await locked(root, async () => {
            const pinned = scope.pinned.get(dir);
            if (pinned !== undefined) {
                if (pinned.path !== path) throw kernelError("媒体缓存文件不匹配", "INVALID_PARAM");
                return;
            }
            await this.checkRoot(root);
            if ((await realpath(dir)) !== dir || !(await lstat(dir)).isDirectory()) {
                throw kernelError("媒体缓存引用边界无效", "INVALID_PARAM");
            }
            const lease = `.lease-${process.pid}-${randomUUID()}`;
            const leasePath = join(dir, lease);
            await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
            try {
                await this.checkReference(dir, path);
                pin(dir);
                scope.pinned.set(dir, { lease, path });
            } catch (err) {
                await unlink(leasePath).catch((cleanup: unknown) => {
                    if (!missing(cleanup)) throw cleanup;
                });
                throw err;
            }
        });
        return path;
    }

    private async checkReference(dir: string, path: string): Promise<void> {
        const files = await readdir(dir);
        const owner = await readOwner(dir);
        const info = await lstat(path);
        if (
            owner?.lifetime !== "reference" ||
            owner.expires <= this.now() ||
            owner.file !== basename(path) ||
            files.some((name) => hasLiveClaim(name, COLLECT_RE)) ||
            !info.isFile() ||
            info.nlink !== 1 ||
            (await realpath(path)) !== path
        ) {
            throw kernelError("媒体缓存引用无效或已过期", "INVALID_PARAM");
        }
    }

    private async ownsRoot(root: string): Promise<boolean> {
        for (const configuredRoot of this.roots) {
            try {
                if (join(await realpath(dirname(configuredRoot)), this.cacheName) === root) {
                    return true;
                }
            } catch (err) {
                if (!missing(err)) throw err;
            }
        }
        return false;
    }

    static async leasePath(path: string): Promise<string> {
        const scope = scopes.getStore();
        if (scope === undefined || !isAbsolute(path)) {
            throw kernelError("媒体缓存引用缺少账号作用域或绝对路径", "INVALID_PARAM");
        }
        try {
            return await scope.cache.leaseReference(scope, resolve(path));
        } catch (err) {
            if (!missing(err)) throw err;
            throw kernelError("媒体缓存引用不存在", "INVALID_PARAM");
        }
    }

    static async leaseInternal(
        base: string,
        account: string,
        entry: string,
        file: string,
    ): Promise<string> {
        const cache = scopes.getStore()?.cache;
        if (cache === undefined || !ENTRY_RE.test(entry) || !CACHE_FILE_RE.test(file)) {
            throw kernelError("内部媒体引用无效", "INVALID_PARAM");
        }
        const owner = cache.options.owner;
        if (owner?.protocol !== "satori" || owner.account !== account) {
            throw kernelError("内部媒体引用归属无效", "INVALID_PARAM");
        }
        try {
            return await MediaCache.leasePath(
                join(await realpath(base), cache.cacheName, entry, file),
            );
        } catch (err) {
            if (!missing(err)) throw err;
            throw kernelError("内部媒体引用不存在", "INVALID_PARAM");
        }
    }

    private async mark(
        dir: string,
        lifetime: Lifetime,
        expires: number,
        details: { file?: string; inputName?: string | undefined } = {},
    ): Promise<void> {
        await this.checkRoot(dirname(dir));
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(dir)) !== dir) {
            throw kernelError("媒体缓存条目边界无效", "INVALID_STATE");
        }
        const metadata = join(dir, META);
        const next = join(dir, `.owner-next-${randomUUID()}.json`);
        try {
            await writeFile(next, JSON.stringify({ version: 1, lifetime, expires, ...details }), {
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
        if (!files.includes(META)) return undefined;
        const parsed = await readOwner(dir);
        if (parsed === undefined) return undefined;
        const summary = await this.summarize(dir, files, parsed.inputName);
        if (summary === undefined) return undefined;
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

    private async summarize(
        dir: string,
        files: string[],
        inputName: string | undefined,
    ): Promise<Contents | undefined> {
        const out: Contents = { bytes: 0, removable: true, files: [], directories: [] };
        for (const file of files) {
            const item = await this.summarizeFile(dir, file, inputName);
            if (item === undefined) return undefined;
            out.bytes += item.bytes;
            out.removable &&= item.removable;
            out.files.push(...item.files);
            out.directories.push(...item.directories);
        }
        return out;
    }

    private async summarizeFile(
        dir: string,
        file: string,
        inputName: string | undefined,
    ): Promise<Contents | undefined> {
        const path = join(dir, file);
        const stat = await lstat(path);
        const stagedName = file === STAGED_DIR ? inputName : undefined;
        if (stat.isDirectory() && (stagedName !== undefined || VIDEO_DIR_RE.test(file))) {
            return await this.summarizeDirectory(path, file, stagedName);
        }
        const regular = stat.isFile();
        if (file === META && !regular) return undefined;
        return {
            bytes: file === META ? 0 : regular ? stat.size : Number.POSITIVE_INFINITY,
            removable:
                regular && (file === META || OWNED_FILE_RE.test(file) || COLLECT_RE.test(file)),
            files: [file],
            directories: [],
        };
    }

    private async summarizeDirectory(
        path: string,
        file: string,
        stagedName: string | undefined,
    ): Promise<Contents> {
        const nested =
            stagedName === undefined
                ? await this.videoOutput(path)
                : await this.stagedOutput(path, stagedName);
        return nested === undefined
            ? { bytes: Number.POSITIVE_INFINITY, removable: false, files: [], directories: [] }
            : {
                  bytes: nested.bytes,
                  removable: true,
                  files: nested.files.map((name) => join(file, name)),
                  directories: [...nested.directories.map((name) => join(file, name)), file],
              };
    }

    private async stagedOutput(dir: string, inputName: string): Promise<Contents | undefined> {
        if ((await realpath(dir)) !== dir) return undefined;
        const out: Contents = { bytes: 0, removable: true, files: [], directories: [] };
        for (const name of await readdir(dir)) {
            const path = join(dir, name);
            if (name === inputName) {
                const info = await lstat(path);
                if (!info.isFile() || info.nlink !== 1) return undefined;
                out.bytes += info.size;
                out.files.push(name);
            } else {
                if (!VIDEO_DIR_RE.test(name)) return undefined;
                const video = await this.videoOutput(path);
                if (video === undefined) return undefined;
                out.bytes += video.bytes;
                out.files.push(...video.files.map((file) => join(name, file)));
                out.directories.push(name);
            }
        }
        return out;
    }

    private async videoOutput(dir: string): Promise<Contents | undefined> {
        if ((await realpath(dir)) !== dir || !(await lstat(dir)).isDirectory()) return undefined;
        const files = await readdir(dir);
        const [file] = files;
        if (file === undefined) return { bytes: 0, files, directories: [], removable: true };
        if (files.length !== 1 || file !== "output.mp4") return undefined;
        const info = await lstat(join(dir, file));
        return info.isFile() && !info.isSymbolicLink()
            ? { bytes: info.size, files, directories: [], removable: true }
            : undefined;
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
            if (this.canCollect(entry)) {
                await this.remove(dir).catch((err: unknown) => {
                    if (!missing(err)) throw err;
                });
            } else {
                total += entry.bytes;
            }
        }
        return total;
    }

    private canCollect(entry: Entry): boolean {
        return (
            entry.removable &&
            !active.has(entry.dir) &&
            !entry.foreignLive &&
            entry.owner.expires <= this.now()
        );
    }

    private async remove(dir: string): Promise<void> {
        await this.checkRoot(dirname(dir));
        if ((await realpath(dir)) !== dir || !(await lstat(dir)).isDirectory()) return;
        const claim = `.collect-${process.pid}-${randomUUID()}`;
        const marker = join(dir, claim);
        // Publish intent before rechecking leases. A concurrent reader sees the claim
        // or the collector sees its lease. Either way, they cannot use/delete together.
        await writeFile(marker, "", { flag: "wx", mode: 0o600 });
        try {
            const entry = await this.inspect(dir);
            if (
                entry === undefined ||
                !entry.removable ||
                hasLiveLease(entry.files) ||
                entry.files.some((name) => name !== claim && hasLiveClaim(name, COLLECT_RE))
            )
                return;
            await this.removeContents(entry, claim);
        } finally {
            await unlink(marker).catch((err: unknown) => {
                if (!missing(err)) throw err;
            });
        }
        await rmdir(dir).catch((err: unknown) => {
            if (
                !missing(err) &&
                !(err instanceof Error && "code" in err && err.code === "ENOTEMPTY")
            )
                throw err;
        });
    }

    private async removeContents(entry: Entry, claim: string): Promise<void> {
        const { dir } = entry;
        for (const file of entry.files.filter((name) => name !== META && name !== claim)) {
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
    inputName?: string,
): Promise<string> {
    return await (scopes.getStore()?.cache ?? new MediaCache()).create(
        root,
        extension,
        writer,
        lifetime,
        inputName,
    );
}

/** Lease a reference explicitly supplied by a caller. No temporary files are eligible. */
export const leaseMediaReference = MediaCache.leasePath;

/** Only the current Satori account can consume its internal IDs. */
export const leaseInternalMedia = MediaCache.leaseInternal;
