/**
 * 定位 QQ 原生文件（wrapper.node）来源：L0 显式文件根 → L1 本机安装 → L2 数据根缓存，全失败且 autoDownload 时进入下载。
 * 本文件只管多级来源选择与下载解包缓存管线（安装位置探测见 install-probe.ts，7z 见 seven-zip.ts）。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { resolveDataRoot } from "../shared/data-root.js";
import { downloadFile } from "./download.js";
import {
    clearCacheVersion,
    extractDebInstaller,
    extractInstaller,
    extractLinuxWrapperFiles,
    extractWrapperFiles,
} from "./extract.js";
import { resolveFromRoot, resolveQqInstall, tryResolveLinuxLocalQq } from "./install-probe.js";
import { releasePlatform } from "./manifests/releases.js";
import { latestRelease, loadQqReleases, resolveDownloadUrl } from "./releases.js";
import { resolveSevenZipPath } from "./seven-zip.js";
import type { QqInstallInfo, ResolveQqFilesOptions } from "./types.js";

export type { QqFileSource, QqInstallInfo, ResolveQqFilesOptions } from "./types.js";

/** 数据根下 QQ 文件缓存目录名（<数据根>/qq-files/<版本>/）。 */
export const QQ_FILES_DIR_NAME = "qq-files";

/**
 * 多级来源定位 QQ 原生文件：
 *   L0 → L1 → L2 依次尝试，全部失败且 autoDownload 时自动进入下载流程（ensureQqFiles）。
 * ⚠️ async：自动下载为异步流程；纯定位场景用 resolveQqInstall（同步）。
 */
export async function resolveQqFiles(options: ResolveQqFilesOptions = {}): Promise<QqInstallInfo> {
    // L0：显式文件根（参数 > 环境变量）
    const explicitDir = options.qqFilesDir ?? process.env["NAPUKETTO_QQ_FILES"];
    if (explicitDir !== undefined && explicitDir !== "") {
        return resolveFromRoot(resolve(explicitDir), "cached");
    }
    // L1：本机安装（参数 > 环境变量 > 注册表/常见路径）
    const qqPath = options.qqPath ?? process.env["NAPUKETTO_QQ_PATH"];
    if (qqPath !== undefined && qqPath !== "") {
        return resolveQqInstall(qqPath);
    }
    // L1b：Linux 本地 deb 安装（/opt/QQ 扁平布局；仅原生分支，避免白下 200MB deb）
    const linuxLocal = tryResolveLinuxLocalQq();
    if (linuxLocal !== null) {
        return linuxLocal;
    }
    try {
        return resolveQqInstall();
    } catch {
        // 本机未安装 → 落 L2
    }
    // L2：数据根缓存（下载解包产物；结构 <数据根>/qq-files/<版本>/）
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cached = tryResolveCached(dataRoot);
    if (cached !== null) {
        return cached;
    }
    // 全部缺失 → 自动下载
    if (options.autoDownload !== false) {
        const sevenZipPath =
            options.sevenZipPath !== undefined ? { sevenZipPath: options.sevenZipPath } : {};
        return ensureQqFiles({
            dataRoot,
            ...sevenZipPath,
            ...(options.onStage !== undefined ? { onStage: options.onStage } : {}),
        });
    }
    throw new Error(
        "未找到 QQ 原生文件（wrapper.node）：请安装 QQ、设置 NAPUKETTO_QQ_PATH/NAPUKETTO_QQ_FILES，" +
            "或使用下载流程（ensureQqFiles）自动获取",
    );
}

/** 扫描数据根缓存（L2）；命中返回，未命中返回 null。 */
function tryResolveCached(dataRoot: string): QqInstallInfo | null {
    const cacheRoot = join(dataRoot, QQ_FILES_DIR_NAME);
    if (!existsSync(cacheRoot)) {
        return null;
    }
    const versionDirs = readdirSync(cacheRoot)
        .filter((v) => statSync(join(cacheRoot, v)).isDirectory())
        .sort()
        .reverse();
    for (const versionDir of versionDirs) {
        try {
            return resolveFromRoot(join(cacheRoot, versionDir), "cached");
        } catch {
            // 该版本目录结构不完整（如下载中断残留），尝试下一个
        }
    }
    return null;
}

/**
 * 确保 QQ 原生文件就绪：幂等缓存检查 → 下载官方安装包 → sha256 校验
 * → 7z 解包 → 提取 wrapper.node/QQNT.dll → 缓存。返回缓存版本 QqInstallInfo。
 *
 * onStage：阶段回调（下载/解包等提示）——313MB 下载全程静默会让用户以为流程没生效，调用方接 logger.info。
 */
export async function ensureQqFiles(
    options: {
        /** 数据根（缓存 <数据根>/qq-files/）。 */
        dataRoot?: string;
        /** 7z 路径（缺省自动探测）。 */
        sevenZipPath?: string;
        /** 阶段回调（下载/校验/解包/提取，接 logger.info）。 */
        onStage?: (message: string) => void;
    } = {},
): Promise<QqInstallInfo> {
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cacheRoot = join(dataRoot, QQ_FILES_DIR_NAME);
    mkdirSync(cacheRoot, { recursive: true });

    // 幂等：缓存已有完整版本 → 直接返回
    const existing = tryResolveCached(dataRoot);
    if (existing !== null) {
        options.onStage?.(`QQ 原生文件缓存命中：版本 ${existing.version}`);
        return existing;
    }

    // 1. 版本清单 → 当前平台/架构最新可用版本（清单混装 Windows exe 与 Linux deb）
    const release = latestRelease(loadQqReleases(), {
        platform: process.platform,
        arch: process.arch,
    });
    const url = resolveDownloadUrl(release);
    const version = release.version;
    const isLinuxRelease = releasePlatform(release) === "linux";

    // 2. 下载 + sha256 校验（清单无参考值时下载器跳过校验，完整性由解包/加载兜底）
    const tmpDir = join(dataRoot, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    // ⚠️ tmp 文件名必须唯一化（多实例/重试并发）：固定名 qq-installer-<v>.exe 会互相覆盖，
    // 且一个实例 finally 清理会删掉另一个实例刚下载的文件——表现为「下载成功但 7z 解包报
    // No such file or directory」。加 pid + 时间戳后缀，实例间天然隔离。
    const installerPath = join(
        tmpDir,
        `qq-installer-${version}-${process.pid}-${Date.now().toString(36)}` +
            (isLinuxRelease ? ".deb" : ".exe"),
    );
    options.onStage?.(
        `下载 QQ 官方安装包 ${version}（首次使用需下载，约 ${isLinuxRelease ? "180" : "300"}MB）…`,
    );
    await downloadFile({ dest: installerPath, url, expectedSha256: release.sha256 });
    options.onStage?.(`QQ 安装包下载完成，sha256 校验通过（${release.sha256.slice(0, 12)}…）`);

    // 3. 解包 + 提取（失败清理缓存残留；临时文件无论如何清理）
    const extractedDir = join(tmpDir, `qq-extracted-${version}-${process.pid}`);
    try {
        const sevenZipPath = await resolveSevenZipPath(options.sevenZipPath, dataRoot);
        // 解包前再次确认安装包真实存在（downloadFile 已 stat 兜底；防御并发清理竞态）
        if (!existsSync(installerPath)) {
            throw new Error(
                `下载产物在解包前丢失: ${installerPath}（疑为并发实例清理 tmp，` +
                    "已用唯一文件名规避，请重试）",
            );
        }
        options.onStage?.(`7z 解包安装包（${version}，需数分钟）…`);
        if (isLinuxRelease) {
            await extractDebInstaller(installerPath, extractedDir, sevenZipPath);
            options.onStage?.("提取 wrapper.node / major.node 及 .so 依赖…");
            const info = await extractLinuxWrapperFiles(extractedDir, version, cacheRoot);
            options.onStage?.(`QQ 原生文件就绪：缓存版本 ${info.version}`);
            return info;
        }
        await extractInstaller(installerPath, extractedDir, sevenZipPath);
        options.onStage?.("提取 wrapper.node 及原生依赖 DLL…");
        const info = await extractWrapperFiles(extractedDir, version, cacheRoot);
        options.onStage?.(`QQ 原生文件就绪：缓存版本 ${info.version}`);
        return info;
    } catch (err) {
        await clearCacheVersion(cacheRoot, version);
        throw err;
    } finally {
        await rm(installerPath, { force: true });
        await rm(extractedDir, { recursive: true, force: true });
    }
}
