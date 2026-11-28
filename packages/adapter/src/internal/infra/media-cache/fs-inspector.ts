/** 缓存目录边界核验与受控条目只读巡检。 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { kernelError } from "@napuketto/kernel";
import {
    alive,
    COLLECT_RE,
    type Contents,
    cacheOwnerSchema,
    ENTRY_RE,
    type Entry,
    hasLiveLease,
    META,
    OWNED_FILE_RE,
    type Owner,
    STAGED_DIR,
    uid,
    VIDEO_DIR_RE,
} from "./schema.js";

export async function checkRoot(root: string, cacheName: string): Promise<void> {
    if (basename(root) === cacheName) await checkDirectory(dirname(root));
    await checkDirectory(root);
}

export async function checkDirectory(root: string): Promise<void> {
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

export async function readOwner(dir: string): Promise<Owner | undefined> {
    const marker = join(dir, META);
    const info = await lstat(marker);
    if (!info.isFile() || info.nlink !== 1) return undefined;
    return cacheOwnerSchema.safeParse(JSON.parse(await readFile(marker, "utf8"))).data;
}

export async function inspect(dir: string): Promise<Entry | undefined> {
    const match = ENTRY_RE.exec(basename(dir));
    if (match === null) return undefined;
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    const files = await readdir(dir);
    if (!files.includes(META)) return undefined;
    const parsed = await readOwner(dir);
    if (parsed === undefined) return undefined;
    const summary = await summarize(dir, files, parsed.inputName);
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

async function summarize(
    dir: string,
    files: string[],
    inputName: string | undefined,
): Promise<Contents | undefined> {
    const out: Contents = { bytes: 0, removable: true, files: [], directories: [] };
    for (const file of files) {
        const item = await summarizeFile(dir, file, inputName);
        if (item === undefined) return undefined;
        out.bytes += item.bytes;
        out.removable &&= item.removable;
        out.files.push(...item.files);
        out.directories.push(...item.directories);
    }
    return out;
}

async function summarizeFile(
    dir: string,
    file: string,
    inputName: string | undefined,
): Promise<Contents | undefined> {
    const path = join(dir, file);
    const stat = await lstat(path);
    const stagedName = file === STAGED_DIR ? inputName : undefined;
    if (stat.isDirectory() && (stagedName !== undefined || VIDEO_DIR_RE.test(file))) {
        return await summarizeDirectory(path, file, stagedName);
    }
    const regular = stat.isFile();
    if (file === META && !regular) return undefined;
    return {
        bytes: file === META ? 0 : regular ? stat.size : Number.POSITIVE_INFINITY,
        removable: regular && (file === META || OWNED_FILE_RE.test(file) || COLLECT_RE.test(file)),
        files: [file],
        directories: [],
    };
}

async function summarizeDirectory(
    path: string,
    file: string,
    stagedName: string | undefined,
): Promise<Contents> {
    const nested =
        stagedName === undefined ? await videoOutput(path) : await stagedOutput(path, stagedName);
    return nested === undefined
        ? { bytes: Number.POSITIVE_INFINITY, removable: false, files: [], directories: [] }
        : {
              bytes: nested.bytes,
              removable: true,
              files: nested.files.map((name) => join(file, name)),
              directories: [...nested.directories.map((name) => join(file, name)), file],
          };
}

async function stagedOutput(dir: string, inputName: string): Promise<Contents | undefined> {
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
            const video = await videoOutput(path);
            if (video === undefined) return undefined;
            out.bytes += video.bytes;
            out.files.push(...video.files.map((file) => join(name, file)));
            out.directories.push(name);
        }
    }
    return out;
}

async function videoOutput(dir: string): Promise<Contents | undefined> {
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
