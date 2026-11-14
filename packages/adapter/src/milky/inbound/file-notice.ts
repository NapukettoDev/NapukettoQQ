/**
 * Milky inbound 轻量通知域：私聊文件双回调（friend_file_upload，按 msgId 去重）
 * 与 bot_offline（Login 桥，载荷零样本，reason 固定值）。置顶翻转在 pin.ts。
 */
import { sliceRaw } from "../../shared/log.js";
import { forEachRawMessage, toUnixSeconds } from "../../shared/raw-message.js";
import type { MilkyInboundBase } from "../api.js";
import { toFriendFileUploadData } from "../helper/event/file-upload.js";
import { RecentKeyCache } from "../helper/state/recent-keys.js";
import type { BotOfflineData } from "../types.js";

/** 轻量通知域装配参数 = 管道依赖全集（api / broadcast / logger 按需取用）。 */
export type MilkyInboundFileNoticeDeps = MilkyInboundBase;

/** Milky 轻量通知域处理器（私聊文件 / bot_offline）。 */
export class MilkyInboundFileNotice {
    private readonly deps: MilkyInboundFileNoticeDeps;
    /** friend_file_upload 双回调去重（同载荷，按 msgId）。 */
    private readonly fileKeys = new RecentKeyCache(10 * 60 * 1000);

    constructor(deps: MilkyInboundFileNoticeDeps) {
        this.deps = deps;
    }

    /** 私聊文件消息 → friend_file_upload（双回调同载荷，按 msgId 去重）。 */
    fileMessages(msgs: unknown): void {
        forEachRawMessage(msgs, (msg) => {
            // senderUin 缺失时的 uid 反查需异步批量，此处从简（录制实证 senderUin
            // 恒有值；缺失场景 user_id=0 + 校准日志）
            const data = toFriendFileUploadData(msg, this.deps.api.self.uin, new Map());
            if (data === null) {
                return;
            }
            if (data.user_id === 0) {
                this.deps.logger?.debug(
                    { msgId: msg.msgId, senderUid: msg.senderUid },
                    "milky: friend_file_upload senderUin 缺失（user_id=0）",
                );
            }
            if (!this.fileKeys.claim(`file:${msg.msgId}`)) {
                return;
            }
            this.deps.broadcast({
                time: toUnixSeconds(msg.msgTime),
                self_id: Number(this.deps.api.self.uin),
                event_type: "friend_file_upload",
                data,
            });
        });
    }

    /** bot_offline：Login 桥回调（载荷零样本，reason 固定值 + raw 校准日志待野捕）。 */
    botOffline(reason: string, args: unknown[]): void {
        this.deps.logger?.debug(
            { reason, raw: sliceRaw(JSON.stringify(args)) },
            "milky: bot_offline（reason 为固定值，回调载荷待野捕校准）",
        );
        this.deps.broadcast({
            time: Math.floor(Date.now() / 1000),
            self_id: Number(this.deps.api.self.uin),
            event_type: "bot_offline",
            data: { reason } satisfies BotOfflineData,
        });
    }
}
