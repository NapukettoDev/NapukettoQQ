/**
 * QR 登录流程辅助（从 `core.ts` 拆出）
 *
 * - 二维码 PNG 落盘 / 清理（0o700 目录 + 0o600 文件，拒绝符号链接）
 * - QR 进度事件转发（onQrCode / onStateChange → onLoginProgress）
 * - 终态等待与 selfInfo 提取
 *
 * 只依赖 infra / login 叶子模块，不反向依赖 core（core 消费本文件）。
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type pino from "pino";
import { kernelError } from "../infra/index.js";
import type { LoginState, QrCodeData, QrLoginSession, SelfInfo } from "./login.js";

/**
 * 登录进度（IPC 子进程模式经 onLoginProgress 转发；koishi 插件展示二维码/状态用）。
 *
 * 可辨识联合：`state` 是判别字段，`switch (progress.state)` 后 `qr` / `selfInfo` /
 * `message` 由编译器自然收窄（waiting_scan 必有 qr、logged_in 必有 selfInfo、
 * failed 必有 message）。属性名与旧版完全一致，下游 `progress.qr` 等访问路径不变。
 */
export type LoginProgress =
    | { state: "idle"; qr?: undefined; selfInfo?: undefined; message?: string | undefined }
    | {
          state: "waiting_scan";
          qr: QrCodeData;
          selfInfo?: undefined;
          message?: string | undefined;
      }
    | {
          state: "scanned";
          qr?: QrCodeData | undefined;
          selfInfo?: undefined;
          message?: string | undefined;
      }
    | { state: "logged_in"; qr?: undefined; selfInfo: SelfInfo; message?: string | undefined }
    | { state: "failed"; qr?: undefined; selfInfo?: undefined; message: string };

/** QR 进度转发上下文：日志实例 + 可选进度回调。 */
export interface QrProgressContext {
    logger: pino.Logger;
    onLoginProgress?: ((progress: LoginProgress) => void) | undefined;
}

/** 二维码 png 默认落盘目录（账号 cache 下的独占子目录）。 */
export const QR_CODE_DIR = "qr";
/** 二维码 png 默认文件名。 */
export const QR_CODE_FILENAME = "qrcode.png";

/** 订阅 QR 进度：二维码写盘 + 状态机经 onLoginProgress 转发。 */
export function subscribeQrProgress(
    ctx: QrProgressContext,
    session: QrLoginSession,
    qrPath: string,
): void {
    session.onQrCode((qr) => {
        // 日志只留图片路径：qrcodeUrl 是登录 URL（含票据），不得写入日志/事件。
        ctx.logger.warn(`请扫描二维码登录（图片: ${qrPath}）`);
        if (qr.pngBase64 !== "") {
            writeQrCodePng(qrPath, qr.pngBase64);
        }
        ctx.onLoginProgress?.({ state: "waiting_scan", qr });
    });
    session.onStateChange((state) => {
        forwardQrState(ctx, session, state);
    });
}

/** QR 状态转发：日志 + onLoginProgress（failed 附 failureReason）。 */
export function forwardQrState(
    ctx: QrProgressContext,
    session: QrLoginSession,
    state: LoginState,
): void {
    ctx.logger.info({ state }, "QR 登录状态");
    const progress = qrProgressEvent(state, session.selfInfo, session.failureReason);
    if (progress !== null) {
        ctx.onLoginProgress?.(progress);
    }
}

/**
 * 写二维码 png 到磁盘（base64 解码，供 cli/用户扫码）。
 *
 * 安全边界：目录按 0o700 创建、文件按 0o600 写入；写入前拒绝符号链接，避免被
 * 预置链接引到其他文件。失败不阻塞登录（cli 仍可打印 URL / 终端渲染）。
 */
export function writeQrCodePng(filePath: string, pngBase64: string): void {
    try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
        try {
            if (lstatSync(filePath).isSymbolicLink()) {
                return;
            }
        } catch {
            // 文件尚不存在：正常路径
        }
        writeFileSync(filePath, Buffer.from(pngBase64, "base64"), { mode: 0o600 });
        // 已存在的旧文件 mode 不会随 writeFileSync 改变，显式收紧权限。
        chmodSync(filePath, 0o600);
    } catch {
        // 写失败不阻塞登录（cli 仍可打印 URL）
    }
}

/** 删除默认落盘的二维码文件（不存在 / 权限失败静默）。 */
export function removeQrCodePng(filePath: string): void {
    try {
        unlinkSync(filePath);
    } catch {
        // 已清理 / 从未落盘
    }
}

/**
 * QR 进度事件折叠（可辨识联合，判别字段 = state）。
 *
 * 返回 null = 该状态不单独上报：
 *  - waiting_scan：二维码数据由 `subscribeQrProgress` 的 onQrCode 回执发出
 *    （那里才拿得到 qr），状态机这次先不带 qr 的事件不再重复发；
 *  - logged_in 且 selfInfo 仍为空：会话已损坏（调用方随后按 INVALID_STATE 拒绝），
 *    不构造自相矛盾的 logged_in 事件。
 */
export function qrProgressEvent(
    state: LoginState,
    selfInfo: SelfInfo | null,
    reason: string | null,
): LoginProgress | null {
    switch (state) {
        case "idle":
            return { state };
        case "waiting_scan":
            return null;
        case "scanned":
            return { state };
        case "logged_in":
            return selfInfo === null ? null : { state, selfInfo };
        case "failed":
            return { state, message: reason ?? "" };
    }
}

/** 等待 QR 登录终态：logged_in resolve，failed reject。 */
export function waitQrLoggedIn(session: QrLoginSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const offState = session.onStateChange((state) => {
            if (state === "logged_in") {
                offState();
                resolve();
            } else if (state === "failed") {
                offState();
                reject(kernelError("QR 登录失败", "NOT_LOGIN"));
            }
        });
    });
}

/** QR 登录终态后的 selfInfo 提取（空值按登录失败抛出）。 */
export function requireQrSelfInfo(session: QrLoginSession): SelfInfo {
    const self = session.selfInfo;
    if (self === null) {
        throw kernelError("QR 登录成功但 selfInfo 为空", "INVALID_STATE");
    }
    return self;
}
