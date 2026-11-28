/** 缓存命名、所有权元数据与条目判定。 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AdapterLoggerLike } from "../log.js";
import type { MediaCache } from "./index.js";

export const CACHE_DIR = ".napuketto-media-v1";
export const ENTRY_RE = /^entry-(\d+)-[\da-f-]{36}$/;
export const EXTENSION_RE = /^\.[a-zA-Z0-9]+$/;
export const OWNED_FILE_RE =
    /^(?:media\.[a-zA-Z0-9]+(?:\.part-\d+-[\da-f-]{36})?|\.napuketto-[\da-f]{16}\.pcm|\.owner-next-[\da-f-]{36}\.json|\.lease-\d+-[\da-f-]{36})$/;
const PATH_SEPARATOR_RE = /[\\/]/;
const STAGED_NAME_INVALID_RE = /[\\/:]/;
const CACHE_COMPONENT_RE = /^\.napuketto-media-v[12](?:-[\da-f]+)?$/i;
export const CACHE_FILE_RE = /^media\.[a-zA-Z0-9]+$/;
export const COLLECT_RE = /^\.collect-(\d+)-[\da-f-]{36}$/;
export const STAGED_DIR = "input";
export const LEASE_RE = /^\.lease-(\d+)-[\da-f-]{36}$/;
export const VIDEO_DIR_RE = /^\.napuketto-video-[a-zA-Z0-9]{6}$/;
export const DAY = 24 * 60 * 60 * 1000;
export const META = ".owner.json";
export const uid = process.getuid?.();
export const MEDIA_TEMP_ROOT = join(
    tmpdir(),
    uid === undefined ? "napuketto-adapter-media" : `napuketto-adapter-media-${uid}`,
);
export type Lifetime = "temporary" | "reference";
export const cacheOwnerSchema = z.object({
    version: z.literal(1),
    lifetime: z.enum(["temporary", "reference"]),
    expires: z.number(),
    file: z.string().regex(CACHE_FILE_RE).optional(),
    inputName: z.string().refine(isStagedName).optional(),
});
export type Owner = z.infer<typeof cacheOwnerSchema>;
export interface Entry {
    dir: string;
    owner: Owner;
    bytes: number;
    files: string[];
    directories: string[];
    foreignLive: boolean;
    removable: boolean;
}
export interface Contents {
    bytes: number;
    removable: boolean;
    files: string[];
    directories: string[];
}
export interface CacheOptions {
    root?: string | undefined;
    owner?: { protocol: string; account: string };
    logger?: Pick<AdapterLoggerLike, "warn"> | undefined;
    ttlMs?: number;
    orphanTtlMs?: number;
    maxBytes?: number;
    now?: () => number;
}
export interface LeaseContext {
    cacheName: string;
    roots: ReadonlySet<string>;
    options: Pick<CacheOptions, "owner">;
    now: () => number;
}

export interface Scope {
    cache: MediaCache;
    lease: LeaseContext;
    owned: Map<string, { lifetime: Lifetime; file: string }>;
    pinned: Map<string, { lease: string; path: string }>;
    failed: boolean;
}

export function missing(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "ENOENT";
}
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return !(err instanceof Error && "code" in err && err.code === "ESRCH");
    }
}

export function hasLiveClaim(name: string, pattern: RegExp): boolean {
    const match = pattern.exec(name);
    return match !== null && alive(Number(match[1]));
}

export function hasLiveLease(files: string[]): boolean {
    return files.some((name) => hasLiveClaim(name, LEASE_RE));
}

/** 暂存副本保留原文件名，供原生上传接口使用。 */
export function isStagedName(name: string): boolean {
    return name !== "" && name !== "." && name !== ".." && !STAGED_NAME_INVALID_RE.test(name);
}

export function isMediaCachePath(path: string): boolean {
    return path.split(PATH_SEPARATOR_RE).some((part) => CACHE_COMPONENT_RE.test(part));
}
