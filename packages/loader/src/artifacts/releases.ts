/**
 * releases.ts：版本清单读取与查询（P1）。
 *
 * 运行时从包根 releases.json 读取（发布时 files 含它，安装后位于
 * node_modules/@napuketto/loader/releases.json）。
 *
 * 维护机制（真实存在，非「声称」）：清单由 CI 自动维护——
 * .github/workflows/update-releases.yml（每日 cron + 手动触发）调用
 * tooling/releases/update-releases.ts（纯 Node，与本地共用），抓取 QQ 官方下载配置
 * 解析最新版 + 下载安装包计算 sha256 + 解析安装包内部版本目录后更新本清单
 * （保留历史条目、known 按版本递增）。社区 PR 仍可手动补充。NAPUKETTO_QQ_URL
 * 可运行时覆盖下载地址（用户拿到新链接时用）。
 *
 * 形状 / 常量 / 纯函数在 `manifests/releases.ts`：那个文件必须保持零 TS 源码
 * 相对 import，因为更新脚本由 `node` 直接执行（类型剥离不重写 `.js` → `.ts`
 * 说明符）。本文件只做「读文件 + 查询」；需要清单形状或归一化函数时直接从
 * `manifests/releases.ts` 引入，不经本文件二次透传。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { packageRoot } from "../shared/package.js";
import { isRecord } from "../shared/type-guards.js";
import type { QqReleaseEntry, QqReleasesFile } from "./manifests/releases.js";
import { QQ_RELEASES_SCHEMA, releaseArch, releasePlatform } from "./manifests/releases.js";

/** 清单解析失败。 */
export class QqReleasesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QqReleasesError";
    }
}

/** 未知 JSON 值 → 清单条目（严格结构校验；失败返回 null，不做强转）。 */
function parseReleaseEntry(raw: unknown): QqReleaseEntry | null {
    if (!isRecord(raw)) {
        return null;
    }
    if (
        typeof raw["version"] !== "string" ||
        raw["version"] === "" ||
        typeof raw["url"] !== "string" ||
        typeof raw["sha256"] !== "string" ||
        typeof raw["appid"] !== "number" ||
        typeof raw["source"] !== "string"
    ) {
        return null;
    }
    const platform = raw["platform"];
    const arch = raw["arch"];
    return {
        version: raw["version"],
        url: raw["url"],
        sha256: raw["sha256"],
        appid: raw["appid"],
        source: raw["source"],
        ...(platform === "win32" || platform === "linux" ? { platform } : {}),
        ...(arch === "x64" || arch === "arm64" ? { arch } : {}),
        ...(typeof raw["coreVersion"] === "string" ? { coreVersion: raw["coreVersion"] } : {}),
        ...(typeof raw["buildDate"] === "string" ? { buildDate: raw["buildDate"] } : {}),
    };
}

/** 未知 JSON 值 → 版本清单（schema + known 全量条目校验）。 */
function parseReleasesFile(raw: unknown): QqReleasesFile | null {
    if (!isRecord(raw) || typeof raw["schema"] !== "number" || !Array.isArray(raw["known"])) {
        return null;
    }
    const known: QqReleaseEntry[] = [];
    for (const item of raw["known"]) {
        const entry = parseReleaseEntry(item);
        if (entry === null) {
            return null;
        }
        known.push(entry);
    }
    return { schema: raw["schema"], known };
}

/** 读版本清单（同步，启动期调用一次即可）。 */
export function loadQqReleases(): QqReleasesFile {
    const file = join(packageRoot(), "releases.json");
    let raw: string;
    try {
        raw = readFileSync(file, "utf8");
    } catch {
        throw new QqReleasesError(`版本清单缺失: ${file}（@napuketto/loader 包安装不完整？）`);
    }
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch {
        throw new QqReleasesError(`版本清单解析失败: ${file}`);
    }
    const parsed = parseReleasesFile(parsedJson);
    if (parsed === null || parsed.schema !== QQ_RELEASES_SCHEMA || parsed.known.length === 0) {
        throw new QqReleasesError(`版本清单解析失败: ${file}`);
    }
    return parsed;
}

/** latestRelease 选项（缺省当前进程平台/架构）。 */
export interface LatestReleaseOptions {
    /** 平台（win32 / linux）；缺省 process.platform。 */
    platform?: string;
    /** 架构（x64 / arm64）；缺省 process.arch。 */
    arch?: string;
}

/**
 * 取该平台/架构最新已知可用版本（known 数组按录入顺序，取最后一项 = 最新）。
 *
 * 清单混装 Windows 与 Linux 条目后，不能简单取数组末项——否则 Windows 会选中
 * Linux deb、Linux 会选中 exe。按 platform/arch 过滤后再取末项。
 */
export function latestRelease(
    releases: QqReleasesFile,
    opts: LatestReleaseOptions = {},
): QqReleaseEntry {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const matching = releases.known.filter(
        (entry) => releasePlatform(entry) === platform && releaseArch(entry) === arch,
    );
    const [latest] = matching.slice(-1);
    if (latest === undefined) {
        throw new QqReleasesError(
            `版本清单无 ${platform}/${arch} 条目（共 ${releases.known.length} 条）`,
        );
    }
    return latest;
}

/**
 * 解析实际下载 URL：NAPUKETTO_QQ_URL 环境变量覆盖 > 清单 URL。
 * 供 downloadFile 使用（也支持按版本查询，当前固定取最新）。
 */
export function resolveDownloadUrl(release: QqReleaseEntry): string {
    const override = process.env["NAPUKETTO_QQ_URL"];
    return override !== undefined && override !== "" ? override : release.url;
}
