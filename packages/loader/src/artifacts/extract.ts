/**
 * extract.ts：QQ 官方安装包解包与提取——NSIS 自解压格式，7za standalone 不支持 NSIS，必须完整版 7z（7z.exe + 7z.dll）。
 * NSIS 产物在 <extracted>/Files/，只取 resources/app 顶层 *.node + *.dll；214MB 真实 QQNT.dll 由 stub 替代，不需要。
 * 顶层全取可覆盖 wrapper.node 的直接/传递/delay-load 依赖，与 QQ 版本无关；wmpfsdk/avsdk 等大子目录跳过。
 */
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { findSevenZip, runSevenZip } from "./seven-zip.js";
import type { QqInstallInfo } from "./types.js";

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
