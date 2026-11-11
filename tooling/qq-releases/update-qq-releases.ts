#!/usr/bin/env node
/**
 * update-qq-releases.ts：qq-releases.json 自动维护脚本（CI 定时/手动与本地共用，纯 Node 零第三方依赖）。
 *
 * 用法（从项目根）：
 *   node tooling/qq-releases/update-qq-releases.ts            # 抓最新版 → 下载 → sha256 → 更新清单
 *   node tooling/qq-releases/update-qq-releases.ts --dry-run  # 只打印计划，不下载、不写清单
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
 *
 * Linux（2026-11-10 起）：额外抓官方 `linuxConfig.js`（`.../rainbow/linuxConfig.js`），
 * 按 x64 / arm64 各自的 deb URL 维护 `platform: "linux"` + `arch` + `coreVersion` 条目。
 * Linux 的客户端版本（`3.2.35-54395`）与该架构 appid 只能从 deb 内部取——这里只解出
 * `resources/app/package.json`（KB 级），appid 沿用清单里同架构已有值（跨版本基本不变，
 * 未知则记 0，运行时从 `major.node` 重解析）。Linux 侧失败只 warn 不抛：Windows 更新
 * 成功仍要落盘（反之亦然），两侧互不拖累。
 *
 * Linux 防降级与失败隔离（2026-11-11，issue #100 事故）：CDN 边缘把 linuxConfig.js 缓存
 * 在旧版（3.2.33，源站已是 3.2.35）时，旧 deb 早已下架 → 下载 404 → 异常冒到 main，
 * 把整次运行判失败并开追踪 issue（Windows 侧其实无事可做）。现在：
 *   · 官方营销版本低于清单最新 → info 跳过（防降级，与 Windows 同口径）；
 *   · 单架构下载 / 临时目录 / 解包抛错 → warn 跳过该架构；main 再兜最后一层，
 *     Windows 侧已算好的更新照常落盘。
 *
 * ⚠️ 执行方式约束：本文件在 CI 与本地都由 `node` 直接跑（类型剥离，无构建、无 tsconfig），
 * 所以它只能依赖 `packages/loader/src/qq/qq-release-manifest.ts` 这类**零相对 import** 的
 * 模块——Node 不会把 `./x.js` 说明符改写成 `./x.ts`。守卫：同目录
 * update-qq-releases.import.test.ts。
 *
 * ⚠️ 下载 URL 归一化（2026-10-07，issue #6 根因）：官方 rainbow 给出的
 * `ntDownloadX64Url` 形如 `.../qqfile/QQNTV2/...`，腾讯 CDN 边缘 WAF 对字面量
 * `/QQNTV2/` 路径段 **区分大小写** 地拦截（403 + Content-Length: 0 + Return
 * Directly，不回源），直连必失败；源站对大小写不敏感，改小写 `/qqntv2/` 即正常。
 * 因此请求前统一走 normalizeDownloadUrl（清单里仍写官方原样 URL）。
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
import type {
    QqReleaseArch,
    QqReleaseEntry,
    QqReleasesFile,
} from "../../packages/loader/src/qq/qq-release-manifest.ts";
import {
    normalizeDownloadUrl,
    releasePlatform,
} from "../../packages/loader/src/qq/qq-release-manifest.ts";

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

/** Linux 官方下载配置（与 Windows 的 rainbow pcConfig 不同源）。 */
const LINUX_CONFIG_URL = "https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js";

/** linuxConfig.js 里的 `var params = {...};` 载荷。 */
const LINUX_CONFIG_PARAMS_RE = /var\s+params\s*=\s*(\{[\s\S]*?\})\s*;/;

/** deb URL 里的 QQNT 核心版本段（…/QQNTV2/9.9.37/release/…）。 */
const CORE_VERSION_RE = /\/(\d+\.\d+\.\d+)\/release\//;

/**
 * deb 内客户端版本文件（解包后取它读 `version`）。
 * ⚠️ 前缀 `./` 必须带：deb 的 `data.tar` 里路径是 `./opt/QQ/...`，不带前缀的过滤器
 * 一条也匹配不到（2026-11-10 实测，7zz 静默输出 Files: 0）。
 */
const LINUX_APP_PACKAGE_JSON = "./opt/QQ/resources/app/package.json";

/**
 * 目前**自动维护**的 Linux 架构。
 *
 * 只开 x64：arm64 的 stub 产物、清单条目与 loader 预加载（libuuid）按既定策略要等
 * **真机**验证后一起上（见 `docs/architecture/linux-native-host.md` §9.11 / 附录 E）。
 * 自动更新若抢先写入 arm64 条目，等于给用户一个未验证的下载入口——因此这里先钉死
 * x64，真机通过后把 "arm64" 加进数组即可（`arm64Deb` 已解析好，无需改别处）。
 */
const LINUX_MAINTAINED_ARCHES: readonly QqReleaseArch[] = ["x64"];

/** Linux 官方配置解析结果（只取 deb 相关字段）。 */
interface LinuxRelease {
    /** 客户端营销版本（3.2.35）。 */
    marketingVersion: string;
    /** 构建日期（2026-11-03）。 */
    updateDate: string;
    /** x64 deb 下载 URL。 */
    x64Deb: string;
    /** arm64 deb 下载 URL（当前不自动登记条目，但解析仍要求存在）。 */
    arm64Deb: string;
}

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

/**
 * 下载文件并流式计算 sha256（失败清理半成品），返回十六进制小写 sha256。
 * 完整性校验见 assertDownloadComplete（抽成独立函数：内联会把本函数圈复杂度
 * 从 5 推到 6、触发 fallow 增量门禁 CRAP 超阈，同「重试体线性展开」口径）。
 */
async function downloadFile(url: string, dest: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createWriteStream(dest);
    try {
        const res = await httpsGet(url, 120_000);
        const declared = Number.parseInt(res.headers["content-length"] ?? "", 10);
        let received = 0;
        await new Promise<void>((resolvePromise, reject) => {
            res.on("data", (chunk: Buffer) => {
                hash.update(chunk);
                received += chunk.length;
            });
            res.on("error", reject);
            stream.on("error", reject);
            stream.on("finish", resolvePromise);
            res.pipe(stream);
        });
        assertDownloadComplete(declared, received);
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

/**
 * 官方营销版本是否低于清单已知版本（防降级）。
 *
 * Windows 与 Linux 共用同一口径：营销三段逐位比较、忽略构建号。CDN 边缘可能仍在供
 * **旧缓存**配置（2026-11-11：部分边缘的 linuxConfig.js 回退到 3.2.33，源站已是
 * 3.2.35），把旧版当新版处理会去下载早已下架的包。
 */
function isDowngrade(officialMarketing: string, knownVersion: string): boolean {
    return compareVersions(officialMarketing, marketingOf(knownVersion)) < 0;
}

/** 平台排序权重（Windows 段在前，Linux 段在后，保持清单可读）。 */
function platformRank(entry: QqReleaseEntry): number {
    return releasePlatform(entry) === "linux" ? 1 : 0;
}

/** 架构排序权重（x64 在 arm64 前）。 */
function archRank(entry: QqReleaseEntry): number {
    return (entry.arch ?? "x64") === "arm64" ? 1 : 0;
}

/** 清单条目排序：平台段 → 版本 → 架构（返回新数组）。 */
function sortEntries(entries: QqReleaseEntry[]): QqReleaseEntry[] {
    return [...entries].sort((a, b) => {
        const byPlatform = platformRank(a) - platformRank(b);
        if (byPlatform !== 0) {
            return byPlatform;
        }
        const byVersion = compareVersions(a.version, b.version);
        return byVersion !== 0 ? byVersion : archRank(a) - archRank(b);
    });
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

/**
 * 合并 Linux 条目：同 (version, platform=linux, arch) 替换并保留已有非零 appid，
 * 否则追加。**不能**复用 mergeEntry——x64 与 arm64 的 version 字符串相同
 * （都是 `3.2.35-54395`），只按 version 合并会把另一个架构覆盖掉。
 */
function mergeLinuxEntry(known: QqReleaseEntry[], entry: QqReleaseEntry): QqReleaseEntry[] {
    const sameSlot = (item: QqReleaseEntry): boolean =>
        item.version === entry.version &&
        releasePlatform(item) === "linux" &&
        (item.arch ?? "x64") === (entry.arch ?? "x64");
    const existing = known.find(sameSlot);
    const appid = existing !== undefined && existing.appid > 0 ? existing.appid : entry.appid;
    return sortEntries([...known.filter((item) => !sameSlot(item)), { ...entry, appid }]);
}

/** 取 `linuxConfig.js` 里的 params 对象（正则不中/JSON 非法/非对象 → null）。 */
function linuxConfigPayload(text: string): Record<string, unknown> | null {
    const match = LINUX_CONFIG_PARAMS_RE.exec(text);
    if (match?.[1] === undefined) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(match[1]);
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** 取三段数字的营销版本字段（缺失/格式不符 → null）。 */
function readMarketingVersion(obj: Record<string, unknown>): string | null {
    const version = obj["version"];
    return typeof version === "string" && MARKETING_VERSION_RE.test(version) ? version : null;
}

/** 取字符串字段（缺失/空串 → null）。 */
function readString(obj: Record<string, unknown>, key: string): string | null {
    const value = obj[key];
    return typeof value === "string" && value !== "" ? value : null;
}

/** 从 `linuxConfig.js` 文本解析 Linux 最新版本与 deb URL（结构不符返回 null）。 */
function parseLinuxConfig(text: string): LinuxRelease | null {
    const obj = linuxConfigPayload(text);
    if (obj === null) {
        return null;
    }
    const fields = {
        marketingVersion: readMarketingVersion(obj),
        updateDate: readString(obj, "updateDate"),
        x64Deb: readDebUrl(obj["x64DownloadUrl"]),
        arm64Deb: readDebUrl(obj["armDownloadUrl"]),
    };
    if (Object.values(fields).includes(null)) {
        return null;
    }
    return fields as LinuxRelease;
}

/** 取 `x64DownloadUrl.deb` 一类的 URL 字段（非 https 或缺失返回 null）。 */
function readDebUrl(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const deb = (value as Record<string, unknown>)["deb"];
    return typeof deb === "string" && deb.startsWith("https://") ? deb : null;
}

/** 从 deb URL 提取 QQNT 核心版本（…/QQNTV2/9.9.37/release/… → 9.9.37）。 */
function coreVersionOf(url: string): string | null {
    return CORE_VERSION_RE.exec(url)?.[1] ?? null;
}

/** 抓 Linux 官方配置；失败只 warn（Linux 侧不拖累 Windows 更新）。 */
async function fetchLinuxRelease(): Promise<LinuxRelease | null> {
    try {
        const release = parseLinuxConfig(await fetchText(LINUX_CONFIG_URL));
        if (release === null) {
            warn(`Linux 官方配置结构不符，跳过 Linux 条目：${LINUX_CONFIG_URL}`);
        }
        return release;
    } catch (err) {
        warn(`Linux 官方配置获取失败（${errorMessage(err)}），跳过 Linux 条目`);
        return null;
    }
}

/** 执行 7z（解包/提取），返回 stdout；失败抛可读错误。 */
async function runSevenZip(sevenZip: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        execFile(sevenZip, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err !== null) {
                const code = (err as NodeJS.ErrnoException).code;
                const hint =
                    code === "ENOENT"
                        ? `未找到 7-Zip: ${sevenZip}`
                        : `7z 执行失败（${args[0] ?? ""}）：${stderr.trim() || err.message}`;
                reject(new Error(hint));
                return;
            }
            resolvePromise(stdout);
        });
    });
}

/**
 * 三层解包 deb 并只取 `resources/app/package.json`，读客户端版本（3.2.35-54395）。
 * 只提取 KB 级文件（不落 600MB 解包树）：`7z e` 按路径过滤直接展平输出。
 */
async function debClientVersion(debPath: string, workDir: string): Promise<string | null> {
    const sevenZip = findSevenZip();
    const d0 = join(workDir, "d0");
    const d1 = join(workDir, "d1");
    const d2 = join(workDir, "d2");
    await runSevenZip(sevenZip, ["x", debPath, `-o${d0}`, "-y"]);
    const payload = [join(d0, "data.tar.xz"), join(d0, "data.tar")].find((p) => existsSync(p));
    if (payload === undefined) {
        warn("deb 内未找到 data.tar(.xz)");
        return null;
    }
    await runSevenZip(sevenZip, ["x", payload, `-o${d1}`, "-y"]);
    const dataTar = join(d1, "data.tar");
    if (!existsSync(dataTar)) {
        warn("deb 载荷内未找到 data.tar");
        return null;
    }
    await runSevenZip(sevenZip, ["e", dataTar, LINUX_APP_PACKAGE_JSON, `-o${d2}`, "-y"]);
    const pkgPath = join(d2, "package.json");
    if (!existsSync(pkgPath)) {
        warn(`deb 内未找到 ${LINUX_APP_PACKAGE_JSON}`);
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        const version =
            typeof parsed === "object" && parsed !== null
                ? (parsed as Record<string, unknown>)["version"]
                : undefined;
        return typeof version === "string" && version !== "" ? version : null;
    } catch {
        warn("deb 内 package.json 解析失败");
        return null;
    }
}

/** 下载 deb 并组装 Linux 条目（版本从 deb 内取；appid 沿用已有值，未知记 0）。 */
async function buildLinuxEntry(
    arch: QqReleaseArch,
    url: string,
    release: LinuxRelease,
    coreVersion: string,
    existing: QqReleaseEntry | undefined,
): Promise<QqReleaseEntry | null> {
    const tmp = mkdtempSync(join(tmpdir(), `napuketto-qq-linux-${arch}-`));
    try {
        const debPath = join(tmp, "qq.deb");
        info(`Linux ${arch}：下载 deb 并计算 sha256…`);
        // 与 Windows 同理：请求走小写路径段，清单仍存官方原样 URL；
        // 重试穷尽后的失败由 safeLinuxEntry 兜住（只 warn 并跳过该架构）
        const sha256 = await downloadFileWithRetry(normalizeDownloadUrl(url), debPath);
        info(`Linux ${arch} sha256: ${sha256}`);
        // 解包失败（7z 缺失/归档损坏）只影响 Linux 这一侧：warn 后跳过该架构，
        // 不能让异常冒到 main（那会把 Windows 侧已算好的更新一起丢掉）
        let version: string | null;
        try {
            version = await debClientVersion(debPath, tmp);
        } catch (err) {
            warn(`Linux ${arch} deb 解包失败（${errorMessage(err)}），跳过该架构`);
            return null;
        }
        if (version === null) {
            warn(`Linux ${arch} 无法从 deb 解析客户端版本，跳过该架构`);
            return null;
        }
        info(`Linux ${arch} 版本: ${version}（core ${coreVersion}）`);
        return {
            version,
            platform: "linux",
            arch,
            coreVersion,
            url,
            sha256,
            appid: existing?.appid ?? 0,
            source: "official",
            buildDate: release.updateDate,
        };
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

/**
 * 组装 Linux 条目（单架构失败隔离）：下载 / 临时目录 / 解包任一环节抛错都只 warn 并
 * 返回 null，由调用方跳过该架构。
 *
 * **为什么需要**（2026-11-11，issue #100）：CDN 边缘供旧版配置 → 旧 deb 已下架 →
 * 下载 404 重试穷尽后抛错，异常一路冒到 main，把整次运行判失败并开追踪 issue（Windows
 * 侧其实无事可做）。Linux 是附加条目，失败只该降级成一条 warn。
 */
async function safeLinuxEntry(
    arch: QqReleaseArch,
    url: string,
    release: LinuxRelease,
    coreVersion: string,
    existing: QqReleaseEntry | undefined,
): Promise<QqReleaseEntry | null> {
    try {
        return await buildLinuxEntry(arch, url, release, coreVersion, existing);
    } catch (err) {
        warn(`Linux ${arch} 处理失败（${errorMessage(err)}），跳过该架构`);
        return null;
    }
}

/**
 * 取某架构下**版本最高**的 Linux 条目。
 *
 * 清单按设计保留历史版本（Windows 那边也是多条），所以同一 arch 可能有多条记录；
 * 「URL 未变 → 跳过」必须拿最新那条比对。用 `find` 取首条会命中最早的历史条目 ——
 * 于是每次 cron 都判定「URL 变了」、重复下载 190MB deb（2026-11-10 真实跑才发现）。
 */
function latestLinuxEntry(
    entries: QqReleaseEntry[],
    arch: QqReleaseArch,
): QqReleaseEntry | undefined {
    return entries
        .filter((entry) => releasePlatform(entry) === "linux" && (entry.arch ?? "x64") === arch)
        .reduce<QqReleaseEntry | undefined>(
            (best, entry) =>
                best === undefined || compareVersions(entry.version, best.version) > 0
                    ? entry
                    : best,
            undefined,
        );
}

/**
 * 该架构是否无需更新：URL 未变（已是最新）或官方回退旧版（防降级）。
 *
 * 返回需要打印的 info 文案，需要更新时返回 null。把判定与提示放在一起，是为了让
 * updateLinuxStep 的循环保持线性（复杂度门禁口径，见 fallow 配置注释）。
 */
function linuxSkipReason(
    existing: QqReleaseEntry | undefined,
    marketingVersion: string,
    url: string,
    arch: QqReleaseArch,
): string | null {
    if (existing === undefined) {
        return null;
    }
    if (existing.url === url) {
        return `Linux ${arch} 已是最新（${existing.version}），URL 未变，跳过`;
    }
    if (isDowngrade(marketingVersion, existing.version)) {
        return (
            `Linux ${arch} 官方配置为 ${marketingVersion}，低于清单 ${existing.version}` +
            "（CDN 边缘可能仍是旧缓存），跳过（防降级）"
        );
    }
    return null;
}

/** Linux 更新单步：每架构比对 URL → 变更时下载/解版本 → 合并（失败只 warn）。 */
async function updateLinuxStep(known: QqReleaseEntry[], dryRun: boolean): Promise<UpdateStep> {
    const release = await fetchLinuxRelease();
    if (release === null) {
        return { entries: known, changed: false };
    }
    info(`Linux 官方最新: 版本=${release.marketingVersion} 日期=${release.updateDate}`);
    let entries = known;
    let changed = false;
    const targets: readonly { arch: QqReleaseArch; url: string }[] = LINUX_MAINTAINED_ARCHES.map(
        (arch) => ({
            arch,
            url: arch === "arm64" ? release.arm64Deb : release.x64Deb,
        }),
    );
    for (const target of targets) {
        const { url } = target;
        const existing = latestLinuxEntry(entries, target.arch);
        const skip = linuxSkipReason(existing, release.marketingVersion, url, target.arch);
        if (skip !== null) {
            info(skip);
            continue;
        }
        const coreVersion = coreVersionOf(url);
        if (coreVersion === null) {
            warn(`Linux ${target.arch} URL 无法解析 QQNT 核心版本，跳过：${url}`);
            continue;
        }
        if (dryRun) {
            info(`[dry-run] 将更新 Linux ${target.arch} 条目（core=${coreVersion}，URL=${url}）`);
            continue;
        }
        const entry = await safeLinuxEntry(target.arch, url, release, coreVersion, existing);
        if (entry === null) {
            continue;
        }
        entries = mergeLinuxEntry(entries, entry);
        changed = true;
    }
    return { entries, changed };
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
    if (parsed.schema !== 2 || !Array.isArray(parsed.known) || parsed.known.length === 0) {
        throw new Error("qq-releases.json 结构不合法（需 schema=2 且 known 非空数组）");
    }
    return parsed as QqReleasesFile;
}

/** 写清单（4 空格缩进 + 换行，与仓库格式一致）。 */
function saveManifest(manifest: QqReleasesFile): void {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
}

/** 单步（Windows / Linux）更新结果：changed=false 时不落盘，entries 供下一步合并。 */
interface UpdateStep {
    entries: QqReleaseEntry[];
    changed: boolean;
}

/** Windows 更新单步：抓 rainbow → 比对 → 下载 → 解版本号 → 合并（原 main 行为不变）。 */
async function updateWindowsStep(manifest: QqReleasesFile, dryRun: boolean): Promise<UpdateStep> {
    // 1. 抓官方下载配置，解析最新 Windows 版本 + 下载 URL
    const release = await fetchLatestRelease();
    if (release === null) {
        throw new Error("官方下载配置解析失败（页面结构可能已变），未更新清单");
    }
    info(`官方最新: 版本=${release.marketingVersion} 日期=${release.updateDate}`);
    info(`下载 URL: ${release.x64Url}`);
    // 实际请求用小写路径段（绕 CDN 边缘对 /QQNTV2/ 的大小写敏感拦截）；清单仍存官方原样 URL
    const downloadUrl = normalizeDownloadUrl(release.x64Url);
    if (downloadUrl !== release.x64Url) {
        info(`请求 URL 归一化: ${downloadUrl}`);
    }

    // 2. 与清单比对：URL 未变 → no-op；营销版本回退 → 跳过（防降级，可能是备用源滞后）
    //    只比 Windows 条目：清单同时存在 Linux deb 条目，直接取末项会拿 Linux 版本比对。
    const sorted = sortEntries(
        manifest.known.filter((entry) => releasePlatform(entry) === "win32"),
    );
    const latest = sorted[sorted.length - 1];
    if (latest !== undefined && latest.url === release.x64Url) {
        info(`清单已是最新（${latest.version}），URL 未变，无需更新`);
        return { entries: manifest.known, changed: false };
    }
    if (latest !== undefined && isDowngrade(release.marketingVersion, latest.version)) {
        info(
            `官方返回营销版本 ${release.marketingVersion} 低于清单 ${latest.version}，跳过（防降级）`,
        );
        return { entries: manifest.known, changed: false };
    }

    if (dryRun) {
        info(
            `[dry-run] 将新增/更新条目: ${release.marketingVersion}-<构建号>（URL=${release.x64Url}）`,
        );
        info("[dry-run] 未下载、未写清单（--dry-run）");
        return { entries: manifest.known, changed: false };
    }

    // 3. 下载安装包 + 流式 sha256
    const tmp = mkdtempSync(join(tmpdir(), "napuketto-qq-"));
    try {
        const installerPath = join(tmp, "installer.exe");
        info("下载安装包并计算 sha256…");
        const sha256 = await downloadFileWithRetry(downloadUrl, installerPath);
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
        info(`✅ Windows 条目: ${version}`);
        return { entries: merged, changed: true };
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

/**
 * 主流程（可被 CLI 直接调用；返回退出码）：Windows 与 Linux 两侧各跑一次，合并后落盘。
 * Windows 侧失败要非零退出（用户拿不到新版 = 真故障）；Linux 侧失败只 warn（附加条目）。
 */
async function main(argv: readonly string[]): Promise<number> {
    const { dryRun } = parseArgs(argv);
    const manifest = loadManifest();

    const windows = await updateWindowsStep(manifest, dryRun);
    // 最后一层隔离：Linux 侧漏网异常只 warn，Windows 已算好的更新照常落盘
    const linux = await updateLinuxStep(windows.entries, dryRun).catch((err: unknown) => {
        warn(`Linux 更新异常（${errorMessage(err)}），跳过 Linux 条目`);
        return { entries: windows.entries, changed: false };
    });
    const known = linux.entries;

    if (windows.changed || linux.changed) {
        saveManifest({ schema: manifest.schema, known });
        info(`✅ 已更新清单（共 ${known.length} 条，Windows 在前、Linux 在后）`);
    } else {
        info("清单无需更新");
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

// —— 下载完整性校验（同上下载重试：置于文件末尾，独立成函数以守住 downloadFile 的
// 圈复杂度口径）——

/**
 * 校验下载完整性：响应声明了 `Content-Length` 时，实际接收字节数必须一致。
 *
 * 截断的传输（连接正常关闭但少收字节）不会触发流错误，若不校验就会把**残缺文件的
 * sha256 写进清单**——而运行时 downloadFile 拿清单里的 sha256 校验，会让全体用户
 * 一起失败。经归一化路径（小写 `/qqntv2/`）取包时这道兜底尤其有价值：CDN 若对
 * 大小写不同的路径返回了缓存错误页，长度不一致能立刻发现。
 */
function assertDownloadComplete(declared: number, received: number): void {
    if (Number.isFinite(declared) && declared !== received) {
        throw new Error(`下载不完整: 声明 ${declared} 字节，实际 ${received} 字节`);
    }
}
