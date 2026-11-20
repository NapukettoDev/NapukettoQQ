/**
 * downloader.ts：HTTP(S) 媒体下载（2026-09-08 T5）
 *
 * 协议层（adapter get_image 主动下载 / koishi 插件发送侧下沉）共用的
 * 下载原语：fetch + 超时 + 大小上限 + 流式落盘，写目标路径（调用方管理目录与清理）。
 * 零额外依赖（Node 18+ 内建 fetch）。
 *
 * 安全边界（2026-11 加固）：
 * - 仅允许 http/https（fetch 本身不支持 file:，显式拒绝给出可读错误）；
 * - 手动跟随 30x（上限 5 跳），**每一跳重新做 URL 校验**，避免「首跳合法、跳转内网」；
 * - 字面 IP 目标拒绝链路本地（含云元数据 169.254.169.254）、未指定、多播与保留段；
 *   环回与 RFC1918 私有段放行——自建 LAN 媒体服务与本机渲染服务是受支持的部署形态；
 * - 流式落盘（临时文件 + 原子替换），内存占用不随文件大小增长；
 * - 超时覆盖整个下载（含跳转与读 body），大小上限同时校验 Content-Length 与实际字节数。
 *
 * 已知边界：不解析域名（DNS rebinding 不在本层防护内）；域名解析到内网的场景由部署侧
 * 网络策略兜底。需要更严格策略时应在协议配置层增加开关，而不是把解析逻辑塞进本原语。
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MediaError } from "./types.js";

/** 下载选项。 */
export interface DownloadUrlOptions {
    /** 超时毫秒（缺省 15s，覆盖整个下载过程）。 */
    timeoutMs?: number | undefined;
    /** 大小上限字节（缺省 30MB）。 */
    maxBytes?: number | undefined;
    /** 附加请求头（如 OneBot11 download_file 的 headers 透传）。 */
    headers?: Record<string, string> | undefined;
}

/** 默认大小上限（30MB）。 */
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

/** 默认超时（15s）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 最大跳转次数（每跳都重新校验目标 URL）。 */
const MAX_REDIRECTS = 5;

/** 视为重定向的状态码。 */
const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** 允许的下载协议（fetch 仅支持这两个，其余显式拒绝）。 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** 扩展名字符合法性（URL pathname 提取校验）。 */
const EXT_RE = /^\.[a-z0-9]+$/i;

/** WHATWG URL 归一化后的 IPv4-mapped IPv6（::ffff:h:h，低 32 位为 IPv4）。 */
const IPV4_MAPPED_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * 拒绝的 IPv4 段（[网络地址, 前缀长度]）。
 * 环回（127.0.0.0/8）与 RFC1918 私有段刻意放行，见文件头说明。
 */
const BLOCKED_IPV4: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8], // 0.0.0.0/8 未指定 / 本网络
    [0x64400000, 10], // 100.64.0.0/10 运营商级 NAT
    [0xa9fe0000, 16], // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    [0xc0000000, 24], // 192.0.0.0/24 IETF 协议分配
    [0xc0000200, 24], // 192.0.2.0/24 文档示例
    [0xc6120000, 15], // 198.18.0.0/15 基准测试
    [0xc6336400, 24], // 198.51.100.0/24 文档示例
    [0xcb007100, 24], // 203.0.113.0/24 文档示例
    [0xe0000000, 4], // 224.0.0.0/4 多播
    [0xf0000000, 4], // 240.0.0.0/4 保留
    [0xffffffff, 32], // 255.255.255.255 广播
];

/** IPv4 点分十进制 → uint32（调用方已用 isIP 确认形态）。 */
function ipv4ToInt(ip: string): number {
    const [a = 0, b = 0, c = 0, d = 0] = ip.split(".").map((part) => Number(part));
    return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0) >>> 0;
}

/** 字面 IPv4 是否落在拒绝段。 */
function isBlockedIpv4(value: number): boolean {
    return BLOCKED_IPV4.some(([network, prefix]) => {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        return (value & mask) >>> 0 === (network & mask) >>> 0;
    });
}

/** URL 已归一化的字面 IPv6 是否落在拒绝段（环回 ::1 放行）。 */
function isBlockedIpv6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === "::") {
        return true; // 未指定
    }
    if (lower === "::1") {
        return false; // 环回放行
    }
    // 点分尾部、展开形式与大小写均已由 URL 归一化，提取低 32 位复用 IPv4 策略。
    const mapped = IPV4_MAPPED_RE.exec(lower);
    if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
        const value =
            ((Number.parseInt(mapped[1], 16) << 16) | Number.parseInt(mapped[2], 16)) >>> 0;
        return isBlockedIpv4(value);
    }
    const firstGroup = lower.split(":")[0] ?? "";
    if (firstGroup === "") {
        return false; // 以 :: 开头但不是 ::/::1：压缩形式，首组为 0，非链路本地/多播
    }
    const value = Number.parseInt(firstGroup, 16);
    if (Number.isNaN(value)) {
        return true; // 解析失败 fail-closed
    }
    // fe80::/10 链路本地；ff00::/8 多播
    return (value >= 0xfe80 && value <= 0xfebf) || value >= 0xff00;
}

/**
 * 出站下载 URL 校验：协议白名单 + 字面 IP 段。
 *
 * 只拦字面地址（不解析域名）：域名解析结果与 fetch 实际连接存在竞态，本层不承担
 * DNS rebinding 防护。校验失败抛 MediaError（不含目标地址细节之外的信息）。
 */
export function assertDownloadUrlSafe(raw: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new MediaError("无效的下载 URL");
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new MediaError(`不支持的下载协议：${parsed.protocol}（仅允许 http/https）`);
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const kind = isIP(host);
    if (kind === 4 && isBlockedIpv4(ipv4ToInt(host))) {
        throw new MediaError(`禁止访问的下载地址：${host}`);
    }
    if (kind === 6 && isBlockedIpv6(host)) {
        throw new MediaError(`禁止访问的下载地址：${host}`);
    }
    return parsed;
}

/** 是否重定向响应。 */
function isRedirect(status: number): boolean {
    return REDIRECT_STATUS.has(status);
}

/**
 * 发起请求并手动跟随重定向：每一跳都先过 assertDownloadUrlSafe。
 * 返回非 30x 的最终响应。
 */
async function requestFollowingRedirects(
    url: string,
    headers: Record<string, string> | undefined,
    signal: AbortSignal,
): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const parsed = assertDownloadUrlSafe(current);
        const response = await fetch(parsed.href, {
            ...(headers === undefined ? {} : { headers }),
            redirect: "manual",
            signal,
        });
        if (!isRedirect(response.status)) {
            return response;
        }
        const location = response.headers.get("location");
        // 释放跳转响应 body（未消费的 body 会占住连接）
        await response.body?.cancel().catch(() => undefined);
        if (location === null || location === "") {
            throw new MediaError(`重定向缺少 Location（HTTP ${response.status}）`);
        }
        current = new URL(location, parsed).href;
    }
    throw new MediaError(`重定向次数超过上限（${MAX_REDIRECTS}）`);
}

/** 流式写盘并累计字节数；超过上限时中断并清理。 */
async function writeCapped(
    body: ReadableStream<Uint8Array>,
    temp: string,
    maxBytes: number,
): Promise<number> {
    let total = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
            total += chunk.byteLength;
            if (total > maxBytes) {
                callback(new MediaError(`文件超过大小上限（>${maxBytes} 字节）`));
                return;
            }
            callback(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(body), counter, createWriteStream(temp));
    return total;
}

/** 下载失败的统一错误类型（保留超时语义，其余包成 MediaError）。 */
function toMediaError(err: unknown, timeoutMs: number): MediaError {
    if (err instanceof MediaError) {
        return err;
    }
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        return new MediaError(`下载超时（${timeoutMs}ms）`, { cause: err });
    }
    return new MediaError(err instanceof Error ? err.message : "下载失败", { cause: err });
}

/**
 * 下载 URL 到目标路径（覆盖写）。返回写入字节数。
 * 失败抛 MediaError（非 2xx / 协议或地址被拒 / 超限 / 超时 / 空 body / IO 错误），
 * 失败不留半成品（临时文件已清理）。
 */
export async function downloadUrl(
    url: string,
    dest: string,
    options: DownloadUrlOptions = {},
): Promise<number> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 下载未完成不影响进程自然退出
    timer.unref?.();
    const temp = `${dest}.part-${process.pid}-${randomUUID()}`;
    try {
        const response = await requestFollowingRedirects(url, options.headers, controller.signal);
        if (!response.ok) {
            throw new MediaError(`HTTP ${response.status}`);
        }
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > maxBytes) {
            throw new MediaError(`文件超过大小上限（${declared} > ${maxBytes} 字节）`);
        }
        const body = response.body;
        if (body === null) {
            throw new MediaError("响应无 body");
        }
        await mkdir(dirname(dest), { recursive: true });
        const written = await writeCapped(body, temp, maxBytes);
        if (written === 0) {
            throw new MediaError("下载内容为空");
        }
        await rename(temp, dest);
        return written;
    } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw toMediaError(err, timeoutMs);
    } finally {
        clearTimeout(timer);
    }
}

/** 从 Content-Type / URL 路径推断扩展名（缺省 .bin；下载命名用）。 */
export function inferExtension(contentType: string | null, url: string): string {
    if (contentType !== null) {
        const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
        const sub = base.split("/")[1]?.split("+")[0];
        if (base.startsWith("image/") || base.startsWith("audio/") || base.startsWith("video/")) {
            if (sub !== undefined && sub !== "") {
                return `.${sub}`;
            }
        }
    }
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.substring(pathname.lastIndexOf("."));
        if (ext.length > 1 && ext.length <= 6 && EXT_RE.test(ext)) {
            return ext.toLowerCase();
        }
    } catch {
        // URL 解析失败（理论不可达，fetch 已成功）：落 .bin
    }
    return ".bin";
}
