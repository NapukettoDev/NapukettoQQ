/**
 * 语音消息辅助（从 `apis/msg.ts` 拆出）
 *
 * fetch_ptt_text（转文字）与 get_record（主动下载 + 轮询落盘）。发送方向的
 * PTT 元素装配在 media-prep.ts；本文件只处理接收/下载方向。
 */
import { kernelError, sleep } from "../../infra/index.js";
import type {
    NodeIKernelMsgService,
    Peer,
    PttElement,
    RawElement,
    RawMessage,
} from "../../types/index.js";
import { unwrapResult } from "../result.js";
import { fetchMsgsByMsgId } from "./queries.js";

/** downloadRichMedia 契约值（2026-09-08 B1 实测：downloadType=2 可用 / thumbSize=0）。 */
const DOWNLOAD_TYPE_COMMON = 2;
const THUMB_SIZE_NONE = 0;
/** 语音下载轮询参数（300ms × 34 ≈ 10s；返回 void 只能经重拉元素观察完成）。 */
const PTT_POLL_INTERVAL_MS = 300;
const PTT_POLL_TIMES = 34;

/** 语音下载完成判定：有路径且（传输完成或末次轮询）才返回元素，否则 null。 */
function pttDownloadResult(
    latest: PttElement | null | undefined,
    isLastPoll: boolean,
): PttElement | null {
    // Linux 原生对象未命中的变体字段显式 null（不是省略成 undefined）
    if (latest == null) {
        return null;
    }
    const hasPath = latest.filePath != null && latest.filePath !== "";
    const done = latest.transferStatus === 2 || latest.transferStatus === 4;
    return hasPath && (done || isLastPoll) ? latest : null;
}

/**
 * 在消息列表中找含 pttElement 的元素（找不到返回 null）。
 *
 * ⚠️ `!= null` 而非 `!== undefined`（Linux 原生宿主）：Windows 省略未命中的
 * 变体字段，Linux 3.2.x 把所有变体字段显式置 null。用 `!== undefined` 会让
 * 首个元素（哪怕是文本消息）被误判成语音元素，进而把 null 传给原生下载接口。
 */
function findPttElement(msgs: RawMessage[]): RawElement | null {
    const [first] = msgs;
    if (first === undefined) {
        return null;
    }
    return first.elements.find((el) => el.pttElement != null) ?? null;
}

/** 取消息内语音元素（无则 null；附 elemId 供主动下载）。 */
async function pttElementOf(
    service: NodeIKernelMsgService,
    msgId: string,
    target: Peer,
): Promise<{ elemId: string; ptt: PttElement } | null> {
    const msgs = await fetchMsgsByMsgId(service, target, [msgId]);
    const el = findPttElement(msgs);
    const ptt = el?.pttElement;
    // Linux 原生对象未命中的变体字段显式 null（不只是 undefined）
    if (el === null || ptt == null) {
        return null;
    }
    return { elemId: el.elementId ?? "", ptt };
}

/**
 * 语音转文字（fetch_ptt_text）。
 * 流程：按 msgId 拉消息 → 找 PTT 元素 → translatePtt2Text（异步转写）
 * → 再拉一次消息读 pttElement.text。
 */
export async function fetchPttText(
    service: NodeIKernelMsgService,
    msgId: string,
    target: Peer,
): Promise<string> {
    const msgs = await fetchMsgsByMsgId(service, target, [msgId]);
    const ptt = findPttElement(msgs);
    if (ptt === null) {
        throw kernelError("消息中不包含语音", "NOT_FOUND");
    }
    const raw = await service.translatePtt2Text(msgId, target, ptt);
    unwrapResult("translatePtt2Text", raw);
    // 转写异步完成：再拉一次拿 text
    const after = await fetchMsgsByMsgId(service, target, [msgId]);
    const text = findPttElement(after)?.pttElement?.text;
    // Linux 原生对象未命中的字段显式 null（不只是 undefined）
    if (text == null || text === "") {
        throw kernelError("获取语音转文字结果失败", "UNKNOWN");
    }
    return text;
}

/**
 * 语音主动下载（get_record 本地未命中兜底，2026-09-08 B1）。
 * downloadRichMedia 返回 void（实测），完成信号 = 重拉消息元素：
 * 轮询（300ms × 34，约 10s）直到 filePath 非空且 transferStatus 进入
 * 已下载态（2/4）；超时但 filePath 已有值则尽力返回（磁盘命中判断留给
 * 调用方），完全无路径抛 NOT_FOUND。
 */
export async function downloadPtt(
    service: NodeIKernelMsgService,
    msgId: string,
    target: Peer,
): Promise<PttElement> {
    const found = await pttElementOf(service, msgId, target);
    if (found === null) {
        throw kernelError("消息中不包含语音", "NOT_FOUND");
    }
    await service.downloadRichMedia({
        msgId,
        elemId: found.elemId,
        chatType: target.chatType,
        downloadType: DOWNLOAD_TYPE_COMMON,
        thumbSize: THUMB_SIZE_NONE,
    });
    for (let i = 0; i < PTT_POLL_TIMES; i++) {
        await sleep(PTT_POLL_INTERVAL_MS);
        const again = await fetchMsgsByMsgId(service, target, [msgId]);
        const result = pttDownloadResult(
            findPttElement(again)?.pttElement,
            i === PTT_POLL_TIMES - 1,
        );
        if (result !== null) {
            return result;
        }
    }
    throw kernelError("语音下载未完成（超时）", "TIMEOUT");
}
