/**
 * 定位 QQ 原生文件（wrapper.node）来源（P0：多级来源纯定位，不下载）。
 *
 * 来源优先级（resolveQqFiles）：
 *   L0: NAPUKETTO_QQ_FILES / qqFilesDir —— 显式指定含 versions/ 结构的文件根（缓存/拷贝）
 *   L1: 本机 QQ 安装 —— NAPUKETTO_QQ_PATH / 注册表 / 常见路径（既有逻辑保留）
 *   L2: 数据根缓存 <数据根>/qq-files/<版本> —— 下载解包产物（P1 落地后才有）
 *
 * 2026-11-25 P1 拆分（行为零变更）：
 *  - 安装位置探测（注册表 / 常见路径 / WSL 映射 / Linux deb 布局）→ `install-probe.ts`
 *  - 7-Zip 定位 / 获取 / 执行 → `seven-zip.ts`
 *  - 本文件只留「多级来源选择 + 下载解包缓存管线」
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { resolveDataRoot } from "../internal/data-root.js";
import { resolveFromRoot, resolveQqInstall, tryResolveLinuxLocalQq } from "./install-probe.js";
import { downloadFile } from "./qq-download.js";
import {
    clearCacheVersion,
    extractDebInstaller,
    extractInstaller,
    extractLinuxWrapperFiles,
    extractWrapperFiles,
} from "./qq-extract.js";
import {
    latestRelease,
    loadQqReleases,
    releasePlatform,
    resolveDownloadUrl,
} from "./qq-releases.js";
import type { QqInstallInfo, ResolveQqFilesOptions } from "./qq-types.js";
import { resolveSevenZipPath } from "./seven-zip.js";

export type { QqFileSource, QqInstallInfo, ResolveQqFilesOptions } from "./qq-types.js";

/** 数据根下 QQ 文件缓存目录名（<数据根>/qq-files/<版本>/，P1 下载解包产物）。 */
export const QQ_FILES_DIR_NAME = "qq-files";

/**
 * 多级来源定位 QQ 原生文件：
 *   L0 → L1 → L2 依次尝试，全部失败且 autoDownload 时自动进入下载流程（ensureQqFiles）。
 * ⚠️ async：自动下载为异步流程（P1 起）；纯定位场景用 resolveQqInstall（同步）。
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
    // L2：数据根缓存（P1 下载解包产物；结构 <数据根>/qq-files/<版本>/）
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cached = tryResolveCached(dataRoot);
    if (cached !== null) {
        return cached;
    }
    // 全部缺失 → 自动下载（P1）
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
 * 确保 QQ 原生文件就绪（P1）：幂等缓存检查 → 下载官方安装包 → sha256 校验
 * → 7z 解包 → 提取 wrapper.node/QQNT.dll → 缓存。返回缓存版本 QqInstallInfo。
 *
 * onStage：阶段回调（下载/解包等提示，2026-08-23 起——下载 313MB 全程静默
 * 的坑）。调用方接 logger.info。
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
    // ⚠️ tmp 文件名唯一化（2026-08-23 WSL 事故）：固定名 qq-installer-<v>.exe 在
    // 多实例/重试并发时互相覆盖，且一个实例 finally 清理会删掉另一个实例刚下载
    // 的文件——表现就是「下载成功但 7z 解包报 No such file or directory」。
    // 加 pid + 时间戳后缀，实例间天然隔离。
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
