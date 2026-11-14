/**
 * OB11 notice 事件翻译·扩展源（c3）
 *
 * 数据源 = kernel 桥 新接线回调（notice.ts 的 grayTip 路径之外）：
 *  - Msg/onRecvOfflineFileMsg → OB11 offline_file notice（翻译）
 *  - Msg/onRecvSysMsg / Msg/onRecvOnlineFileMsg / Group/onGroupEssenceListChange
 *    → 暂不翻译（adapter 侧 raw 校准日志；sys msg 为群名片/头衔/精华等系统
 *    事件的总载体，真实 payload 到达后回填翻译）
 *
 * ⚠️ payload 形状未经真实事件校准（方法名证据 = wrapper.node 字符串，见 kernel
 * listeners 注释）——防御性收窄：未知形状返回 null，调用方打 raw 日志积累校准
 * 数据（与 narrowBuddyReqs 同模式）。翻译纯函数。
 */

import { MS_TO_SEC } from "../../shared/uid-uin.js";
import type { OB11OfflineFileNoticeEvent } from "../event/index.js";

/** 离线文件归一化项（收窄产物；字段名待真实事件校准）。 */
export interface OfflineFileLike {
    /** 发送者 uin（数字字符串；未知为 "0"）。 */
    senderUin: string;
    name: string;
    size: number;
    /** 下载地址（未知为空串——OB11 offline_file 的 file.url 待校准数据源）。 */
    url: string;
}

/** 候选 uin 字段（按优先级取第一个数字串；uid 串不硬转——待校准）。 */
function pickUin(item: Record<string, unknown>): string {
    for (const key of ["senderUin", "fromUin", "peerUin"]) {
        const v = item[key];
        if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) {
            return v;
        }
    }
    return "0";
}

/** 候选 url 字段（fileUrl / url；未知为空串）。 */
function pickUrl(item: Record<string, unknown>): string {
    for (const key of ["fileUrl", "url"]) {
        const v = item[key];
        if (typeof v === "string" && v !== "") {
            return v;
        }
    }
    return "";
}

/** 单个候选对象 → 归一化项（不可识别返回 null）。接受两类形状：
 *  ① RawMessage 型（elements[].fileElement——离线文件以消息推送到达的假设，
 *     与 onRecvOfflineFileMsg 挂在 MsgService、UpdateC2CFileMsg 字符串一致）
 *  ② 专用实体型（顶层 fileName 或 fileInfo.fileName——getNewOfflineFileList 族） */
function narrowItem(item: unknown): OfflineFileLike | null {
    if (typeof item !== "object" || item === null) {
        return null;
    }
    const obj = item as Record<string, unknown>;
    // ① RawMessage 型：fileElement 落在 elements 数组
    if (Array.isArray(obj["elements"])) {
        const el = obj["elements"].find(
            (e) => typeof e === "object" && e !== null && "fileElement" in e,
        ) as { fileElement?: Record<string, unknown> } | undefined;
        const file = el?.fileElement;
        if (file == null) {
            return null;
        }
        return {
            senderUin: pickUin(obj),
            name: typeof file["fileName"] === "string" ? file["fileName"] : "",
            size: Number(file["fileSize"] ?? 0),
            url: pickUrl(file),
        };
    }
    // ② 专用实体型：顶层或 fileInfo 下的 fileName
    const file = (obj["fileInfo"] as Record<string, unknown> | undefined) ?? obj;
    if (typeof file["fileName"] !== "string") {
        return null;
    }
    return {
        senderUin: pickUin(obj),
        name: file["fileName"],
        size: Number(file["fileSize"] ?? 0),
        url: pickUrl(file),
    };
}

/**
 * onRecvOfflineFileMsg 参数 → 归一化项列表（防御性收窄）。
 * 接受数组 / 单对象；全部不可识别返回 null（调用方打 raw 日志）。
 * 空数组同样返回 null（无文件可翻译，与未知形状同走日志路径无害）。
 */
export function narrowOfflineFiles(arg: unknown): OfflineFileLike[] | null {
    const items = Array.isArray(arg) ? arg : [arg];
    const narrowed = items.map(narrowItem).filter((v): v is OfflineFileLike => v !== null);
    return narrowed.length > 0 ? narrowed : null;
}

/** 归一化项 → OB11 offline_file notice（time 取当前时刻，friend_add 同款）。 */
export function toOfflineFileNotice(
    item: OfflineFileLike,
    selfUin: string,
): OB11OfflineFileNoticeEvent {
    return {
        time: Math.floor(Date.now() / MS_TO_SEC),
        self_id: Number(selfUin),
        post_type: "notice",
        notice_type: "offline_file",
        user_id: Number(item.senderUin),
        file: { name: item.name, size: item.size, url: item.url },
    };
}
