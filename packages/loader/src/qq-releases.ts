/**
 * qq-releases.ts：版本清单读取（P1）。
 *
 * 运行时从包根 qq-releases.json 读取（发布时 files 含它，安装后位于
 * node_modules/@napuketto/loader/qq-releases.json）。
 *
 * 维护机制（真实存在，非「声称」）：清单由 CI 自动维护——
 * .github/workflows/update-qq-releases.yml（每日 cron + 手动触发）调用
 * scripts/qq-releases/update-qq-releases.ts（纯 Node，与本地共用），抓取 QQ 官方下载配置
 * 解析最新版 + 下载安装包计算 sha256 + 解析安装包内部版本目录后更新本清单
 * （保留历史条目、known 按版本递增）。社区 PR 仍可手动补充。NAPUTO_QQ_URL
 * 可运行时覆盖下载地址（用户拿到新链接时用）。
 *
 * ⚠️ 下载 URL 必须经 normalizeDownloadUrl 归一化后再请求（2026-10-07 定位）：
 * 腾讯 CDN 边缘 WAF 对字面量 `/QQNTV2/` 路径段区分大小写地拦截，官方
 * rainbow 配置给出的 URL 直接请求必得 403。详见该函数注释。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 清单中单个版本条目。 */
export interface QqReleaseEntry {
    /** 版本目录名（如 9.9.33-51802）。 */
    version: string;
    /** 官方安装包下载 URL。 */
    url: string;
    /** sha256（十六进制小写）；空串 = 尚未校验（首次录入时 CI 计算后填入）。 */
    sha256: string;
    /** appid（预知信息，运行时仍从 major.node 解析；0 = 尚未解析/待运行时补）。 */
    appid: number;
    /** 来源标记（official = 官方）。 */
    source: string;
    /** 构建日期（YYYY-MM-DD，可选）。 */
    buildDate?: string;
}

/** 清单文件结构。 */
export interface QqReleasesFile {
    schema: number;
    known: QqReleaseEntry[];
}

/** 清单解析失败。 */
export class QqReleasesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QqReleasesError";
    }
}

/** 包根路径（dist 与包根同层：dist/index.mjs → ../qq-releases.json）。 */
function packageRoot(): string {
    return dirname(dirname(fileURLToPath(import.meta.url)));
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
        if (parsed.schema !== 1 || !Array.isArray(parsed.known) || parsed.known.length === 0) {
            throw new Error("结构不合法");
        }
        return parsed as QqReleasesFile;
    } catch {
        throw new QqReleasesError(`版本清单解析失败: ${file}`);
    }
}

/** 取最新已知可用版本（known 数组按录入顺序，取最后一项 = 最新）。 */
export function latestRelease(releases: QqReleasesFile): QqReleaseEntry {
    const [latest] = [...releases.known].reverse();
    if (latest === undefined) {
        throw new QqReleasesError("版本清单为空");
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

/**
 * 被 CDN 边缘 WAF 大小写敏感拦截的路径段（全局匹配，仅用于 String.replace——
 * replace 会复位 lastIndex，无跨调用状态残留）。语义见 normalizeDownloadUrl。
 */
const QQNTV2_SEGMENT_RE = /\/QQNTV2\//gi;

/**
 * 归一化 QQ 官方安装包下载 URL：把 `/QQNTV2/` 路径段降为小写。
 *
 * **为什么需要**（2026-10-07 实测定位，issue #6 的真正根因）：
 * 腾讯 CDN 边缘 WAF 约 2026-08-25 起加了一条 **区分大小写** 的规则，匹配
 * 字面量 `/QQNTV2/` 路径段。命中即由边缘直接拒绝，**不回源**：
 *
 * ```text
 * HTTP/1.1 403 Forbidden
 * Content-Length: 0
 * Server: Lego Server
 * X-Cache-Lookup: Return Directly
 * ```
 *
 * 而 qqdl.gtimg.cn 的缓存/源站对路径大小写 **不敏感**：同一 URL 仅把路径段
 * 写成 `/qqntv2/`（以及 `/Qqntv2/`）即正常返回（实测 x64 安装包
 * `HTTP/1.1 200 OK` + `Content-Length: 330446512`，Range 请求返回 `206` 且首字节
 * 为 PE 头 `MZ`）。同一出口 IP、同一时刻的两次请求只有路径大小写不同 → 403 的
 * 成因是 **路径匹配规则**，不是「数据中心 IP 被封」。
 *
 * 归一化只改请求用的 URL，**清单里仍保留官方原样 URL**（可追溯、来源即官方
 * 配置字段 `ntDownloadX64Url`）；若腾讯哪天修掉这条规则，小写路径依旧等价可用
 * （源站大小写不敏感），因此不必回改清单。
 */
export function normalizeDownloadUrl(url: string): string {
    return url.replace(QQNTV2_SEGMENT_RE, "/qqntv2/");
}
