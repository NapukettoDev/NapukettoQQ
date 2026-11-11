/**
 * qq-release-manifest.ts：版本清单的形状、常量与纯函数（**零内部依赖**）。
 *
 * 为什么单独拆出来：`tooling/qq-releases/update-qq-releases.ts` 由 `node` 直接执行
 * （CI 定时任务与本地兜底共用，无构建、无 tsconfig），而 Node 的类型剥离不会把
 * `./x.js` 说明符改写成 `./x.ts`。本文件一旦出现任何**相对 import**，那条命令就会
 * `ERR_MODULE_NOT_FOUND`（源码分组重构后真实踩过一次，vitest 会重写说明符所以单测
 * 全绿）。因此这里只放类型、常量、纯函数与 node 内置类型，不碰文件系统、不引本包模块；
 * 守卫见 `tooling/qq-releases/update-qq-releases.import.test.ts`。
 *
 * 清单读取（fs + 包根）与查询在 qq-releases.ts。
 */

/** 清单条目平台（Linux 原生走 deb；旧条目缺省 win32，兼容 schema 1 遗留写法）。 */
export type QqReleasePlatform = "win32" | "linux";

/** 清单条目架构（当前 Windows 只有 x64，Linux 有 amd64/arm64）。 */
export type QqReleaseArch = "x64" | "arm64";

/** 清单中单个版本条目。 */
export interface QqReleaseEntry {
    /** 版本目录名 / 客户端版本（Windows 9.9.33-51802；Linux 3.2.35-54395）。 */
    version: string;
    /** 官方安装包下载 URL（Windows NSIS exe / Linux deb）。 */
    url: string;
    /** sha256（十六进制小写）；空串 = 尚未校验（首次录入时 CI 计算后填入）。 */
    sha256: string;
    /** appid（预知信息，运行时仍从 major.node 解析；0 = 尚未解析/待运行时补）。 */
    appid: number;
    /** 来源标记（official = 官方）。 */
    source: string;
    /** 平台；缺省 win32（旧条目无此字段）。 */
    platform?: QqReleasePlatform;
    /** 架构；缺省 x64。 */
    arch?: QqReleaseArch;
    /** QQNT 核心版本（Linux 3.2.35 对应 9.9.37）；缺省 = version。 */
    coreVersion?: string;
    /** 构建日期（YYYY-MM-DD，可选）。 */
    buildDate?: string;
}

/** 当前清单 schema 版本（2 = 增加 platform/arch/coreVersion）。 */
export const QQ_RELEASES_SCHEMA = 2;

/** 清单文件结构。 */
export interface QqReleasesFile {
    schema: number;
    known: QqReleaseEntry[];
}

/** 条目平台（缺省 win32，兼容旧清单条目）。 */
export function releasePlatform(entry: QqReleaseEntry): QqReleasePlatform {
    return entry.platform ?? "win32";
}

/** 条目架构（缺省 x64）。 */
export function releaseArch(entry: QqReleaseEntry): QqReleaseArch {
    return entry.arch ?? "x64";
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
