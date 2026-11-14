/**
 * OB11 inbound 轻量通知域（2026-11-14 自 event-pipeline.ts 拆出）
 *
 * 离线文件（c3）→ offline_file notice；在线文件无对应 OB11 通知类型 → raw
 * debug 校准日志；好友列表变化（Buddy/onBuddyListChange*，T10 实证 =
 * BuddyCategory[] 全量快照）→ raw info 校准日志；好友缓存 diff 新增（B2）→
 * friend_add notice（diff/baseline 在 kernel BuddyCache，翻译纯函数）。
 */
import type { BuddyListEntry } from "@napuketto/kernel";
import { sliceRaw, truncRaw } from "../../core/shared/log.js";
import type { Ob11EventPipelineDeps } from "../event-pipeline.js";
import { toFriendAdd } from "../helper/notice.js";
import { narrowOfflineFiles, toOfflineFileNotice } from "../helper/notice-extra.js";

/** 轻量通知域处理装配参数（event-pipeline 注入）。 */
export type Ob11InboundFileNoticeDeps = Ob11EventPipelineDeps;

/** OB11 轻量通知域处理器（文件 / 好友新增等无独立翻译链的通知）。 */
export class Ob11InboundFileNotice {
    private readonly deps: Ob11InboundFileNoticeDeps;

    constructor(deps: Ob11InboundFileNoticeDeps) {
        this.deps = deps;
    }

    /**
     * 离线文件（c3，2026-09-10）：Msg/onRecvOfflineFileMsg → OB11 offline_file
     * notice（payload 形状待校准：防御性收窄，未知形状 raw 日志积累）。
     */
    offlineFile(arg: unknown): void {
        const items = narrowOfflineFiles(arg);
        if (items === null) {
            this.deps.logger?.warn(
                { raw: truncRaw(JSON.stringify(arg)) },
                "ob11: onRecvOfflineFileMsg 未知参数形状",
            );
            return;
        }
        for (const item of items) {
            this.deps.broadcast(toOfflineFileNotice(item, this.deps.selfUin));
        }
    }

    /** 在线文件：OB11 无对应通知类型；debug 级 raw 校准日志（2026-10-25）。 */
    onlineFile(arg: unknown): void {
        this.deps.logger?.debug(
            { raw: sliceRaw(JSON.stringify(arg)) },
            "ob11: onRecvOnlineFileMsg raw（校准数据）",
        );
    }

    /** 好友列表变化：快照字段较多，raw 日志保留积累校准数据（翻译走 friendAdd）。 */
    buddyList(evt: "Buddy/onBuddyListChange" | "Buddy/onBuddyListChangedV2", arg: unknown): void {
        this.deps.logger?.info(
            { raw: truncRaw(JSON.stringify(arg)) },
            `ob11: ${evt} raw（friend_add 校准数据）`,
        );
    }

    /** 好友缓存 diff 新增（B2，2026-09-08）→ friend_add notice（翻译纯函数）。 */
    friendAdd(entry: BuddyListEntry): void {
        this.deps.broadcast(toFriendAdd(entry, this.deps.selfUin));
    }
}
