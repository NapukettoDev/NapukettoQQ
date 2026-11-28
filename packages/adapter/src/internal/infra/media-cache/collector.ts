/** 缓存过期判定、跨进程回收声明与受控删除。 */
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { kernelError } from "@napuketto/kernel";
import { checkRoot, inspect } from "./fs-inspector.js";
import { COLLECT_RE, type Entry, hasLiveClaim, hasLiveLease, META, missing } from "./schema.js";
import { isPinned } from "./scope.js";

export async function collect(root: string, cacheName: string, now: () => number): Promise<number> {
    let total = 0;
    for (const name of await readdir(root)) {
        const dir = join(root, name);
        let entry: Entry | undefined;
        try {
            entry = await inspect(dir);
        } catch (err) {
            if (missing(err) || err instanceof SyntaxError) continue;
            throw err;
        }
        if (entry === undefined) continue;
        if (canCollect(entry, now)) {
            await remove(dir, cacheName).catch((err: unknown) => {
                if (!missing(err)) throw err;
            });
        } else {
            total += entry.bytes;
        }
    }
    return total;
}

function canCollect(entry: Entry, now: () => number): boolean {
    return (
        entry.removable &&
        !isPinned(entry.dir) &&
        !entry.foreignLive &&
        entry.owner.expires <= now()
    );
}

export async function remove(dir: string, cacheName: string): Promise<void> {
    await checkRoot(dirname(dir), cacheName);
    if ((await realpath(dir)) !== dir || !(await lstat(dir)).isDirectory()) return;
    const claim = `.collect-${process.pid}-${randomUUID()}`;
    const marker = join(dir, claim);
    // 先发布回收声明，再复查租约。并发读取者会看到声明，或回收方会看到租约，避免读取与删除并行。
    await writeFile(marker, "", { flag: "wx", mode: 0o600 });
    try {
        const entry = await inspect(dir);
        if (
            entry === undefined ||
            !entry.removable ||
            hasLiveLease(entry.files) ||
            entry.files.some((name) => name !== claim && hasLiveClaim(name, COLLECT_RE))
        )
            return;
        await removeContents(entry, claim, cacheName);
    } finally {
        await unlink(marker).catch((err: unknown) => {
            if (!missing(err)) throw err;
        });
    }
    await rmdir(dir).catch((err: unknown) => {
        if (!missing(err) && !(err instanceof Error && "code" in err && err.code === "ENOTEMPTY"))
            throw err;
    });
}

async function removeContents(entry: Entry, claim: string, cacheName: string): Promise<void> {
    const { dir } = entry;
    for (const file of entry.files.filter((name) => name !== META && name !== claim)) {
        // 逐个删除前重新核验目录边界和文件类型，禁止递归删除。
        await checkRoot(dirname(dir), cacheName);
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
