/**
 * qq-download.ts：QQ 官方安装包下载器（P1）。
 *
 * 无第三方依赖：Node 内置 https + crypto（sha256）。设计文档 §2.2。
 *  - https GET 流式写文件（低内存占用，313MB 安装包不整载入内存）
 *  - 下载同时流式累加 sha256，完成后与清单比对（防链接漂移劫持 / 下载不完整）
 *  - 支持 302 重定向（QQ CDN 可能跳转）
 *  - NAPUTO_QQ_URL 环境变量可覆盖下载地址（用户拿到新链接时用）
 *  - 出站 URL 统一经 normalizeDownloadUrl 归一化（绕过 CDN 边缘对 `/QQNTV2/`
 *    路径段的大小写敏感拦截，见 qq-releases.ts；否则清单里的官方 URL 必 403）
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get, type RequestOptions } from "node:https";
import { dirname } from "node:path";
import process from "node:process";
import { loaderVersion } from "./package-info.js";
import { normalizeDownloadUrl } from "./qq-releases.js";

/** 下载请求 User-Agent（运行时读本包版本，失败兜底 0.0.0）。 */
const USER_AGENT = `napuketto-loader/${loaderVersion()}`;

/** 下载选项。 */
export interface DownloadOptions {
    /** 目标文件绝对路径。 */
    dest: string;
    /** 期望 sha256（十六进制小写）；缺省/空串 = 不校验（首次下载尚无参考值）。 */
    expectedSha256?: string;
    /** 覆盖下载地址（缺省读 NAPUTO_QQ_URL）。 */
    url?: string;
    /** 超时（毫秒，默认 60s 无数据则中断）。 */
    timeoutMs?: number;
}

/** 下载结果。 */
export interface DownloadResult {
    /** 实际 sha256（十六进制小写）。 */
    sha256: string;
    /** 是否通过期望值校验（无期望值时恒 true）。 */
    verified: boolean;
}

/** 下载中断（超时 / 非 2xx / 网络错误）抛出的错误。 */
export class DownloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DownloadError";
    }
}

/** 发起一次 https GET，返回响应（跟随重定向，最多 5 跳）。 */
function httpsGet(url: string, timeoutMs: number): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const request = (currentUrl: string, redirects: number): void => {
            const opts: RequestOptions = {
                headers: { "user-agent": USER_AGENT },
            };
            const req = get(currentUrl, opts, (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers["location"] !== undefined) {
                    res.resume(); // 释放连接
                    if (redirects >= 5) {
                        reject(new DownloadError(`重定向次数过多: ${currentUrl}`));
                        return;
                    }
                    request(new URL(res.headers["location"], currentUrl).toString(), redirects + 1);
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    reject(new DownloadError(`HTTP ${status}: ${currentUrl}`));
                    return;
                }
                resolve(res);
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new DownloadError(`下载超时(${timeoutMs}ms): ${currentUrl}`));
            });
            req.on("error", (err) => {
                reject(err instanceof Error ? err : new DownloadError(String(err)));
            });
        };
        request(url, 0);
    });
}

/**
 * 下载文件并（可选）校验 sha256。失败时清理半成品文件。
 * 返回实际 sha256（无论是否校验），便于调用方回填清单。
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
    const requested = options.url ?? process.env["NAPUTO_QQ_URL"];
    if (requested === undefined || requested === "") {
        throw new DownloadError("下载地址为空：请设置 NAPUTO_QQ_URL 或提供清单 URL");
    }
    // 唯一出站口，统一归一化（清单 URL / NAPUTO_QQ_URL / 未来调用方全覆盖）
    const url = normalizeDownloadUrl(requested);
    const timeoutMs = options.timeoutMs ?? 60_000;
    // 目标目录必须提前建好（createWriteStream 不自动建目录）
    mkdirSync(dirname(options.dest), { recursive: true });
    const hash = createHash("sha256");
    const fileStream = createWriteStream(options.dest);
    let fileFailed = false;

    try {
        const res = await httpsGet(url, timeoutMs);
        await new Promise<void>((resolve, reject) => {
            res.on("data", (chunk: Buffer) => {
                hash.update(chunk);
            });
            res.on("error", (err: Error) => {
                fileFailed = true;
                reject(err instanceof Error ? err : new DownloadError(String(err)));
            });
            fileStream.on("error", (err) => {
                fileFailed = true;
                reject(err);
            });
            fileStream.on("finish", () => {
                resolve();
            });
            res.pipe(fileStream);
        });
    } catch (err) {
        fileStream.destroy();
        if (!fileFailed) {
            await rm(options.dest, { force: true });
        }
        throw err instanceof Error ? err : new DownloadError(String(err));
    }

    // ⚠️ 完成态校验（2026-08-23 WSL 生产事故）：Promise 正常 resolve 但文件
    // 缺失/为空是真实发生过的（koishi 场景 7z 解包报「No such file or
    // directory」，疑为并发实例清理 tmp 或写入中断）。resolve 不代表落盘完整，
    // 这里 stat 兜底，缺失/空文件立即报错而不是把坏文件交给下游解包。
    let size: number;
    try {
        size = statSync(options.dest).size;
    } catch {
        throw new DownloadError(`下载完成但文件缺失: ${options.dest}`);
    }
    if (size <= 0) {
        await rm(options.dest, { force: true });
        throw new DownloadError(`下载完成但文件为空: ${options.dest}`);
    }

    const sha256 = hash.digest("hex");
    const expected = options.expectedSha256;
    const verified =
        expected === undefined || expected === ""
            ? true
            : sha256.toLowerCase() === expected.toLowerCase();
    if (!verified) {
        await rm(options.dest, { force: true });
        throw new DownloadError(
            `sha256 校验失败: ${options.dest}\n期望 ${expected}\n实际 ${sha256}`,
        );
    }
    return { sha256, verified };
}
