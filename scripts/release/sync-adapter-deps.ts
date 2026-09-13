#!/usr/bin/env node
/**
 * sync-adapter-deps.ts：koishi 适配器依赖同步 CLI（发布链一环）。
 *
 * 用法（Node 22.7+ 原生 type stripping，零构建直接跑）：
 *   node scripts/release/sync-adapter-deps.ts            # 查询 registry latest 并改写依赖范围
 *   node scripts/release/sync-adapter-deps.ts --dry-run  # 只打印计划，不改写
 *   node scripts/release/sync-adapter-deps.ts --pkg=<path>  # 指定插件 package.json（默认 apps/koishi-plugin-adapter）
 *
 * 行为：
 *   - 查询 npm registry 上 @napuketto/kernel、@napuketto/loader 的 latest
 *   - 把 koishi 插件 dependencies 中对应项改写为 `~<latest>`
 *   - 幂等：已是 `~latest` 则 no-op（退出码 0）
 *   - registry 不可达 / 响应畸形 → 抛错退出（退出码非 0，发布链中断，避免发残缺包）
 *
 * 纯逻辑在 ./sync-adapter-deps-core.ts（可单测），本文件只做
 * 网络请求 + 文件读写 + 参数解析。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { latestFromDistTags, planSync, TRACKED_PACKAGES } from "./sync-adapter-deps-core.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const DEFAULT_PKG = resolve(REPO_ROOT, "apps", "koishi-plugin-adapter", "package.json");
const REGISTRY = process.env["NAPKETTO_REGISTRY"] ?? "https://registry.npmjs.org";

/** 命令行参数解析结果。 */
export interface SyncArgs {
    /** 只打印计划，不改写文件。 */
    dryRun: boolean;
    /** 插件 package.json 绝对路径。 */
    pkgPath: string;
}

/** 解析命令行参数（--dry-run / --pkg=）。 */
export function parseArgs(argv: readonly string[]): SyncArgs {
    let dryRun = false;
    let pkgPath = DEFAULT_PKG;
    for (const arg of argv) {
        if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg.startsWith("--pkg=")) {
            pkgPath = resolve(arg.slice("--pkg=".length));
        }
    }
    return { dryRun, pkgPath };
}

/** npm registry 包响应（只取 dist-tags 字段）。 */
interface RegistryResponse {
    "dist-tags"?: Record<string, string>;
}

/** 查询单个 npm 包 registry（返回 dist-tags）。 */
export async function fetchDistTags(pkg: string): Promise<Record<string, string>> {
    const url = `${REGISTRY}/${pkg.replace(/\//g, "%2F")}`;
    const res = await fetch(url, {
        headers: { accept: "application/json" },
        // 发布链环节：registry 不可达直接失败，不静默兜底
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        throw new Error(`registry 查询失败 ${pkg}: HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as RegistryResponse;
    if (body["dist-tags"] === undefined) {
        throw new Error(`registry 响应畸形（缺 dist-tags）: ${pkg}`);
    }
    return body["dist-tags"];
}

/** 查询多个包的 latest 版本（串行，避免并发打爆 registry）。 */
export async function fetchLatestVersions(
    pkgs: readonly string[],
): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const pkg of pkgs) {
        result[pkg] = latestFromDistTags(await fetchDistTags(pkg));
    }
    return result;
}

/** 读取插件 package.json（返回解析对象 + dependencies 引用）。 */
export async function readPluginPkg(pkgPath: string): Promise<{
    pkg: Record<string, unknown>;
    dependencies: Record<string, string>;
}> {
    let raw: string;
    try {
        raw = await readFile(pkgPath, "utf8");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`无法读取 ${pkgPath}: ${message}`);
    }
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const dependencies = (pkg["dependencies"] ?? {}) as Record<string, string>;
    return { pkg, dependencies };
}

/** 主流程（可被 CLI 或测试直接调用）。 */
export async function main(args: readonly string[]): Promise<number> {
    const { dryRun, pkgPath } = parseArgs(args);
    const { pkg, dependencies } = await readPluginPkg(pkgPath);
    const latest = await fetchLatestVersions(TRACKED_PACKAGES);

    const changes = planSync(dependencies, latest);
    if (changes.length === 0) {
        console.log(`[sync-adapter-deps] 依赖已最新（${TRACKED_PACKAGES.join(", ")}），无需改写`);
        return 0;
    }

    for (const change of changes) {
        console.log(
            `[sync-adapter-deps] ${change.pkg}: ${change.from} → ${change.to}` +
                (dryRun ? "（dry-run，未写入）" : ""),
        );
    }

    if (!dryRun) {
        for (const change of changes) {
            dependencies[change.pkg] = change.to;
        }
        pkg["dependencies"] = dependencies;
        await writeFile(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`, "utf8");
        console.log(`[sync-adapter-deps] ✅ 已写入 ${pkgPath}`);
    }
    return 0;
}

// 直接执行（非被 import 测试）时运行
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[sync-adapter-deps] ❌ ${message}\n`);
            process.exitCode = 1;
        });
}
