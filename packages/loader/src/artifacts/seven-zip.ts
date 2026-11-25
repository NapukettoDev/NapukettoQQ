/**
 * seven-zip.ts：7-Zip 可执行文件定位 / 获取 / 执行（唯一实现，2026-11-25 从
 * locate.ts 与 extract.ts 收拢）。
 *
 * 两个来源原本各写一半：定位侧（Linux 内置 7zz + 数据根缓存 + 官方下载）与执行侧
 * （探测顺序 NAPUKETTO_7Z_PATH > 内置资产 > 系统 PATH + spawn 7z 并包装失败信息）。
 * 合成一个模块后，解包链只有一条 7z 语义来源。
 *
 * ⚠️ `manifests/seven-zip.ts` 不并入：那个文件被 tooling/releases 的脚本用 node
 * 直接执行（类型剥离，零相对 import 红线），本文件可自由 import。
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { resolveDataRoot } from "../shared/data-root.js";
import { packageRoot } from "../shared/package.js";
import { getErrorCode, getErrorMessage } from "../shared/type-guards.js";
import { downloadFile } from "./download.js";
import {
    assertSevenZipHash,
    findBundledSevenZip,
    linuxSevenZip,
    matchesSevenZipHash,
} from "./manifests/seven-zip.js";

/** 7-Zip 可执行文件来源。 */
export interface SevenZipResult {
    /** 7z 可执行文件绝对路径。 */
    exe: string;
    /** 来源说明（内置资产 / 系统 / 环境变量）。 */
    source: string;
}

/** 7z 执行失败时的附加提示。 */
interface SevenZipFailureHint {
    /** 未找到可执行文件时的额外说明（安装指引）。 */
    hint?: string;
}

/**
 * 内置 7z 资产是否适用于当前平台/架构。
 *
 * 内置 `assets/7zip/7zz` 是 **x86-64 ELF**（`e_machine=0x3e`），`7z.exe` 是 x64 PE。
 * 在 Linux arm64 上 exec 会直接 `cannot execute`（2026-11-10 在 arm64 容器实测）——
 * 因此 Linux 非 x64 一律回退到系统 7-Zip（`7zz` / `7z`），不碰内置资产。
 */
export function bundledSevenZipSupported(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): boolean {
    return platform !== "linux" || arch === "x64";
}

/** 在 PATH 里找系统 7-Zip（`7zz` 优先、其次 `7z`）；找不到返回 null。 */
export function findSystemSevenZip(
    pathValue: string = process.env["PATH"] ?? "",
    platform: NodeJS.Platform = process.platform,
): string | null {
    const delimiter = platform === "win32" ? ";" : ":";
    const names = platform === "win32" ? ["7z.exe"] : ["7zz", "7z"];
    for (const dir of pathValue.split(delimiter)) {
        if (dir === "") {
            continue;
        }
        for (const name of names) {
            const candidate = join(dir, name);
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

/**
 * 探测 7z 可执行文件：
 *   NAPUKETTO_7Z_PATH 环境变量 > 内置资产（Windows assets/7zip/7z.exe、Linux
 *   assets/7zip/7zz——2026-08-14 治本，静态二进制已打进发布包；**仅 x64 Linux 可用**）
 *   > 系统 PATH 7z。
 *
 * `platform` / `arch` 参数仅测试注入（缺省取 process）。
 */
export function findSevenZip(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): SevenZipResult {
    const envPath = process.env["NAPUKETTO_7Z_PATH"];
    if (envPath !== undefined && envPath !== "" && existsSync(envPath)) {
        return { exe: envPath, source: "环境变量 NAPUKETTO_7Z_PATH" };
    }
    // 内置资产：dist 与 assets 同层（tsdown 构建后 dist/，资产在包根 assets/）
    if (
        (platform === "win32" || platform === "linux") &&
        bundledSevenZipSupported(platform, arch)
    ) {
        const bundled = findBundledSevenZip(join(packageRoot(), "assets", "7zip"), platform);
        if (bundled !== null) {
            return { exe: bundled, source: "内置资产 assets/7zip" };
        }
    }
    // 系统 PATH（Windows 装了 7-Zip 有 7z.exe；Linux p7zip-full / 7zip 提供 7z）
    const system = findSystemSevenZip(process.env["PATH"] ?? "", platform);
    if (system !== null) {
        return { exe: system, source: "系统 PATH" };
    }
    return { exe: "7z", source: "系统 PATH" };
}

/**
 * 运行 7z 子命令（失败抛带 stderr 与安装指引的错误）。
 * 供 extractInstaller / extractDebInstaller 共用（解包动作留在 extract.ts）。
 */
export async function runSevenZip(
    sevenZip: string,
    args: readonly string[],
    options: SevenZipFailureHint = {},
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        execFile(sevenZip, args, { maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
            if (err === null) {
                resolve();
                return;
            }
            const code = getErrorCode(err);
            const installHint =
                code === "ENOENT"
                    ? `未找到 7z 可执行文件: ${sevenZip}\n` +
                      "（Windows 请安装 7-Zip 或用 NAPUKETTO_7Z_PATH 指定；" +
                      "Linux 自动下载失败时请安装 p7zip-full 或用 NAPUKETTO_7Z_PATH 指定）"
                    : "";
            reject(
                new Error(
                    `7z 解包失败: ${args.join(" ")}\n${stderr.trim()}\n` +
                        `${installHint}${options.hint ?? ""}`,
                ),
            );
        });
    });
}

/** 7-Zip 官方归档或其 HTTPS 镜像。二者使用同一份归档摘要。 */
export function linuxSevenZipUrl(): string {
    const url = URL.parse(process.env["NAPUKETTO_7Z_URL"] ?? linuxSevenZip.archive.url);
    if (url?.protocol !== "https:") {
        throw new Error("NAPUKETTO_7Z_URL 必须是有效的 HTTPS 地址");
    }
    return url.href;
}

/** Linux x64 优先使用内置 7zz，其次复用已验证缓存，再下载固定版本。 */
export async function ensureLinuxSevenZip(
    options: { dataRoot?: string; arch?: string } = {},
): Promise<{ exe: string; source: string }> {
    // 0. 非 x64（arm64 等）：内置 7zz 是 x86-64 ELF，执行会直接 cannot execute
    //    → 只能用系统 7-Zip（数据根缓存与官网下载兜底同样都是 x64 产物，跳过）
    if (!bundledSevenZipSupported("linux", options.arch ?? process.arch)) {
        const system = findSystemSevenZip();
        if (system !== null) {
            return { exe: system, source: "系统 PATH（当前架构无内置 7zz）" };
        }
        throw new Error(
            `当前架构（${options.arch ?? process.arch}）没有可用的 7-Zip：内置 7zz 是 x86-64 二进制，` +
                "无法在本机执行。请安装系统 7-Zip（Debian/Ubuntu: apt install 7zip 或 p7zip-full；" +
                "Fedora: dnf install p7zip），或用 NAPUKETTO_7Z_PATH 指定可执行文件",
        );
    }

    // 1. 内置资产（治本）：dist 与 assets 同层（tsdown 构建后 dist/，资产在包根 assets/）
    const bundled = findBundledSevenZip(join(packageRoot(), "assets", "7zip"), "linux");
    if (bundled !== null) {
        // npm 安装可能丢失执行位，保险设置（失败不阻塞：execFile 报 EACCES 时由调用方提示）
        await chmod(bundled, 0o755).catch(() => {
            // 忽略：无执行位场景后续解包会明确报错，此处不静默吞掉主流程
        });
        return { exe: bundled, source: "内置资产 assets/7zip" };
    }

    // 旧版缓存可复用，但必须与官方文件一致。
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cacheDir = join(dataRoot, "runtime", "7zip");
    const exe = join(cacheDir, "7zz");
    if (existsSync(exe) && matchesSevenZipHash(exe, linuxSevenZip.files["7zz"])) {
        return { exe, source: "数据根缓存 runtime/7zip" };
    }

    await downloadLinuxSevenZip(cacheDir, exe);
    return { exe, source: "自动下载（7-Zip 官方 linux 版）" };
}

/** 下载官方 7z 归档、校验摘要、原子发布 `7zz` 到数据根缓存。 */
async function downloadLinuxSevenZip(cacheDir: string, exe: string): Promise<void> {
    const url = linuxSevenZipUrl();
    mkdirSync(cacheDir, { recursive: true });
    const stagingDir = await mkdtemp(join(cacheDir, ".download-"));
    try {
        const archive = join(stagingDir, linuxSevenZip.archive.name);
        await downloadFile({ dest: archive, url, expectedSha256: linuxSevenZip.archive.sha256 });
        try {
            execFileSync("tar", ["-xJf", archive, "-C", stagingDir, "7zz"], { stdio: "pipe" });
        } catch (err) {
            const message = getErrorMessage(err);
            throw new Error(
                `7z linux 解压失败: ${message}（需 tar + xz-utils；或设 NAPUKETTO_7Z_PATH 指定系统 7z）`,
                { cause: err },
            );
        }
        const stagedExe = join(stagingDir, "7zz");
        assertSevenZipHash(stagedExe, linuxSevenZip.files["7zz"]);
        await chmod(stagedExe, 0o755);
        try {
            await rename(stagedExe, exe);
        } catch (err) {
            // 另一实例可能已经发布了同一文件。
            if (!existsSync(exe) || !matchesSevenZipHash(exe, linuxSevenZip.files["7zz"])) {
                throw err;
            }
        }
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
}

/** 解包用 7z：显式参数优先；Linux 确保内置 7zz 就绪；其他平台交给 findSevenZip 探测。 */
export async function resolveSevenZipPath(
    explicit: string | undefined,
    dataRoot: string,
): Promise<string | undefined> {
    if (explicit !== undefined) {
        return explicit;
    }
    if (process.platform === "linux") {
        return (await ensureLinuxSevenZip({ dataRoot })).exe;
    }
    return undefined;
}
