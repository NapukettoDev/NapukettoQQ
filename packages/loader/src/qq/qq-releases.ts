/**
 * qq-releases.ts：版本清单读取与查询（P1）。
 *
 * 运行时从包根 qq-releases.json 读取（发布时 files 含它，安装后位于
 * node_modules/@napuketto/loader/qq-releases.json）。
 *
 * 维护机制（真实存在，非「声称」）：清单由 CI 自动维护——
 * .github/workflows/update-qq-releases.yml（每日 cron + 手动触发）调用
 * tooling/qq-releases/update-qq-releases.ts（纯 Node，与本地共用），抓取 QQ 官方下载配置
 * 解析最新版 + 下载安装包计算 sha256 + 解析安装包内部版本目录后更新本清单
 * （保留历史条目、known 按版本递增）。社区 PR 仍可手动补充。NAPUTO_QQ_URL
 * 可运行时覆盖下载地址（用户拿到新链接时用）。
 *
 * 形状 / 常量 / 纯函数在 `qq-release-manifest.ts`：那个文件必须保持零内部依赖，
 * 因为更新脚本由 `node` 直接执行（类型剥离不重写 `.js` → `.ts` 说明符）。
 * 本文件只做「读文件 + 查询」，下载 URL 归一化（`normalizeDownloadUrl`）从那边再导出。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { packageRoot } from "../internal/package-root.js";
import type { QqReleaseEntry, QqReleasesFile } from "./qq-release-manifest.js";
import { QQ_RELEASES_SCHEMA, releaseArch, releasePlatform } from "./qq-release-manifest.js";

export type {
    QqReleaseArch,
    QqReleaseEntry,
    QqReleasePlatform,
    QqReleasesFile,
} from "./qq-release-manifest.js";
export {
    normalizeDownloadUrl,
    QQ_RELEASES_SCHEMA,
    releaseArch,
    releasePlatform,
} from "./qq-release-manifest.js";

/** 清单解析失败。 */
export class QqReleasesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QqReleasesError";
    }
}

/** 读版本清单（同步，启动期调用一次即可）。 */
export function loadQqReleases(): QqReleasesFile {
    const file = join(packageRoot(), "qq-releases.json");
    let raw: string;
    try {
        raw = readFileSync(file, "utf8");
    } catch {
        throw new QqReleasesError(`版本清单缺失: ${file}（@napuketto/loader 包安装不完整？）`);
    }
    try {
        const parsed = JSON.parse(raw) as Partial<QqReleasesFile>;
        if (
            parsed.schema !== QQ_RELEASES_SCHEMA ||
            !Array.isArray(parsed.known) ||
            parsed.known.length === 0
        ) {
            throw new Error("结构不合法");
        }
        return parsed as QqReleasesFile;
    } catch {
        throw new QqReleasesError(`版本清单解析失败: ${file}`);
    }
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
 * 解析实际下载 URL：NAPUTO_QQ_URL 环境变量覆盖 > 清单 URL。
 * 供 downloadFile 使用（也支持按版本查询，当前固定取最新）。
 */
export function resolveDownloadUrl(release: QqReleaseEntry): string {
    const override = process.env["NAPUTO_QQ_URL"];
    return override !== undefined && override !== "" ? override : release.url;
}
