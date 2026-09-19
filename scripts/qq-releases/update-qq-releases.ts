#!/usr/bin/env node
/**
 * update-qq-releases.ts：qq-releases.json 自动维护脚本（CI 定时/手动与本地共用，纯 Node 零第三方依赖）。
 *
 * 用法（从项目根）：
 *   node scripts/qq-releases/update-qq-releases.ts            # 抓最新版 → 下载 → sha256 → 更新清单
 *   node scripts/qq-releases/update-qq-releases.ts --dry-run  # 只打印计划，不下载、不写清单
 *
 * 数据源（2026-08-13 实测修正）：im.qq.com 新版为 Vite SPA——HTML 壳仅 ~7KB，
 * 下载链接由前端运行时抓取 rainbow 配置 JSON（下载页同源数据）。设计文档 §2.2 旧
 * 「纯 HTML 可正则」结论已随网站改版失效，本脚本改为直接读 rainbow JSON：
 *   - 主：https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json
 *   - 备：https://pre.cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/pcConfig.json（可能滞后，带降级保护）
 *
 * 版本号格式（与安装目录/运行时约定一致）：<营销版本>-<构建号>（如 9.9.33-52230）。
 * rainbow 只给营销版本 + updateDate + 下载 URL；构建号藏在安装包内部 versions/<版本>
 * 目录名里——优先用仓库内置 7-Zip 列归档（7z l）解析目录名，7z 不可用时回退字节扫描
 * （实测安装包尾部有 UTF-16LE `9.9.33.52230-aff854e`）。清单 version 必须与安装包内部
 * 目录名一致（运行时 extractWrapperFiles 按版本目录名定位 wrapper.node）。
 *
 * 容错：下载瞬态失败按 5s/15s 重试共 3 次；最终失败非零退出且不写清单（绝不写坏）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { QqReleaseEntry, QqReleasesFile } from "../../packages/loader/src/qq-releases.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "packages", "loader", "qq-releases.json");
const SEVEN_ZIP_DIR = join(REPO_ROOT, "packages", "loader", "assets", "7zip");

const USER_AGENT = "napuketto-qq-releases/1.0";

/** 官方下载配置源（主生产 + 备 CDN，后者可能滞后）。 */
const PC_CONFIG_URLS = [
    "https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json",
    "https://pre.cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/pcConfig.json",
];

/** 营销版本（三段数字）。 */
const MARKETING_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 7z 归档列表里的版本目录名（如 Files\versions\9.9.33-51802\...）。 */
const VERSION_DIR_RE = /versions[\\/]([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)[\\/]/g;

/** 官方下载配置解析出的 Windows 最新版本。 */
interface WindowsRelease {
    /** 营销版本（9.9.33）。 */
    marketingVersion: string;
    /** 构建日期（2026-08-13）。 */
    updateDate: string;
    /** x64 安装包下载 URL。 */
    x64Url: string;
}

/** 打印信息（noConsole 只放行 console.log）。 */
function info(message: string): void {
    console.log(`[update-qq-releases] ${message}`);
}

/** 打印错误到 stderr。 */
function warn(message: string): void {
    process.stderr.write(`[update-qq-releases] ⚠ ${message}\n`);
}

/** 解析命令行参数。 */
function parseArgs(argv: readonly string[]): { dryRun: boolean } {
    let dryRun = false;
    for (const arg of argv) {
        if (arg === "--dry-run") {
            dryRun = true;
        }
    }
    return { dryRun };
}

/** GET 拉取文本（跟随重定向，超时 20s）。 */
async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.text();
}

/** 从 rainbow 配置解析 Windows 最新版本（结构不符返回 null，不抛错）。 */
function parseWindowsRelease(config: unknown): WindowsRelease | null {
    if (typeof config !== "object" || config === null) {
        return null;
    }
    const win = (config as Record<string, unknown>)["Windows"];
    if (typeof win !== "object" || win === null) {
        return null;
    }
    const w = win as Record<string, unknown>;
    const version = w["version"];
    const updateDate = w["updateDate"];
    const x64Url = w["ntDownloadX64Url"];
    if (
        typeof version !== "string" ||
        typeof updateDate !== "string" ||
        typeof x64Url !== "string"
    ) {
        return null;
    }
    if (!MARKETING_VERSION_RE.test(version)) {
        return null;
    }
    return { marketingVersion: version, updateDate, x64Url };
}

/** 依次尝试配置源，解析出 Windows 最新版本（全部失败返回 null）。 */
async function fetchLatestRelease(): Promise<WindowsRelease | null> {
    for (const url of PC_CONFIG_URLS) {
        try {
            const text = await fetchText(url);
            const release = parseWindowsRelease(JSON.parse(text) as unknown);
            if (release !== null) {
                return release;
            }
            warn(`配置结构解析失败: ${url}`);
        } catch (err) {
            warn(`配置抓取失败: ${url}（${err instanceof Error ? err.message : String(err)}）`);
        }
    }
    return null;
}

/** 发起 https GET 跟随重定向（最多 5 跳），返回响应流。 */
function httpsGet(url: string, timeoutMs: number): Promise<IncomingMessage> {
    return new Promise((resolvePromise, reject) => {
        const request = (current: string, redirects: number): void => {
            const req = get(current, { headers: { "user-agent": USER_AGENT } }, (res) => {
                const status = res.statusCode ?? 0;
                const location = res.headers["location"];
                if (status >= 300 && status < 400 && location !== undefined) {
                    res.resume();
                    if (redirects >= 5) {
                        reject(new Error(`重定向次数过多: ${current}`));
                        return;
                    }
                    request(new URL(location, current).toString(), redirects + 1);
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${status}: ${current}`));
                    return;
                }
                resolvePromise(res);
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`下载超时(${timeoutMs}ms): ${current}`));
            });
            req.on("error", (err) => {
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        };
        request(url, 0);
    });
}

/** 下载文件并流式计算 sha256（失败清理半成品），返回十六进制小写 sha256。 */
async function downloadFile(url: string, dest: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createWriteStream(dest);
    try {
        const res = await httpsGet(url, 120_000);
        await new Promise<void>((resolvePromise, reject) => {
            res.on("data", (chunk: Buffer) => {
                hash.update(chunk);
            });
            res.on("error", reject);
            stream.on("error", reject);
            stream.on("finish", resolvePromise);
            res.pipe(stream);
        });
    } catch (err) {
        stream.destroy();
        await rm(dest, { force: true });
        throw err instanceof Error ? err : new Error(String(err));
    }
    return hash.digest("hex");
}

/** 定位 7-Zip 可执行文件（环境变量 > 内置资产 > 系统 PATH）。 */
function findSevenZip(): string {
    const envPath = process.env["NAPUTO_7Z_PATH"];
    if (envPath !== undefined && envPath !== "" && existsSync(envPath)) {
        return envPath;
    }
    const exeName = process.platform === "win32" ? "7z.exe" : "7zz";
    const bundled = join(SEVEN_ZIP_DIR, exeName);
    if (existsSync(bundled)) {
        return bundled;
    }
    return "7z";
}

/** 用 7z 列出安装包归档内容，返回 stdout（失败抛错）。 */
async function listArchive(sevenZip: string, installerPath: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        execFile(
            sevenZip,
            ["l", installerPath],
            { maxBuffer: 64 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err !== null) {
                    const code = (err as NodeJS.ErrnoException).code;
                    const hint =
                        code === "ENOENT"
                            ? `未找到 7-Zip: ${sevenZip}`
                            : `7z 列出归档失败: ${stderr.trim()}`;
                    reject(new Error(hint));
                    return;
                }
                resolvePromise(stdout);
            },
        );
    });
}

/** 从 7z 归档列表解析安装包内部版本目录名（9.9.33-51802）；找不到返回 null。 */
function resolveVersionDir(listing: string, marketingVersion: string): string | null {
    const prefix = `${marketingVersion}-`;
    for (const match of listing.matchAll(VERSION_DIR_RE)) {
        const name = match[1];
        if (name?.startsWith(prefix)) {
            return name;
        }
    }
    return null;
}

/** 提取营销版本（9.9.33-51802 → 9.9.33）。 */
function marketingOf(version: string): string {
    const [marketing] = version.split("-");
    return marketing ?? version;
}

/** 解析版本字符串为可比较结构（9.9.33-51802 → parts [9,9,33] + build 51802）。 */
function splitVersion(version: string): { parts: number[]; build: number } {
    const [marketing = "", buildStr = "0"] = version.split("-");
    const parts = marketing.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const build = Number.parseInt(buildStr, 10) || 0;
    return { parts, build };
}

/** 版本数值比较（营销三段逐位 + 构建号；用于排序与降级判定）。 */
function compareVersions(a: string, b: string): number {
    const pa = splitVersion(a);
    const pb = splitVersion(b);
    const len = Math.max(pa.parts.length, pb.parts.length);
    for (let i = 0; i < len; i += 1) {
        const da = pa.parts[i] ?? 0;
        const db = pb.parts[i] ?? 0;
        if (da !== db) {
            return da - db;
        }
    }
    return pa.build - pb.build;
}

/** 按 version 字段递增排序清单条目（返回新数组）。 */
function sortEntries(entries: QqReleaseEntry[]): QqReleaseEntry[] {
    return [...entries].sort((a, b) => compareVersions(a.version, b.version));
}

/** 合并新条目：同版本替换（保留已有非零 appid），否则追加；按版本递增排序。 */
function mergeEntry(known: QqReleaseEntry[], entry: QqReleaseEntry): QqReleaseEntry[] {
    const existing = known.find((item) => item.version === entry.version);
    const appid = existing !== undefined && existing.appid > 0 ? existing.appid : entry.appid;
    return sortEntries([
        ...known.filter((item) => item.version !== entry.version),
        { ...entry, appid },
    ]);
}

/** 解析安装包内部版本目录名：7z 列归档优先，失败/不可用回退字节扫描。 */
async function resolveVersion(
    installerPath: string,
    marketingVersion: string,
): Promise<string | null> {
    const sevenZip = findSevenZip();
    try {
        const listing = await listArchive(sevenZip, installerPath);
        const version = resolveVersionDir(listing, marketingVersion);
        if (version !== null) {
            return version;
        }
        warn("7z 归档列表未含版本目录，回退字节扫描");
    } catch (err) {
        warn(`7z 不可用（${err instanceof Error ? err.message : String(err)}），回退字节扫描`);
    }
    return scanVersionInFile(installerPath, marketingVersion);
}

/** 从安装包字节扫描版本串（ASCII/UTF-16LE × 点/横杠分隔），返回 <营销>-<构建号> 或 null。 */
function scanVersionInFile(installerPath: string, marketingVersion: string): string | null {
    const buf = readFileSync(installerPath);
    const candidates: readonly { encoding: "ascii" | "utf16le"; separator: "." | "-" }[] = [
        { encoding: "utf16le", separator: "." },
        { encoding: "utf16le", separator: "-" },
        { encoding: "ascii", separator: "." },
        { encoding: "ascii", separator: "-" },
    ];
    for (const { encoding, separator } of candidates) {
        const version = scanEncoding(buf, marketingVersion, encoding, separator);
        if (version !== null) {
            return version;
        }
    }
    return null;
}

/** 按编码 + 分隔符找 `<营销版本><分隔符><数字>`，返回 `<营销版本>-<数字>`（无数字返回 null）。 */
function scanEncoding(
    buf: Buffer,
    marketingVersion: string,
    encoding: "ascii" | "utf16le",
    separator: "." | "-",
): string | null {
    const needle = Buffer.from(`${marketingVersion}${separator}`, encoding);
    const idx = buf.indexOf(needle);
    if (idx < 0) {
        return null;
    }
    const step = encoding === "utf16le" ? 2 : 1;
    let end = idx + needle.length;
    let build = "";
    while (end + step <= buf.length) {
        const code = encoding === "utf16le" ? buf.readUInt16LE(end) : (buf[end] ?? 0);
        if (code >= 0x30 && code <= 0x39) {
            build += String.fromCharCode(code);
            end += step;
        } else {
            break;
        }
    }
    return build === "" ? null : `${marketingVersion}-${build}`;
}

/** 读清单（结构校验，失败抛错）。 */
function loadManifest(): QqReleasesFile {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<QqReleasesFile>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.known) || parsed.known.length === 0) {
        throw new Error("qq-releases.json 结构不合法（需 schema=1 且 known 非空数组）");
    }
    return parsed as QqReleasesFile;
}

/** 写清单（4 空格缩进 + 换行，与仓库格式一致）。 */
function saveManifest(manifest: QqReleasesFile): void {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
}

/** 主流程（可被 CLI 直接调用；返回退出码）。 */
async function main(argv: readonly string[]): Promise<number> {
    const { dryRun } = parseArgs(argv);
    const manifest = loadManifest();

    // 1. 抓官方下载配置，解析最新 Windows 版本 + 下载 URL
    const release = await fetchLatestRelease();
    if (release === null) {
        throw new Error("官方下载配置解析失败（页面结构可能已变），未更新清单");
    }
    info(`官方最新: 版本=${release.marketingVersion} 日期=${release.updateDate}`);
    info(`下载 URL: ${release.x64Url}`);

    // 2. 与清单比对：URL 未变 → no-op；营销版本回退 → 跳过（防降级，可能是备用源滞后）
    const sorted = sortEntries(manifest.known);
    const latest = sorted[sorted.length - 1];
    if (latest !== undefined && latest.url === release.x64Url) {
        info(`清单已是最新（${latest.version}），URL 未变，无需更新`);
        return 0;
    }
    if (
        latest !== undefined &&
        compareVersions(`${release.marketingVersion}-0`, `${marketingOf(latest.version)}-0`) < 0
    ) {
        info(
            `官方返回营销版本 ${release.marketingVersion} 低于清单 ${latest.version}，跳过（防降级）`,
        );
        return 0;
    }

    if (dryRun) {
        info(
            `[dry-run] 将新增/更新条目: ${release.marketingVersion}-<构建号>（URL=${release.x64Url}）`,
        );
        info("[dry-run] 未下载、未写清单（--dry-run）");
        return 0;
    }

    // 3. 下载安装包 + 流式 sha256
    const tmp = mkdtempSync(join(tmpdir(), "napuketto-qq-"));
    try {
        const installerPath = join(tmp, "installer.exe");
        info("下载安装包并计算 sha256…");
        const sha256 = await downloadFileWithRetry(release.x64Url, installerPath);
        info(`sha256: ${sha256}`);

        // 4. 解析安装包内部版本目录名（含构建号）：7z 列归档优先，失败回退字节扫描
        const version = await resolveVersion(installerPath, release.marketingVersion);
        if (version === null) {
            throw new Error(
                `无法从安装包解析版本目录名（营销版本=${release.marketingVersion}），未更新清单`,
            );
        }
        info(`解析版本目录: ${version}`);

        // 5. 合并条目（同版本替换并保留已知 appid、否则追加）并按版本递增排序后落盘
        const merged = mergeEntry(manifest.known, {
            version,
            url: release.x64Url,
            sha256,
            appid: 0, // 新构建号 appid 未知（运行时从 major.node 重解析）；同版本替换时保留原值
            source: "official",
            buildDate: release.updateDate,
        });
        saveManifest({ schema: manifest.schema, known: merged });
        info(`✅ 已更新清单: ${version}（共 ${merged.length} 条，按版本递增）`);
    } finally {
        await rm(tmp, { recursive: true, force: true });
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
            process.stderr.write(`[update-qq-releases] ❌ ${message}\n`);
            process.exitCode = 1;
        });
}

// —— 下载重试（置于 CLI 收尾之后：保持存量行号不变，fallow 增量基线锚点不受
// 行号位移影响；引用处经函数声明提升，TDZ 安全——main 首个 await 后才会调用）——

/** 下载重试间隔（5s/15s，尾部 -1 为终止哨兵）：腾讯 CDN 偶发 403/5xx，重试吸收瞬态失败。 */
const DOWNLOAD_RETRY_DELAYS_MS = [5_000, 15_000, -1] as const;

/** 归一化错误消息（Error 优先取 message）。 */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** 带重试的下载：共 3 次尝试，失败按 5s/15s 退避后再试，仍失败抛最后一个错误。 */
function downloadFileWithRetry(url: string, dest: string): Promise<string> {
    return retryDownload(url, dest, [...DOWNLOAD_RETRY_DELAYS_MS]);
}

/** 递归重试体（线性展开避免循环嵌套，控制 fallow 复杂度门禁口径）。 */
async function retryDownload(url: string, dest: string, delays: number[]): Promise<string> {
    try {
        return await downloadFile(url, dest);
    } catch (err) {
        const [delayMs = -1] = delays;
        if (delayMs < 0) {
            throw new Error(`下载失败（重试 2 次后仍放弃）: ${errorMessage(err)}`);
        }
        warn(`下载失败，${Math.round(delayMs / 1000)}s 后重试: ${errorMessage(err)}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
        return retryDownload(url, dest, delays.slice(1));
    }
}
