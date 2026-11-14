/**
 * pic-path-grace：入站图片落盘宽限等待（2026-11-14，issue #105 防御层第二件）
 *
 * 背景：原生补丁（私有 native/）放行收图自动下载后，入站事件仍先于下载完成——
 * picElement.sourcePath/picPath 指向的文件在事件到达那一刻通常还不存在
 * （worker 异步落盘，实测 < 1s）。下游消费者（AstrBot 一类）拿到事件即 stat，
 * 不等待 = 仍然 FileNotFoundError。
 *
 * 职责：MsgBridge 发射 Msg/onRecvMsg、Msg/onMsgInfoListUpdate 前，对本批消息里
 * 全部 pic 本地路径候选做有界并行等待（任一存在即放行；超时原样放行，由
 * canonical 层的存在性防御兜底置空）。快速路径（无 pic / 路径已存在）零等待。
 *
 * 语义边界：
 *  - 只等待，不改消息（置空裁决在 toCanonicalElements，单一收口）；
 *  - 跨回调的到达序不保证（宽限等待让出事件循环，文本消息可能先于等待中的
 *    图片消息发射）——QQ 原生回调本就无顺序契约，协议层按 seq 排序不受影响。
 */

import { existsSync } from "node:fs";
import type { RawMessage } from "../types/index.js";
import { picLocalCandidates } from "../types/message-element.js";

/** 默认宽限上限（毫秒）：覆盖典型原图下载时长，坏路径最多拖慢发射 2s。 */
const DEFAULT_TIMEOUT_MS = 2000;
/** 轮询间隔（毫秒）。 */
const DEFAULT_INTERVAL_MS = 250;

/** 收集一批消息中所有 pic 本地路径候选（去重）。 */
function collectCandidates(msgs: RawMessage[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const msg of msgs) {
        for (const element of msg.elements ?? []) {
            for (const candidate of picLocalCandidates(element.picElement)) {
                if (!seen.has(candidate)) {
                    seen.add(candidate);
                    out.push(candidate);
                }
            }
        }
    }
    return out;
}

export interface PicGraceOptions {
    /** 等待上限（毫秒），超时放行由 canonical 层置空兜底。 */
    timeoutMs?: number;
    /** 轮询间隔（毫秒）。 */
    intervalMs?: number;
}

/**
 * 是否存在「候选路径全缺失」的 pic（= 需要宽限等待）。
 * 供桥层做同步快速路径判定：无 pic / 路径已在 → 不进异步等待。
 */
export function hasPendingPicPaths(msgs: RawMessage[]): boolean {
    const candidates = collectCandidates(msgs);
    return candidates.length > 0 && !candidates.some((path) => existsSync(path));
}

/**
 * 等待本批消息的 pic 本地路径落盘（并行、有界）。
 * 无候选或已有候选存在 → 立即返回（快速路径零开销）。
 */
export async function awaitPicLocalPaths(
    msgs: RawMessage[],
    options: PicGraceOptions = {},
): Promise<void> {
    if (!hasPendingPicPaths(msgs)) {
        return;
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    while (true) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        if (!hasPendingPicPaths(msgs)) {
            return;
        }
        if (Date.now() >= deadline) {
            return;
        }
    }
}
