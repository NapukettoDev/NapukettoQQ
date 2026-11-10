/**
 * friend_file_upload 翻译（Milky 批次三，2026-11-01 录制定型）
 *
 * 源：Msg/onRecvOfflineFileMsg 与 Msg/onFileMsgCome（同载荷 RawMessage 数组，
 * 双回调按 msgId 在适配器去重）；fileElement{fileName, fileSize 字符串,
 * file10MMd5, fileUuid, ...}，sendType 0=收到（sender=对端）/ 2=自己发出。
 *
 * 已知差异（milky.md §0.8.6）：官方 file_hash 语义为 TriSHA1，接收侧
 * fileSha/fileSha3 实测为空——取 file10MMd5（md5）充值，上传侧校准后回填。
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { resolveUin } from "../../../core/shared/uid-uin.js";
import type { FriendFileUploadData } from "../../types.js";

/** 单条 C2C 文件消息 → 事件载荷（非 C2C / 无 fileElement / 无 fileUuid → null）。 */
export function toFriendFileUploadData(
    msg: RawMessage,
    selfUin: string,
    uidToUin: ReadonlyMap<string, string>,
): FriendFileUploadData | null {
    if (msg.chatType !== ChatType.C2C) {
        return null;
    }
    const file = msg.elements.find((el) => el.fileElement != null)?.fileElement;
    if (file === undefined || typeof file.fileUuid !== "string" || file.fileUuid === "") {
        return null;
    }
    // is_self 双判据：sendType（录制实证 0=收到 2=自己发出）+ 发送者兜底
    const isSelf = msg.sendType === 2 || String(msg.senderUin) === selfUin;
    const userUin =
        msg.senderUin !== "" ? Number(msg.senderUin) : resolveUin(msg.senderUid, uidToUin);
    const size = Number(file.fileSize ?? 0);
    return {
        user_id: Number.isFinite(userUin) ? userUin : 0,
        file_id: file.fileUuid,
        file_name: file.fileName ?? "",
        file_size: Number.isFinite(size) ? size : 0,
        file_hash: file.file10MMd5 ?? file.fileSha ?? "",
        is_self: isSelf,
    };
}
