/**
 * media-patch-status：stub 补丁状态读取与引导日志（契约：stub 后台线程写 NAPUKETTO_MEDIA_PATCH_STATUS 指向的状态 JSON）。
 * 组件 B（代码补丁）定案先写 pending，组件 A（实例扫描）命中或窗口关闭后写终态；bootstrap 后读一次，pending/缺失 45s 复读一次。
 * 日志仅为观测面：补丁降级不阻塞宿主，协议层路径防御（kernel）兜底保证下游拿不到不存在的本地路径。
 */

import { existsSync, readFileSync } from "node:fs";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage, isRecord } from "../../shared/type-guards.js";
import { env } from "../runtime/env.js";

/** stub 状态 JSON（宽容解析：字段缺省容忍，版本字段不校验）。 */
export interface MediaPatchStatus {
    v?: number;
    state?: string;
    componentA?: string;
    componentB?: string;
    cleared?: number;
    reason?: string;
    tick?: number;
}

/** 复读延迟（毫秒）：覆盖典型登录后实例出现的窗口，不做无限轮询。 */
const RECHECK_DELAY_MS = 45_000;

/** 状态文件行分隔（只取首行：stub 可能追加诊断行）。 */
const FIRST_LINE_RE = /\r?\n/;

/** 读取状态文件（缺失 / 坏 JSON / 非对象 → undefined）。 */
export function readMediaPatchStatus(path?: string): MediaPatchStatus | undefined {
    const target = path ?? env.NAPUKETTO_MEDIA_PATCH_STATUS;
    if (target === undefined || target === "" || !existsSync(target)) {
        return undefined;
    }
    try {
        const raw = readFileSync(target, "utf8").trim();
        if (raw === "") {
            return undefined;
        }
        const firstLine = raw.split(FIRST_LINE_RE)[0] ?? "";
        const parsed: unknown = JSON.parse(firstLine);
        if (!isRecord(parsed)) {
            return undefined;
        }
        return {
            ...(typeof parsed["v"] === "number" ? { v: parsed["v"] } : {}),
            ...(typeof parsed["state"] === "string" ? { state: parsed["state"] } : {}),
            ...(typeof parsed["componentA"] === "string"
                ? { componentA: parsed["componentA"] }
                : {}),
            ...(typeof parsed["componentB"] === "string"
                ? { componentB: parsed["componentB"] }
                : {}),
            ...(typeof parsed["cleared"] === "number" ? { cleared: parsed["cleared"] } : {}),
            ...(typeof parsed["reason"] === "string" ? { reason: parsed["reason"] } : {}),
            ...(typeof parsed["tick"] === "number" ? { tick: parsed["tick"] } : {}),
        };
    } catch (e) {
        log(`[media-patch] 状态文件解析失败（忽略）: ${getErrorMessage(e)}`);
        return undefined;
    }
}

/** 终态判定：pending / 缺失需要复读。 */
function isPending(status: MediaPatchStatus | undefined): boolean {
    return status === undefined || status.state === undefined || status.state === "pending";
}

/** 组装一条可读日志（结构化字段平铺进文案，loader 引导日志为纯文本行）。 */
function describe(status: MediaPatchStatus | undefined): string {
    if (status === undefined) {
        return "[media-patch] 未捕获到补丁状态（stub 无状态输出或状态路径未注入）";
    }
    const parts = [
        `state=${status.state ?? "?"}`,
        `componentA=${status.componentA ?? "?"}`,
        `componentB=${status.componentB ?? "?"}`,
        `cleared=${status.cleared ?? 0}`,
    ];
    if (status.reason !== undefined) {
        parts.push(`reason=${status.reason}`);
    }
    return `[media-patch] 入站图片自动下载补丁: ${parts.join(" ")}`;
}

/**
 * bootstrap 完成后调用（fire-and-forget）：读一次状态记日志；pending/缺失时
 * 45s 后复读一次。仅观测，不阻塞、不抛错。
 */
export function reportMediaPatchStatus(): void {
    let first = readMediaPatchStatus();
    log(describe(first));
    if (!isPending(first)) {
        return;
    }
    setTimeout(() => {
        first = readMediaPatchStatus();
        if (isPending(first)) {
            log(
                "[media-patch] 补丁仍在实例窗口内重试（组件 A 最长 15 分钟；终态以 " +
                    "media-patch-status.json 为准）",
            );
            return;
        }
        log(describe(first));
    }, RECHECK_DELAY_MS).unref();
}
