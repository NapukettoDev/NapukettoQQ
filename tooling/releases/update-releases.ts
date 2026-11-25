#!/usr/bin/env node
/**
 * update-releases.ts：releases.json 自动维护脚本（纯 Node 零第三方依赖，直接 node 运行）。
 * 用法：node tooling/releases/update-releases.ts [--dry-run]
 * 约束：零相对 .ts import；请求前统一 normalizeDownloadUrl（绕 /QQNTV2/ 大小写拦截），清单写原 URL。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
    QqReleaseArch,
    QqReleaseEntry,
    QqReleasesFile,
} from "../../packages/loader/src/artifacts/manifests/releases.ts";
import {
    normalizeDownloadUrl,
    releasePlatform,
} from "../../packages/loader/src/artifacts/manifests/releases.ts";
import { findBundledSevenZip } from "../../packages/loader/src/artifacts/manifests/seven-zip.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(REPO_ROOT, "packages", "loader", "releases.json");
const SEVEN_ZIP_DIR = join(REPO_ROOT, "packages", "loader", "assets", "7zip");
const USER_AGENT = "napuketto-releases/1.0";

const PC_CONFIG_URLS = [
    "https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json",
    "https://pre.cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/pcConfig.json",
];
const LINUX_CONFIG_URL = "https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js";
const MARKETING_RE = /^\d+\.\d+\.\d+$/;
const VERSION_DIR_RE = /versions[\\/]([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)[\\/]/g;
const LINUX_PARAMS_RE = /var\s+params\s*=\s*(\{[\s\S]*?\})\s*;/;
const CORE_VERSION_RE = /\/(\d+\.\d+\.\d+)\/release\//;
/** 前缀 `./` 必须保留：deb 内 data.tar 路径带 `./`，否则 7z 静默匹配 0 文件。 */
const LINUX_PKG_JSON = "./opt/QQ/resources/app/package.json";
/** 当前自动维护的 Linux 架构（arm64 真机验证通过后直接加入即可）。 */
const LINUX_ARCHES: readonly QqReleaseArch[] = ["x64"];

type WinRel = { marketingVersion: string; updateDate: string; x64Url: string };
type LinuxRel = { marketingVersion: string; updateDate: string; x64Deb: string; arm64Deb: string };
type Step = { entries: QqReleaseEntry[]; changed: boolean };

const info = (msg: string): void => console.log(`[update-releases] ${msg}`);
const warn = (msg: string): void => void process.stderr.write(`[update-releases] ⚠ ${msg}\n`);
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isRec = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | null =>
    typeof o[k] === "string" && o[k] !== "" ? o[k] : null;

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
}

async function downloadFile(url: string, dest: string): Promise<string> {
    const hash = createHash("sha256");
    const out = createWriteStream(dest);
    try {
        const res = await fetch(url, {
            headers: { "user-agent": USER_AGENT },
            redirect: "follow",
            signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}: ${url}`);
        const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
        let received = 0;
        for await (const chunk of res.body) {
            hash.update(chunk);
            received += chunk.byteLength;
            if (!out.write(chunk)) await once(out, "drain");
        }
        out.end();
        await once(out, "finish");
        if (Number.isFinite(declared) && declared !== received) {
            throw new Error(`下载不完整: 声明 ${declared} 字节，实际 ${received} 字节`);
        }
        return hash.digest("hex");
    } catch (err) {
        out.destroy();
        await rm(dest, { force: true });
        throw err instanceof Error ? err : new Error(String(err));
    }
}

async function downloadWithRetry(
    url: string,
    dest: string,
    delays: readonly number[] = [5_000, 15_000],
): Promise<string> {
    try {
        return await downloadFile(url, dest);
    } catch (err) {
        const [ms, ...rest] = delays;
        if (ms === undefined) throw new Error(`下载失败（重试 2 次后仍放弃）: ${errMsg(err)}`);
        warn(`下载失败，${Math.round(ms / 1000)}s 后重试: ${errMsg(err)}`);
        await new Promise((r) => setTimeout(r, ms));
        return downloadWithRetry(url, dest, rest);
    }
}

function find7z(): string {
    const env = process.env["NAPUKETTO_7Z_PATH"];
    if (env && existsSync(env)) return env;
    return findBundledSevenZip(SEVEN_ZIP_DIR, process.platform === "win32" ? "win32" : "linux") ?? "7z";
}

async function run7z(args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
    const bin = find7z();
    try {
        return (await execFileAsync(bin, args, { maxBuffer })).stdout;
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        throw new Error(
            e.code === "ENOENT"
                ? `未找到 7-Zip: ${bin}`
                : `7z 执行失败（${args[0] ?? ""}）：${e.stderr?.trim() || e.message}`,
        );
    }
}

function scanVersionInFile(filePath: string, marketing: string): string | null {
    const buf = readFileSync(filePath);
    for (const encoding of ["utf16le", "ascii"] as const) {
        for (const sep of [".", "-"] as const) {
            const needle = Buffer.from(`${marketing}${sep}`, encoding);
            const idx = buf.indexOf(needle);
            if (idx < 0) continue;
            const step = encoding === "utf16le" ? 2 : 1;
            let build = "";
            for (let p = idx + needle.length; p + step <= buf.length; p += step) {
                const c = encoding === "utf16le" ? buf.readUInt16LE(p) : (buf[p] ?? 0);
                if (c < 0x30 || c > 0x39) break;
                build += String.fromCharCode(c);
            }
            if (build) return `${marketing}-${build}`;
        }
    }
    return null;
}

async function resolveVersion(installerPath: string, marketing: string): Promise<string | null> {
    try {
        const listing = await run7z(["l", installerPath], 64 * 1024 * 1024);
        for (const m of listing.matchAll(VERSION_DIR_RE)) {
            if (m[1]?.startsWith(`${marketing}-`)) return m[1];
        }
        warn("7z 归档列表未含版本目录，回退字节扫描");
    } catch (err) {
        warn(`7z 不可用（${errMsg(err)}），回退字节扫描`);
    }
    return scanVersionInFile(installerPath, marketing);
}

function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [m = "", bld = "0"] = v.split("-");
        return { p: m.split(".").map((x) => Number.parseInt(x, 10) || 0), b: Number.parseInt(bld, 10) || 0 };
    };
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(pa.p.length, pb.p.length); i += 1) {
        const diff = (pa.p[i] ?? 0) - (pb.p[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return pa.b - pb.b;
}

function sortEntries(entries: QqReleaseEntry[]): QqReleaseEntry[] {
    return [...entries].sort(
        (a, b) =>
            Number(releasePlatform(a) === "linux") - Number(releasePlatform(b) === "linux") ||
            compareVersions(a.version, b.version) ||
            Number((a.arch ?? "x64") === "arm64") - Number((b.arch ?? "x64") === "arm64"),
    );
}

function mergeEntry(known: QqReleaseEntry[], entry: QqReleaseEntry): QqReleaseEntry[] {
    const same = (x: QqReleaseEntry) =>
        x.version === entry.version &&
        releasePlatform(x) === releasePlatform(entry) &&
        (x.arch ?? "x64") === (entry.arch ?? "x64");
    const prev = known.find(same);
    const appid = prev && prev.appid > 0 ? prev.appid : entry.appid;
    return sortEntries([...known.filter((x) => !same(x)), { ...entry, appid }]);
}

function skipReason(label: string, cur: QqReleaseEntry | undefined, marketing: string, url: string): string | null {
    if (!cur) return null;
    if (cur.url === url) return `${label} 已是最新（${cur.version}），URL 未变，跳过`;
    if (compareVersions(marketing, cur.version.split("-")[0] ?? cur.version) < 0) {
        return `${label} 官方配置为 ${marketing}，低于清单 ${cur.version}，跳过（防降级）`;
    }
    return null;
}

function isEntry(v: unknown): v is QqReleaseEntry {
    return (
        isRec(v) &&
        typeof v["version"] === "string" &&
        typeof v["url"] === "string" &&
        typeof v["sha256"] === "string" &&
        typeof v["appid"] === "number" &&
        typeof v["source"] === "string" &&
        (v["platform"] === undefined || v["platform"] === "win32" || v["platform"] === "linux") &&
        (v["arch"] === undefined || v["arch"] === "x64" || v["arch"] === "arm64") &&
        (v["coreVersion"] === undefined || typeof v["coreVersion"] === "string") &&
        (v["buildDate"] === undefined || typeof v["buildDate"] === "string")
    );
}

function loadManifest(): QqReleasesFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    } catch (err) {
        throw new Error(`releases.json 解析失败: ${String(err)}`);
    }
    if (!isRec(parsed) || parsed["schema"] !== 2 || !Array.isArray(parsed["known"]) || parsed["known"].length === 0) {
        throw new Error("releases.json 结构不合法（需 schema=2 且 known 非空数组）");
    }
    const bad = parsed["known"].find((item) => !isEntry(item));
    if (bad !== undefined) {
        throw new Error(`releases.json 结构不合法（known 含非法条目: ${JSON.stringify(bad)?.slice(0, 120)}）`);
    }
    return { schema: 2, known: parsed["known"] as QqReleaseEntry[] };
}

async function fetchWindowsRelease(): Promise<WinRel | null> {
    for (const url of PC_CONFIG_URLS) {
        try {
            const raw: unknown = JSON.parse(await fetchText(url));
            const win = isRec(raw) && isRec(raw["Windows"]) ? raw["Windows"] : null;
            const version = win ? str(win, "version") : null;
            const updateDate = win && typeof win["updateDate"] === "string" ? win["updateDate"] : null;
            const x64Url = win && typeof win["ntDownloadX64Url"] === "string" ? win["ntDownloadX64Url"] : null;
            if (version && MARKETING_RE.test(version) && updateDate !== null && x64Url !== null) {
                return { marketingVersion: version, updateDate, x64Url };
            }
            warn(`配置结构解析失败: ${url}`);
        } catch (err) {
            warn(`配置抓取失败: ${url}（${errMsg(err)}）`);
        }
    }
    return null;
}

async function updateWindowsStep(manifest: QqReleasesFile, dryRun: boolean): Promise<Step> {
    const rel = await fetchWindowsRelease();
    if (!rel) throw new Error("官方下载配置解析失败（页面结构可能已变），未更新清单");
    info(`官方最新: 版本=${rel.marketingVersion} 日期=${rel.updateDate}\n[update-releases] 下载 URL: ${rel.x64Url}`);
    const dlUrl = normalizeDownloadUrl(rel.x64Url);
    if (dlUrl !== rel.x64Url) info(`请求 URL 归一化: ${dlUrl}`);

    const latest = sortEntries(manifest.known.filter((e) => releasePlatform(e) === "win32")).at(-1);
    const skip = skipReason("清单", latest, rel.marketingVersion, rel.x64Url);
    if (skip) return (info(skip), { entries: manifest.known, changed: false });
    if (dryRun) {
        info(`[dry-run] 将新增/更新条目: ${rel.marketingVersion}-<构建号>（URL=${rel.x64Url}）`);
        return { entries: manifest.known, changed: false };
    }

    const tmp = mkdtempSync(join(tmpdir(), "napuketto-"));
    try {
        const exe = join(tmp, "installer.exe");
        info("下载安装包并计算 sha256…");
        const sha256 = await downloadWithRetry(dlUrl, exe);
        info(`sha256: ${sha256}`);
        const version = await resolveVersion(exe, rel.marketingVersion);
        if (!version) throw new Error(`无法从安装包解析版本目录名（营销版本=${rel.marketingVersion}），未更新清单`);
        info(`✅ Windows 条目: ${version}`);
        return {
            entries: mergeEntry(manifest.known, {
                version, url: rel.x64Url, sha256, appid: 0, source: "official", buildDate: rel.updateDate,
            }),
            changed: true,
        };
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

async function fetchLinuxRelease(): Promise<LinuxRel | null> {
    try {
        const match = LINUX_PARAMS_RE.exec(await fetchText(LINUX_CONFIG_URL));
        const obj: unknown = match?.[1] ? JSON.parse(match[1]) : null;
        const deb = (v: unknown) => (isRec(v) && typeof v["deb"] === "string" && v["deb"].startsWith("https://") ? v["deb"] : null);
        const version = isRec(obj) ? str(obj, "version") : null;
        const updateDate = isRec(obj) ? str(obj, "updateDate") : null;
        const x64Deb = isRec(obj) ? deb(obj["x64DownloadUrl"]) : null;
        const arm64Deb = isRec(obj) ? deb(obj["armDownloadUrl"]) : null;
        if (version && MARKETING_RE.test(version) && updateDate && x64Deb && arm64Deb) {
            return { marketingVersion: version, updateDate, x64Deb, arm64Deb };
        }
        warn(`Linux 官方配置结构不符，跳过 Linux 条目：${LINUX_CONFIG_URL}`);
        return null;
    } catch (err) {
        warn(`Linux 官方配置获取失败（${errMsg(err)}），跳过 Linux 条目`);
        return null;
    }
}

async function debClientVersion(debPath: string, workDir: string): Promise<string | null> {
    const [d0, d1, d2] = [join(workDir, "d0"), join(workDir, "d1"), join(workDir, "d2")] as const;
    await run7z(["x", debPath, `-o${d0}`, "-y"]);
    const payload = [join(d0, "data.tar.xz"), join(d0, "data.tar")].find(existsSync);
    if (!payload) return (warn("deb 内未找到 data.tar(.xz)"), null);
    await run7z(["x", payload, `-o${d1}`, "-y"]);
    const dataTar = join(d1, "data.tar");
    if (!existsSync(dataTar)) return (warn("deb 载荷内未找到 data.tar"), null);
    await run7z(["e", dataTar, LINUX_PKG_JSON, `-o${d2}`, "-y"]);
    const pkgPath = join(d2, "package.json");
    if (!existsSync(pkgPath)) return (warn(`deb 内未找到 ${LINUX_PKG_JSON}`), null);
    try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        return isRec(parsed) ? str(parsed, "version") : null;
    } catch {
        return (warn("deb 内 package.json 解析失败"), null);
    }
}

async function updateLinuxStep(known: QqReleaseEntry[], dryRun: boolean): Promise<Step> {
    const rel = await fetchLinuxRelease();
    if (!rel) return { entries: known, changed: false };
    info(`Linux 官方最新: 版本=${rel.marketingVersion} 日期=${rel.updateDate}`);

    let entries = known;
    let changed = false;
    for (const arch of LINUX_ARCHES) {
        const url = arch === "arm64" ? rel.arm64Deb : rel.x64Deb;
        const cur = sortEntries(entries.filter((e) => releasePlatform(e) === "linux" && (e.arch ?? "x64") === arch)).at(-1);
        const skip = skipReason(`Linux ${arch}`, cur, rel.marketingVersion, url);
        if (skip) { info(skip); continue; }
        const coreVersion = CORE_VERSION_RE.exec(url)?.[1] ?? null;
        if (!coreVersion) { warn(`Linux ${arch} URL 无法解析 QQNT 核心版本，跳过：${url}`); continue; }
        if (dryRun) { info(`[dry-run] 将更新 Linux ${arch} 条目（core=${coreVersion}，URL=${url}）`); continue; }

        let tmp: string | undefined;
        try {
            tmp = mkdtempSync(join(tmpdir(), `napuketto-linux-${arch}-`));
            const debPath = join(tmp, "qq.deb");
            info(`Linux ${arch}：下载 deb 并计算 sha256…`);
            const sha256 = await downloadWithRetry(normalizeDownloadUrl(url), debPath);
            const version = await debClientVersion(debPath, tmp);
            if (!version) { warn(`Linux ${arch} 无法从 deb 解析客户端版本，跳过该架构`); continue; }
            info(`Linux ${arch} 版本: ${version}（core ${coreVersion}），sha256: ${sha256}`);
            entries = mergeEntry(entries, {
                version, platform: "linux", arch, coreVersion, url, sha256,
                appid: cur?.appid ?? 0, source: "official", buildDate: rel.updateDate,
            });
            changed = true;
        } catch (err) {
            warn(`Linux ${arch} 处理失败（${errMsg(err)}），跳过该架构`);
        } finally {
            if (tmp) await rm(tmp, { recursive: true, force: true });
        }
    }
    return { entries, changed };
}

async function main(argv: readonly string[]): Promise<number> {
    const dryRun = argv.includes("--dry-run");
    const manifest = loadManifest();
    const win = await updateWindowsStep(manifest, dryRun);
    const linux = await updateLinuxStep(win.entries, dryRun).catch((err: unknown) => {
        warn(`Linux 更新异常（${errMsg(err)}），跳过 Linux 条目`);
        return { entries: win.entries, changed: false };
    });
    if (win.changed || linux.changed) {
        writeFileSync(MANIFEST_PATH, `${JSON.stringify({ schema: manifest.schema, known: linux.entries }, null, 4)}\n`, "utf8");
        info(`✅ 已更新清单（共 ${linux.entries.length} 条，Windows 在前、Linux 在后）`);
    } else {
        info("清单无需更新");
    }
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2))
        .then((code) => { process.exitCode = code; })
        .catch((err: unknown) => {
            process.stderr.write(`[update-releases] ❌ ${errMsg(err)}\n`);
            process.exitCode = 1;
        });
}
