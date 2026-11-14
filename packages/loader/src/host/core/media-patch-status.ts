/**
 * media-patch-status：stub 补丁状态读取与引导日志（2026-11-14，issue #105 P2.1）
 *
 * 契约：私有 native/ stub 后台线程把补丁结果写入 NAPUTO_MEDIA_PATCH_STATUS
 * （launcher 注入，指向 <账号数据目录>/media-patch-status.json）：
 *   {"v":1,"state":"applied|degraded|disabled_by_env","componentA":"…",
 *    "componentB":"…","cleared":n,"reason":"…","tick":ms}
 * 组件 B（代码补丁）定案即先写 state=pending，组件 A（实例扫描）命中或窗口
 * 关闭后写终态——本模块在 bootstrap 完成后读一次并记日志；pending/缺失时
 * 45s 后复读一次（实例窗口最长 15 分钟，不无限等待）。
 *
 * 日志仅为观测面：补丁降级不阻塞宿主，协议层路径防御（kernel）兜底保证
 * 下游拿不到不存在的本地路径。
 */

import { existsSync, readFileSync } from "node:fs";

import { env } from "../env.js";
import { errMsg, log } from "../util.js";

/** stub 状态 JSON（宽容解析：字段缺省容忍，版本字段不校验）。 */
export interface MediaPatchStatus {
    state?: string;
    componentA?: string;
    componentB?: string;
    cleared?: number;
    reason?: string;
}

/** 复读延迟（毫秒）：覆盖典型登录后实例出现的窗口，不做无限轮询。 */
const RECHECK_DELAY_MS = 45_000;

/** 读取状态文件（缺失 / 坏 JSON / 非对象 → undefined）。 */
export function readMediaPatchStatus(path?: string): MediaPatchStatus | undefined {
    const target = path ?? env.NAPUTO_MEDIA_PATCH_STATUS;
    if (target === undefined || target === "" || !existsSync(target)) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed as MediaPatchStatus;
        }
        return undefined;
    } catch (e) {
        log(`[media-patch] 状态文件解析失败（忽略）: ${errMsg(e)}`);
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
