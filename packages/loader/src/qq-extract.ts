/**
 * qq-extract.ts：QQ 官方安装包解包与提取（P1）。
 *
 * ⚠️ 格式事实（2026-08-12 实测修正）：QQ 官方安装包是 NSIS 自解压格式，
 * **7za standalone 不支持 NSIS**（只支持 7z/zip/tar 等）——必须用完整版
 * 7z（7z.exe + 7z.dll）。设计文档 §2.3 原「内置 7za.exe」修正为：
 *  - Windows：内置 assets/7zip/7z.exe + 7z.dll（7-Zip 官方，LGPL 合规可分发）
 *  - Linux/Docker：系统 p7zip-full（7z 完整版）
 *
 * ⚠️ 提取策略（2026-08-12 实测修正，与设计 §2.3 不同）：
 *  1. NSIS 解包产物在 <extracted>/Files/（NSIS 内部布局），Files/ = 安装根
 *  2. 真实 QQNT.dll（214MB）位于 versions/<v>/QQNT.dll，**自建宿主不需要**
 *     ——stub QQNT.dll 已替代其宿主符号职责（wrapper.node 的 v8/node/napi/qq_magic
 *     符号由 stub 转发到 node.exe）
 *  3. 只提取 resources/app 顶层 *.node + *.dll（wrapper.node 的直接/传递/delay-load
 *     依赖全覆盖，版本无关；跳过 wmpfsdk/avsdk 等大子目录，共约 235MB）
 *
 * 提取目标（与安装目录同构，resolveFromRoot 可直接消费）：
 *   <数据根>/qq-files/<版本>/versions/<版本>/resources/app/   ← *.node + *.dll
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { QqInstallInfo } from "./locate-qq.js";

/** resources/app 下需要提取的文件扩展名（.node 原生模块 + .dll 依赖）。 */
const EXTRACT_EXTENSIONS = new Set([".node", ".dll"]);

/** Linux 运行时额外小文件（Bugly pub.key / TLS 证书 / 版本元数据）。 */
const LINUX_EXTRA_FILES = new Set(["pub.key", "cacert.pem", "package.json", "application.json"]);

/** Linux resources/app 下需要整体保留的子目录（wrapper.node RUNPATH 含 $ORIGIN/sharp-lib）。 */
const LINUX_APP_SUBDIRS = ["sharp-lib"] as const;

/** deb 内层数据归档（data.tar / data.tar.xz / data.tar.gz）。 */
const DEB_DATA_ARCHIVE_RE = /^data\.tar(?:\.[a-z0-9]+)?$/i;

/** deb 解包中间产物（提取完成后清理，data.tar 可达 600MB+）。 */
const DEB_INTERMEDIATE_FILES = [
    "debian-binary",
    "control.tar.gz",
    "control.tar.xz",
    "control.tar",
] as const;

/** Linux app 目录候选（deb 标准位置 opt/QQ/resources/app；兼容扁平/减层解包树）。 */
const LINUX_APP_CANDIDATES = [
    ["opt", "QQ", "resources", "app"],
    ["QQ", "resources", "app"],
    ["resources", "app"],
] as const;

/** 7-Zip 可执行文件来源。 */
export interface SevenZipResult {
    /** 7z 可执行文件绝对路径。 */
    exe: string;
    /** 来源说明（内置资产 / 系统 / 环境变量）。 */
    source: string;
}

/** 提取选项。 */
export interface ExtractOptions {
    /** 安装包绝对路径。 */
    installerPath: string;
    /** 目标版本目录（如 9.9.33-51802）。 */
    version: string;
    /** 缓存根目录（<数据根>/qq-files；版本子目录将建在其下）。 */
    cacheRoot: string;
    /** 7z 可执行文件路径（缺省自动探测）。 */
    sevenZipPath?: string;
}

/**
 * 探测 7z 可执行文件：
 *   NAPUTO_7Z_PATH 环境变量 > 内置资产（Windows assets/7zip/7z.exe、Linux
 *   assets/7zip/7zz——2026-08-14 治本，静态二进制已打进发布包）> 系统 PATH 7z。
 */
export function findSevenZip(): SevenZipResult {
    const envPath = process.env["NAPUTO_7Z_PATH"];
    if (envPath !== undefined && envPath !== "" && existsSync(envPath)) {
        return { exe: envPath, source: "环境变量 NAPUTO_7Z_PATH" };
    }
    // 内置资产：dist 与 assets 同层（tsdown 构建后 dist/，资产在包根 assets/）
    if (process.platform === "win32" || process.platform === "linux") {
        const exeName = process.platform === "win32" ? "7z.exe" : "7zz";
        const bundled = join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "assets",
            "7zip",
            exeName,
        );
        if (existsSync(bundled)) {
            return { exe: bundled, source: "内置资产 assets/7zip" };
        }
    }
    // 系统 PATH（Windows 装了 7-Zip 有 7z.exe；Linux p7zip-full 提供 7z 命令）
    return { exe: "7z", source: "系统 PATH" };
}

/** 解包安装包到指定目录（spawn 7z x，失败抛错）。 */
export async function extractInstaller(
    installerPath: string,
    destDir: string,
    sevenZipPath?: string,
): Promise<void> {
    const sevenZip = sevenZipPath ?? findSevenZip().exe;
    await mkdir(destDir, { recursive: true });
    await runSevenZip(sevenZip, ["x", installerPath, `-o${destDir}`, "-y"], {
        hint: "（QQ 安装包是 NSIS 格式，需完整版 7z 而非 7za）",
    });
}

/** 7z 执行失败时的附加提示。 */
interface SevenZipFailureHint {
    /** 未找到可执行文件时的额外说明（安装指引）。 */
    hint?: string;
}

/** 运行 7z 子命令（失败抛带 stderr 与安装指引的错误）。 */
async function runSevenZip(
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
            const code = (err as NodeJS.ErrnoException).code;
            const installHint =
                code === "ENOENT"
                    ? `未找到 7z 可执行文件: ${sevenZip}\n` +
                      "（Windows 请安装 7-Zip 或用 NAPUTO_7Z_PATH 指定；" +
                      "Linux 自动下载失败时请安装 p7zip-full 或用 NAPUTO_7Z_PATH 指定）"
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

/** 判断 Linux resources/app 顶层文件是否为运行时所需（*.node / *.so / *.so.N + 白名单）。 */
export function isLinuxRuntimeFile(name: string): boolean {
    const lower = name.toLowerCase();
    return (
        lower.endsWith(".node") ||
        lower.endsWith(".so") ||
        lower.includes(".so.") ||
        LINUX_EXTRA_FILES.has(lower)
    );
}

/**
 * 解包 Linux deb：deb(ar) → data.tar[.xz] → 文件树。
 *
 * 三层解包（实测 7-Zip 25.01 支持 Ar，但不递归内层归档）：deb 先出
 * `data.tar.xz`，再出 `data.tar`，最后才是 `opt/QQ/resources/app`。中间产物
 * （data.tar ~600MB）解完立即清理，避免缓存盘被临时文件占满。
 */
export async function extractDebInstaller(
    debPath: string,
    destDir: string,
    sevenZipPath?: string,
): Promise<void> {
    const sevenZip = sevenZipPath ?? findSevenZip().exe;
    await mkdir(destDir, { recursive: true });
    await runSevenZip(sevenZip, ["x", debPath, `-o${destDir}`, "-y"]);
    const dataArchive = (await readdir(destDir)).find((name) => DEB_DATA_ARCHIVE_RE.test(name));
    if (dataArchive === undefined) {
        throw new Error(`deb 解包产物缺少 data.tar*: ${destDir}`);
    }
    const dataArchivePath = join(destDir, dataArchive);
    if (dataArchive !== "data.tar") {
        await runSevenZip(sevenZip, ["x", dataArchivePath, `-o${destDir}`, "-y"]);
    }
    const dataTar = join(destDir, "data.tar");
    if (!existsSync(dataTar)) {
        throw new Error(`deb 解包缺少 data.tar: ${destDir}`);
    }
    await runSevenZip(sevenZip, ["x", dataTar, `-o${destDir}`, "-y"]);
    await rm(dataTar, { force: true });
    if (dataArchivePath !== dataTar) {
        await rm(dataArchivePath, { force: true });
    }
    for (const name of DEB_INTERMEDIATE_FILES) {
        await rm(join(destDir, name), { force: true });
    }
}

/**
 * 从解包目录提取运行所需文件到缓存：
 * resources/app 顶层全部 *.node + *.dll（保持同目录结构，PATH 前置即可解析依赖）。
 * 幂等：目标 wrapper.node 已存在则跳过。
 */
export async function extractWrapperFiles(
    extractedDir: string,
    version: string,
    cacheRoot: string,
): Promise<QqInstallInfo> {
    // NSIS 解包产物在 <extracted>/Files/（安装根），resources/app 在其下
    const appDir = join(extractedDir, "Files", "versions", version, "resources", "app");
    if (!existsSync(join(appDir, "wrapper.node"))) {
        throw new Error(`解包产物缺少 wrapper.node: ${appDir}`);
    }

    // 目标结构（与安装目录同构）：
    //   <cacheRoot>/<version>/versions/<version>/resources/app/*.{node,dll}
    const destAppDir = join(cacheRoot, version, "versions", version, "resources", "app");
    const destWrapper = join(destAppDir, "wrapper.node");

    // 幂等：已提取过则跳过
    if (existsSync(destWrapper)) {
        return buildCachedInfo(cacheRoot, version);
    }

    await mkdir(destAppDir, { recursive: true });
    const entries = await readdir(appDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue; // 跳过子目录（wmpfsdk/avsdk 等大目录不需要）
        }
        const dot = entry.name.lastIndexOf(".");
        const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
        if (!EXTRACT_EXTENSIONS.has(ext)) {
            continue; // 只提取 .node + .dll
        }
        await copyFile(join(appDir, entry.name), join(destAppDir, entry.name));
    }
    if (!existsSync(destWrapper)) {
        throw new Error(`提取失败：wrapper.node 未复制到 ${destWrapper}`);
    }

    return buildCachedInfo(cacheRoot, version);
}

/**
 * 从 deb 解包树提取 Linux 运行时文件到缓存（Windows 同构布局，kernel 无需改路径）：
 *   <cacheRoot>/<version>/versions/<version>/resources/app/
 * 顶层收 *.node / *.so / *.so.N + 小文件白名单；`sharp-lib/` 整体保留
 * （wrapper.node 的 RUNPATH 是 `$ORIGIN:$ORIGIN/sharp-lib`）。
 * 幂等：目标 wrapper.node 已存在则跳过。
 */
export async function extractLinuxWrapperFiles(
    extractedDir: string,
    version: string,
    cacheRoot: string,
): Promise<QqInstallInfo> {
    const appDir = findLinuxAppDir(extractedDir);
    const destAppDir = join(cacheRoot, version, "versions", version, "resources", "app");
    const destWrapper = join(destAppDir, "wrapper.node");

    // 幂等：已提取过则跳过
    if (existsSync(destWrapper)) {
        return buildCachedInfo(cacheRoot, version);
    }

    await mkdir(destAppDir, { recursive: true });
    for (const entry of await readdir(appDir, { withFileTypes: true })) {
        if (!entry.isFile() || !isLinuxRuntimeFile(entry.name)) {
            continue; // 跳过无关子目录（avsdk/resource 等）与非运行时文件
        }
        await copyFile(join(appDir, entry.name), join(destAppDir, entry.name));
    }
    for (const subDir of LINUX_APP_SUBDIRS) {
        const src = join(appDir, subDir);
        if (existsSync(src)) {
            await cp(src, join(destAppDir, subDir), { recursive: true });
        }
    }
    for (const required of ["wrapper.node", "major.node"] as const) {
        if (!existsSync(join(destAppDir, required))) {
            throw new Error(`提取失败：${required} 未复制到 ${destAppDir}`);
        }
    }

    return buildCachedInfo(cacheRoot, version);
}

/** 定位 deb 解包树里的 resources/app（标准 deb 布局 opt/QQ/resources/app）。 */
function findLinuxAppDir(extractedDir: string): string {
    for (const segments of LINUX_APP_CANDIDATES) {
        const appDir = join(extractedDir, ...segments);
        if (existsSync(join(appDir, "wrapper.node"))) {
            return appDir;
        }
    }
    throw new Error(`deb 解包产物缺少 resources/app/wrapper.node（根目录: ${extractedDir}）`);
}

/** 构造 cached 来源的 QqInstallInfo（wrapperPath 指向缓存中 wrapper.node）。 */
function buildCachedInfo(cacheRoot: string, version: string): QqInstallInfo {
    const versionDir = join(cacheRoot, version);
    return {
        qqPath: join(versionDir, "QQ.exe"), // 语义占位（缓存目录无 QQ.exe）
        installDir: versionDir,
        version,
        wrapperPath: join(versionDir, "versions", version, "resources", "app", "wrapper.node"),
        source: "cached",
    };
}

/** 清理缓存版本目录（下载/解包失败残留，供调用方兜底）。 */
export async function clearCacheVersion(cacheRoot: string, version: string): Promise<void> {
    await rm(join(cacheRoot, version), { recursive: true, force: true });
}
