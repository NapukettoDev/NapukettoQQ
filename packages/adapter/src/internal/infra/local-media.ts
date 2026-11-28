import { type BigIntStats, constants, createWriteStream } from "node:fs";
import { type FileHandle, lstat, open, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { kernelError } from "@napuketto/kernel";
import {
    cacheMediaFile,
    isMediaCachePath,
    leaseMediaReference,
    MEDIA_TEMP_ROOT,
} from "./media-cache.js";

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const WINDOWS = process.platform === "win32";
const DEVICE_RE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const DRIVE_PATH_RE = /^[a-z]:[\\/]/i;
const NETWORK_PATH_RE = /^[\\/]{2}/;
const PATH_SEPARATOR_RE = /[\\/]/;
const WINDOWS_INVALID_NAME_RE = /[<>:"|?*]|[ .]$/;
const FILE_SCHEME_RE = /^file:/i;
const FILE_URI_RE = /^file:\/\//i;
const EXTENSION_RE = /\.[a-z0-9]+$/i;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function denied() {
    return kernelError("本地媒体路径未授权或文件不可用", "INVALID_PARAM");
}

function validateWindowsPath(path: string): void {
    if (isAbsolute(path) && !DRIVE_PATH_RE.test(path)) throw denied();
    const components = path.replace(DRIVE_PATH_RE, "").split(PATH_SEPARATOR_RE);
    for (const part of components) {
        if (part === "." || part === "..") continue;
        if (WINDOWS_INVALID_NAME_RE.test(part) || DEVICE_RE.test(part)) throw denied();
    }
}

function validatePath(path: string): string {
    if (path === "" || path.includes("\0") || NETWORK_PATH_RE.test(path)) throw denied();
    if (URI_SCHEME_RE.test(path) && !(WINDOWS && DRIVE_PATH_RE.test(path))) throw denied();
    if (WINDOWS) validateWindowsPath(path);
    return path;
}

function decodeLocalPath(input: string): string {
    if (!FILE_SCHEME_RE.test(input)) return validatePath(input);
    try {
        if (!FILE_URI_RE.test(input)) throw denied();
        const url = new URL(input);
        if (url.search || url.hash || url.hostname !== "") throw denied();
        return validatePath(fileURLToPath(url));
    } catch {
        throw denied();
    }
}

/** Resolve configuration relative to the trusted host base, never to a request path. */
export function bindLocalMediaRoots(
    base: string | undefined,
    configured: (() => readonly string[] | undefined) | undefined,
): () => readonly string[] {
    const anchor = resolve(base ?? ".");
    return () => (configured?.() ?? []).map((root) => resolve(anchor, validatePath(root)));
}

function within(root: string, path: string): boolean {
    return path.startsWith(root.endsWith(sep) ? root : root + sep) && path !== root;
}

function unavailable(err: unknown): boolean {
    return (
        err instanceof Error &&
        "code" in err &&
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(err.code))
    );
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
}

interface MediaCandidate {
    root: string;
    path: string;
    before: BigIntStats;
}

function withinInputRoot(root: string, path: string): boolean {
    return WINDOWS ? within(root.toLowerCase(), path.toLowerCase()) : within(root, path);
}

async function findCandidate(
    input: string,
    configuredRoot: string,
): Promise<MediaCandidate | undefined> {
    try {
        const root = validatePath(await realpath(configuredRoot));
        // Before following an absolute input, restrict it to the configured tree.
        const candidate = resolve(root, input);
        if (!withinInputRoot(root, candidate) && !withinInputRoot(configuredRoot, candidate))
            return undefined;
        const path = validatePath(await realpath(candidate));
        if (!within(root, path) || isMediaCachePath(path)) throw denied();
        const before = await lstat(path, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw denied();
        return { root, path, before };
    } catch (err) {
        if (unavailable(err)) return undefined;
        throw err;
    }
}

async function selectCandidate(input: string, roots: readonly string[]): Promise<MediaCandidate> {
    const matches = new Map<string, MediaCandidate>();
    for (const root of roots) {
        const candidate = await findCandidate(input, resolve(root));
        if (candidate !== undefined) matches.set(candidate.path, candidate);
    }
    if (matches.size !== 1) throw denied();
    const [match] = matches.values();
    if (match === undefined) throw denied();
    return match;
}

async function verifyOpenFile(candidate: MediaCandidate, file: FileHandle): Promise<number> {
    const { root, path, before } = candidate;
    const opened = await file.stat({ bigint: true });
    if (!sameFile(before, opened) || opened.nlink !== 1n || opened.size > MAX_FILE_BYTES) {
        throw denied();
    }
    // Linux can check the path of this exact fd. Windows needs trusted directory ACLs
    // and checks that the visible canonical name still identifies the open file.
    const actual =
        process.platform === "linux"
            ? await readlink(`/proc/self/fd/${file.fd}`)
            : await realpath(path);
    if (actual !== path || !within(root, actual)) throw denied();
    const after = await lstat(actual, { bigint: true });
    if (!sameFile(after, opened) || after.nlink !== 1n) throw denied();
    return Number(opened.size);
}

async function writeSnapshot(file: FileHandle, path: string, size: number): Promise<void> {
    if (size === 0) {
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        return;
    }
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    await pipeline(file.createReadStream({ autoClose: false, start: 0, end: size - 1 }), output);
    if (output.bytesWritten !== size) throw denied();
}

interface LocalMediaSnapshot {
    path: string;
    bytes: number;
}

interface LocalMediaBudget {
    maxBytes: number;
    onPrepared(kind: "copiedBytes" | "reusedReferenceBytes", bytes: number): void;
}

function checkMediaBytes(size: number, maxBytes: number): void {
    if (size > maxBytes) throw kernelError("本地媒体超过消息剩余字节预算", "INVALID_PARAM");
}

async function snapshot(
    candidate: MediaCandidate,
    cacheDir: string,
    lifetime: "temporary" | "reference",
    maxBytes = MAX_FILE_BYTES,
): Promise<LocalMediaSnapshot> {
    const linuxFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const file = await open(candidate.path, WINDOWS ? "r" : linuxFlags);
    try {
        const size = await verifyOpenFile(candidate, file);
        checkMediaBytes(size, maxBytes);
        const name = basename(candidate.path);
        const extension = EXTENSION_RE.exec(name)?.[0] ?? ".bin";
        const path = await cacheMediaFile(
            cacheDir,
            extension,
            (path) => writeSnapshot(file, path, size),
            lifetime,
            lifetime === "temporary" ? name : undefined,
        );
        return { path, bytes: size };
    } finally {
        await file.close();
    }
}

/** The result is safe to hand to consumers that reopen a path, including native APIs. */
export async function resolveLocalMedia(
    input: string,
    roots: readonly string[] = [],
    budget?: LocalMediaBudget,
): Promise<string> {
    const path = decodeLocalPath(input);
    if (isMediaCachePath(path)) {
        const reference = await leaseMediaReference(path);
        if (budget !== undefined) {
            const { size } = await lstat(reference);
            checkMediaBytes(size, Math.min(MAX_FILE_BYTES, budget.maxBytes));
            budget.onPrepared("reusedReferenceBytes", size);
        }
        return reference;
    }
    try {
        const result = await snapshot(
            await selectCandidate(path, roots),
            MEDIA_TEMP_ROOT,
            "temporary",
            budget?.maxBytes,
        );
        budget?.onPrepared("copiedBytes", result.bytes);
        return result.path;
    } catch (err) {
        if (unavailable(err)) throw denied();
        throw err;
    }
}

/** QQ sources come from a current-account message/API response, never from RPC path fields. */
export async function exportQqMedia(
    source: string,
    qqRoot: string | undefined,
    cacheDir: string | undefined,
): Promise<string | undefined> {
    if (!source || !qqRoot) return undefined;
    try {
        const input = validatePath(source.replaceAll("\\", sep));
        const candidate = await findCandidate(input, resolve(qqRoot));
        if (candidate === undefined) return undefined;
        return (await snapshot(candidate, cacheDir || MEDIA_TEMP_ROOT, "reference")).path;
    } catch (err) {
        if (
            unavailable(err) ||
            (err instanceof Error && "code" in err && err.code === "INVALID_PARAM")
        ) {
            return undefined;
        }
        throw err;
    }
}
