/**
 * 定位 QQ 原生文件（wrapper.node）来源（P0：多级来源纯定位，不下载）。
 *
 * 来源优先级（resolveQqFiles）：
 *   L0: NAPUTO_QQ_FILES / qqFilesDir —— 显式指定含 versions/ 结构的文件根（缓存/拷贝）
 *   L1: 本机 QQ 安装 —— NAPUTO_QQ_PATH / 注册表 / 常见路径（既有逻辑保留）
 *   L2: 数据根缓存 <数据根>/qq-files/<版本> —— 下载解包产物（P1 落地后才有）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "./data-root.js";
import { downloadFile } from "./qq-download.js";
import { clearCacheVersion, extractInstaller, extractWrapperFiles } from "./qq-extract.js";
import { latestRelease, loadQqReleases, resolveDownloadUrl } from "./qq-releases.js";

/** 数据根下 QQ 文件缓存目录名（<数据根>/qq-files/<版本>/，P1 下载解包产物）。 */
export const QQ_FILES_DIR_NAME = "qq-files";

/**
 * 7-Zip 官方 Linux 版版本号（tar.xz 文件名组成部分；兜底下载用，内置资产优先）。
 * ⚠️ 此值为最后兜底下载用，7-Zip 官网只留最新版，旧版号会 404；内置资产失败才触发。
 */
const SEVEN_ZIP_LINUX_VERSION = "2501";

/** 注册表 UninstallString 查询（QQ 官方安装路径）。 */
const REG_QUERY_RE = /"([^"]+)"/;

/** Windows 盘符路径正则（`C:/...` / `C:\...`，wslMappedPath 映射用，模块级常量）。 */
const DRIVE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

/** 注册表 UninstallString 查询（QQ 官方安装路径）。 */
function findQqViaRegistry(): string | null {
    try {
        const out = execFileSync("reg", [
            "query",
            "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ",
            "/v",
            "UninstallString",
        ]).toString();
        const m = out.match(REG_QUERY_RE);
        const exe = m?.[1];
        if (exe !== undefined) {
            // UninstallString 形如 "C:\...\uninst.exe" 或带参数
            const dir = exe.replaceAll('"', "").slice(0, exe.lastIndexOf("\\"));
            const qq = join(dir, "QQ.exe");
            if (existsSync(qq)) {
                return qq;
            }
        }
    } catch {
        // 注册表查询失败，走常见路径
    }
    return null;
}

/** 常见安装路径探测。 */
function findQqViaCommonPaths(): string | null {
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    const candidates = [
        "C:/Program Files/Tencent/QQNT/QQ.exe",
        "C:/Program Files (x86)/Tencent/QQNT/QQ.exe",
        join(localAppData, "Programs", "Tencent", "QQNT", "QQ.exe"),
    ];
    for (const p of candidates) {
        // WSL 场景：Windows 盘挂载在 /mnt/<盘符>/（如 C:\ → /mnt/c/），
        // 同一候选同时探测 Linux 侧映射路径（2026-08-13 koishi-app 实测报「未找到 QQ.exe」）。
        const wsl = wslMappedPath(p);
        if (existsSync(wsl)) {
            return wsl;
        }
        if (existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Windows 路径 → WSL 挂载路径（`C:/...` → `/mnt/c/...`；非 Linux 或非盘符路径原样）。
 * WSL 默认把 Windows 盘符挂载到 `/mnt/<小写盘符>/`，Linux 侧 `existsSync` 必须用映射路径。
 * platform 参数可注入（测试用；缺省 process.platform）。
 * 导出便于单测（locate-qq.test.ts）。
 * ⚠️ 不用 join 拼 `/mnt/...`：测试在 Windows 跑，win32 join 会产生反斜杠；目标路径
 * 是 Linux 侧路径（WSL 挂载点），必须恒正斜杠。
 */
export function wslMappedPath(
    winPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform !== "linux") {
        return winPath;
    }
    const [, drive, rest] = DRIVE_PATH_RE.exec(winPath) ?? [];
    if (drive === undefined || rest === undefined) {
        return winPath;
    }
    return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

/** QQ 文件来源。 */
export type QqFileSource = "local" | "cached";

/** QQ 安装目录探测结果。 */
export interface QqInstallInfo {
    /** QQ.exe 绝对路径（cached 来源为语义占位——缓存目录无 QQ.exe，当前无消费方）。 */
    qqPath: string;
    /** 安装根目录 / 文件根目录。 */
    installDir: string;
    /** 当前版本目录名（如 9.9.31-49919）。 */
    version: string;
    /** wrapper.node 绝对路径。 */
    wrapperPath: string;
    /** 来源：local = 本机安装；cached = NAPUTO_QQ_FILES / 数据根缓存。 */
    source: QqFileSource;
}

/** resolveQqFiles 选项。 */
export interface ResolveQqFilesOptions {
    /** 显式文件根（L0；缺省读 NAPUTO_QQ_FILES）。 */
    qqFilesDir?: string;
    /** 显式 QQ.exe 路径（L1；缺省读 NAPUTO_QQ_PATH）。 */
    qqPath?: string;
    /** 数据根（L2 缓存扫描；缺省轻量解析 NAPKETTO_DATA ?? 项目根/.napuketto）。 */
    dataRoot?: string;
    /** L0/L1/L2 全部失败时自动进入下载流程（P1；默认 true，测试可关）。 */
    autoDownload?: boolean;
    /** 7z 可执行文件路径（解包用；缺省自动探测）。 */
    sevenZipPath?: string;
    /**
     * 阶段回调（下载/校验/解包/提取各阶段提示，2026-08-23 WSL 事故后加：
     * 下载 313MB 全程静默，用户以为流程没生效）。调用方接 logger.info。
     */
    onStage?: (message: string) => void;
}

/** 找 QQ.exe 路径。 */
export function locateQqPath(): string {
    const viaReg = findQqViaRegistry();
    if (viaReg) {
        return viaReg;
    }
    const viaCommon = findQqViaCommonPaths();
    if (viaCommon) {
        return viaCommon;
    }
    throw new Error("未找到 QQ.exe（请先安装 QQ，或通过 NAPUTO_QQ_PATH 指定）");
}

/** 从文件根定位最新版本 wrapper.node（local/cached 共用）。 */
function resolveFromRoot(rootDir: string, source: QqFileSource): QqInstallInfo {
    const versionsDir = join(rootDir, "versions");
    if (!existsSync(versionsDir)) {
        throw new Error(`QQ 版本目录不存在: ${versionsDir}`);
    }
    const versions = readdirSync(versionsDir)
        .filter((v) => statSync(join(versionsDir, v)).isDirectory())
        .sort()
        .reverse();
    const [first] = versions;
    if (first === undefined) {
        throw new Error(`QQ 版本目录为空: ${versionsDir}`);
    }
    const wrapperPath = join(versionsDir, first, "resources", "app", "wrapper.node");
    if (!existsSync(wrapperPath)) {
        throw new Error(`未找到 wrapper.node: ${wrapperPath}`);
    }
    return {
        qqPath: join(rootDir, "QQ.exe"),
        installDir: rootDir,
        version: first,
        wrapperPath,
        source,
    };
}

/** 从 QQ.exe 路径推导安装目录，并探测当前版本（L1：本机安装）。 */
export function resolveQqInstall(qqPath?: string): QqInstallInfo {
    const qq = qqPath ?? process.env["NAPUTO_QQ_PATH"] ?? locateQqPath();
    // Windows 安装结构：<installDir>/versions/<版本>/resources/app/wrapper.node
    // ⚠️ dirname 跨平台：Linux/WSL 路径用正斜杠（lastIndexOf("\\") 会切错，2026-08-13 实测）；
    // 反斜杠 Windows 路径在 posix dirname 下不切分（切错目录），非 win32 先归一化——
    // win32 不动原串，保持返回值分隔符与调用方输入一致（精确比对场景）
    const installDir = dirname(process.platform === "win32" ? qq : qq.replaceAll("\\", "/"));
    return resolveFromRoot(installDir, "local");
}

/**
 * 多级来源定位 QQ 原生文件：
 *   L0 → L1 → L2 依次尝试，全部失败且 autoDownload 时自动进入下载流程（ensureQqFiles）。
 * ⚠️ async：自动下载为异步流程（P1 起）；纯定位场景用 resolveQqInstall（同步）。
 */
export async function resolveQqFiles(options: ResolveQqFilesOptions = {}): Promise<QqInstallInfo> {
    // L0：显式文件根（参数 > 环境变量）
    const explicitDir = options.qqFilesDir ?? process.env["NAPUTO_QQ_FILES"];
    if (explicitDir !== undefined && explicitDir !== "") {
        return resolveFromRoot(resolve(explicitDir), "cached");
    }
    // L1：本机安装（参数 > 环境变量 > 注册表/常见路径）
    const qqPath = options.qqPath ?? process.env["NAPUTO_QQ_PATH"];
    if (qqPath !== undefined && qqPath !== "") {
        return resolveQqInstall(qqPath);
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
        "未找到 QQ 原生文件（wrapper.node）：请安装 QQ、设置 NAPUTO_QQ_PATH/NAPUTO_QQ_FILES，" +
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
 * 7-Zip 官方 Linux 版下载地址（纯函数，可单测）。
 * 环境变量 NAPUTO_7Z_URL 可覆盖（同 QQ 下载 NAPUTO_QQ_URL 模式）。
 */
export function linuxSevenZipUrl(): string {
    return (
        process.env["NAPUTO_7Z_URL"] ??
        `https://www.7-zip.org/a/7z${SEVEN_ZIP_LINUX_VERSION}-linux-x64.tar.xz`
    );
}

/**
 * 确保 Linux 7zz 就绪（治本：内置资产优先，下载兜底）。
 *
 * 优先级：内置资产 assets/7zip/7zz（2026-08-14 治本——与 Windows 7z.exe 同模式，
 * 7zz 静态二进制已打进发布包，LGPL 合规可分发，零运行时下载）> 数据根缓存
 * runtime/7zip/7zz（历史下载产物复用）> 官网下载（兜底，NAPUTO_7Z_URL 可覆盖）。
 *
 * 背景：7-Zip 官网只保留最新版 tar.xz，硬编码旧版本号（如 2409）会被删档 404，
 * 运行时下载既脆弱又依赖外网。内置资产彻底消灭该依赖。
 */
export async function ensureLinuxSevenZip(
    options: { dataRoot?: string } = {},
): Promise<{ exe: string; source: string }> {
    // 1. 内置资产（治本）：dist 与 assets 同层（tsdown 构建后 dist/，资产在包根 assets/）
    const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "7zip", "7zz");
    if (existsSync(bundled)) {
        // npm 安装可能丢失执行位，保险设置（失败不阻塞：execFile 报 EACCES 时由调用方提示）
        await chmod(bundled, 0o755).catch(() => {
            // 忽略：无执行位场景后续解包会明确报错，此处不静默吞掉主流程
        });
        return { exe: bundled, source: "内置资产 assets/7zip" };
    }

    // 2. 数据根缓存（历史下载产物复用）
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cacheDir = join(dataRoot, "runtime", "7zip");
    const exe = join(cacheDir, "7zz");
    if (existsSync(exe)) {
        return { exe, source: "数据根缓存 runtime/7zip" };
    }

    // 3. 官网下载兜底（NAPUTO_7Z_URL 覆盖；仅当发布包缺失旧形态时触发）
    const archive = join(cacheDir, `7z${SEVEN_ZIP_LINUX_VERSION}-linux-x64.tar.xz`);
    mkdirSync(cacheDir, { recursive: true });
    await downloadFile({ dest: archive, url: linuxSevenZipUrl() });
    try {
        // tar -xJf 解压（Linux 自带 tar；7-Zip 官方 tar.xz 根目录含 7zz）
        try {
            execFileSync("tar", ["-xJf", archive, "-C", cacheDir], { stdio: "pipe" });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `7z linux 解压失败: ${message}（需 tar + xz-utils；或设 NAPUTO_7Z_PATH 指定系统 7z）`,
            );
        }
    } finally {
        await rm(archive, { force: true });
    }
    if (!existsSync(exe)) {
        throw new Error(`7z linux 解压后未找到 7zz: ${exe}`);
    }
    await chmod(exe, 0o755); // 官方 tar.xz 内已有执行位，保险设置
    return { exe, source: "自动下载（7-Zip 官方 linux 版）" };
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

    // 1. 版本清单 → 最新可用版本
    const releases = loadQqReleases();
    const release = latestRelease(releases);
    const url = resolveDownloadUrl(release);
    const version = release.version;

    // 2. 下载 + sha256 校验（清单无参考值时下载器跳过校验，完整性由解包/加载兜底）
    const tmpDir = join(dataRoot, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    // ⚠️ tmp 文件名唯一化（2026-08-23 WSL 事故）：固定名 qq-installer-<v>.exe 在
    // 多实例/重试并发时互相覆盖，且一个实例 finally 清理会删掉另一个实例刚下载
    // 的文件——表现就是「下载成功但 7z 解包报 No such file or directory」。
    // 加 pid + 时间戳后缀，实例间天然隔离。
    const installerPath = join(
        tmpDir,
        `qq-installer-${version}-${process.pid}-${Date.now().toString(36)}.exe`,
    );
    options.onStage?.(`下载 QQ 官方安装包 ${version}（首次使用需下载，约 300MB）…`);
    await downloadFile({ dest: installerPath, url, expectedSha256: release.sha256 });
    options.onStage?.(`QQ 安装包下载完成，sha256 校验通过（${release.sha256.slice(0, 12)}…）`);

    // 3. 解包 + 提取（失败清理缓存残留；临时文件无论如何清理）
    //    Linux 分支：确保 7zz（自动下载 7-Zip 官方 linux 版，2026-08-14 生产修复——
    //    此前依赖系统 p7zip-full，未安装则 7z 解包失败、QQ 文件无法就绪）
    let sevenZipPath = options.sevenZipPath;
    if (sevenZipPath === undefined && process.platform === "linux") {
        sevenZipPath = (await ensureLinuxSevenZip({ dataRoot })).exe;
    }
    const extractedDir = join(tmpDir, `qq-extracted-${version}-${process.pid}`);
    try {
        // 解包前再次确认安装包真实存在（downloadFile 已 stat 兜底；防御并发清理竞态）
        if (!existsSync(installerPath)) {
            throw new Error(
                `下载产物在解包前丢失: ${installerPath}（疑为并发实例清理 tmp，` +
                    "已用唯一文件名规避，请重试）",
            );
        }
        options.onStage?.(`7z 解包安装包（${version}，需数分钟）…`);
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
