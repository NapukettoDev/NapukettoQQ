/** 媒体缓存服务编排与动作侧入口。 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { errorMessage, kernelError } from "@napuketto/kernel";
import { collect, remove } from "./collector.js";
import { checkDirectory, checkRoot } from "./fs-inspector.js";
import { leaseInternal, leasePath } from "./lease.js";
import {
    CACHE_DIR,
    CACHE_FILE_RE,
    type CacheOptions,
    DAY,
    EXTENSION_RE,
    isStagedName,
    type Lifetime,
    MEDIA_TEMP_ROOT,
    META,
    missing,
    type Scope,
    STAGED_DIR,
} from "./schema.js";
import { locked, pin, scopes, unpin } from "./scope.js";

/** 只回收带所有权标记且符合目录布局的适配器缓存条目。 */
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

    /** 嵌套调用共享租约，直至最外层动作结束。 */
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (scopes.getStore()?.cache === this) return await task();
        const scope: Scope = {
            cache: this,
            lease: {
                cacheName: this.cacheName,
                roots: this.roots,
                options: this.options,
                now: () => this.now(),
            },
            owned: new Map(),
            pinned: new Map(),
            failed: false,
        };
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
                        await remove(dir, this.cacheName);
                    }
                }),
            ),
        );
        const released = await Promise.allSettled(
            [...scope.pinned].map(([dir, { lease }]) =>
                locked(dirname(dir), async () => {
                    try {
                        await checkRoot(dirname(dir), this.cacheName);
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

    /** 下载或写入前先分配条目；写入方可返回同条目内重命名后的文件。 */
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
        await checkDirectory(baseDir);
        const root = join(baseDir, this.cacheName);
        this.roots.add(root);
        const dir = await this.allocate(root, inputName);
        const scope = scopes.getStore();
        try {
            const output = await this.writeEntry(dir, extension, writer, inputName);
            await locked(root, async () => {
                const bytes = await collect(root, this.cacheName, () => this.now());
                if (bytes > this.maxBytes) {
                    throw kernelError(
                        "媒体缓存容量已满（引用期限或使用中租约保护）",
                        "INVALID_STATE",
                    );
                }
                // 无动作作用域时，调用方会在返回后再消费该路径。
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
                await locked(root, () => remove(dir, this.cacheName));
            } finally {
                unpin(dir);
            }
            throw err;
        }
    }

    private async allocate(root: string, inputName: string | undefined): Promise<string> {
        return await locked(root, async () => {
            await mkdir(root, { recursive: true, mode: 0o700 });
            await checkRoot(root, this.cacheName);
            await collect(root, this.cacheName, () => this.now());
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
                    await checkRoot(root, this.cacheName);
                } catch (err) {
                    if (missing(err)) return;
                    throw err;
                }
                await collect(root, this.cacheName, () => this.now());
            });
        }
    }

    static leasePath(path: string): Promise<string> {
        return leasePath(path);
    }

    static leaseInternal(
        base: string,
        account: string,
        entry: string,
        file: string,
    ): Promise<string> {
        return leaseInternal(base, account, entry, file, (path) => MediaCache.leasePath(path));
    }

    private async mark(
        dir: string,
        lifetime: Lifetime,
        expires: number,
        details: { file?: string; inputName?: string | undefined } = {},
    ): Promise<void> {
        await checkRoot(dirname(dir), this.cacheName);
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
}

/** 未装配适配器或注册表的动作可自行建立缓存作用域。 */
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

/** 调用方显式传入的已发布引用可申请租约；临时文件不参与。 */
export const leaseMediaReference = MediaCache.leasePath;

/** 内部引用仅由当前 Satori 账号消费。 */
export const leaseInternalMedia = MediaCache.leaseInternal;
