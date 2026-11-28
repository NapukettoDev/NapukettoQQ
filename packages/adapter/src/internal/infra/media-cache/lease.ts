/** 缓存引用租约签发、引用校验与 Satori 内部引用解析。 */
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { kernelError } from "@napuketto/kernel";
import { checkRoot, readOwner } from "./fs-inspector.js";
import {
    CACHE_FILE_RE,
    COLLECT_RE,
    ENTRY_RE,
    hasLiveClaim,
    missing,
    type Scope,
} from "./schema.js";
import { locked, pin, scopes } from "./scope.js";

async function leaseReference(scope: Scope, path: string): Promise<string> {
    const { cacheName, roots, now } = scope.lease;
    const dir = dirname(path);
    const root = dirname(dir);
    if (
        basename(root) !== cacheName ||
        !ENTRY_RE.test(basename(dir)) ||
        !CACHE_FILE_RE.test(basename(path)) ||
        !(await ownsRoot(root, roots, cacheName))
    ) {
        throw kernelError("媒体缓存引用归属无效", "INVALID_PARAM");
    }
    await locked(root, async () => {
        const pinned = scope.pinned.get(dir);
        if (pinned !== undefined) {
            if (pinned.path !== path) throw kernelError("媒体缓存文件不匹配", "INVALID_PARAM");
            return;
        }
        await checkRoot(root, cacheName);
        if ((await realpath(dir)) !== dir || !(await lstat(dir)).isDirectory()) {
            throw kernelError("媒体缓存引用边界无效", "INVALID_PARAM");
        }
        const lease = `.lease-${process.pid}-${randomUUID()}`;
        const leasePath = join(dir, lease);
        await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
        try {
            await checkReference(dir, path, now);
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

async function checkReference(dir: string, path: string, now: () => number): Promise<void> {
    const files = await readdir(dir);
    const owner = await readOwner(dir);
    const info = await lstat(path);
    if (
        owner?.lifetime !== "reference" ||
        owner.expires <= now() ||
        owner.file !== basename(path) ||
        files.some((name) => hasLiveClaim(name, COLLECT_RE)) ||
        !info.isFile() ||
        info.nlink !== 1 ||
        (await realpath(path)) !== path
    ) {
        throw kernelError("媒体缓存引用无效或已过期", "INVALID_PARAM");
    }
}

async function ownsRoot(
    root: string,
    roots: ReadonlySet<string>,
    cacheName: string,
): Promise<boolean> {
    for (const configuredRoot of roots) {
        try {
            if (join(await realpath(dirname(configuredRoot)), cacheName) === root) {
                return true;
            }
        } catch (err) {
            if (!missing(err)) throw err;
        }
    }
    return false;
}

export async function leasePath(path: string): Promise<string> {
    const scope = scopes.getStore();
    if (scope === undefined || !isAbsolute(path)) {
        throw kernelError("媒体缓存引用缺少账号作用域或绝对路径", "INVALID_PARAM");
    }
    try {
        return await leaseReference(scope, resolve(path));
    } catch (err) {
        if (!missing(err)) throw err;
        throw kernelError("媒体缓存引用不存在", "INVALID_PARAM");
    }
}

export async function leaseInternal(
    base: string,
    account: string,
    entry: string,
    file: string,
    resolveLeasePath: (path: string) => Promise<string>,
): Promise<string> {
    const context = scopes.getStore()?.lease;
    if (context === undefined || !ENTRY_RE.test(entry) || !CACHE_FILE_RE.test(file)) {
        throw kernelError("内部媒体引用无效", "INVALID_PARAM");
    }
    const owner = context.options.owner;
    if (owner?.protocol !== "satori" || owner.account !== account) {
        throw kernelError("内部媒体引用归属无效", "INVALID_PARAM");
    }
    try {
        return await resolveLeasePath(join(await realpath(base), context.cacheName, entry, file));
    } catch (err) {
        if (!missing(err)) throw err;
        throw kernelError("内部媒体引用不存在", "INVALID_PARAM");
    }
}
