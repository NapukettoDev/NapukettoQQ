/**
 * Milky inbound 精华域：双路径发射——732:1 快路径（sysmsg 域 claim 后即时广播）
 * 与列表 diff（remove 路径 + operator 回填），essenceKeys 按 群:seq:方向 去重。
 */
import type { EssenceAddedItem, GroupEventChannel } from "@napuketto/kernel";
import { EssenceListSync, isRecord, narrowEssenceGroupArg } from "@napuketto/kernel";
import { numericUin } from "../../internal/domain/uid-uin.js";
import { sliceRaw } from "../../internal/infra/log.js";
import type { MilkyInboundBase } from "../api.js";
import { RecentKeyCache } from "../helper/state/recent-keys.js";

/** 精华域装配参数 = 管道依赖全集（api / broadcast / logger 按需取用）。 */
export type MilkyInboundEssenceDeps = MilkyInboundBase;

/** Milky 精华域处理器（双路径去重 + 串行 diff 同步 + group_essence 事件广播）。 */
export class MilkyInboundEssence {
    private readonly deps: MilkyInboundEssenceDeps;
    private readonly essenceKeys = new RecentKeyCache(5 * 60 * 1000);
    private readonly essenceSync: EssenceListSync;

    constructor(deps: MilkyInboundEssenceDeps) {
        this.deps = deps;
        this.essenceSync = new EssenceListSync({
            allowsGroup: (groupCode) =>
                deps.api.groupCache?.allowsGroupEvents?.(groupCode) !== false,
            fetchList: (groupCode) => deps.api.webApi.getEssenceMsgList(groupCode),
            onAdded: (groupCode, added, signal) => this.broadcastAdded(groupCode, added, signal),
            onRemoved: (groupCode, removed, _prev, signal) =>
                this.broadcastRemoved(groupCode, removed, signal),
            onMembershipChange: (allows) => {
                this.essenceKeys.deleteMatching((key) => !allows(key.split(":", 1)[0] ?? ""));
            },
            onNotifyError: (groupCode, err) =>
                deps.logger?.warn({ group: groupCode, err: String(err) }, "精华事件广播失败"),
            onQueueFull: (groupCode) =>
                deps.logger?.debug({ group: groupCode }, "精华同步队列已满，下次事件时重试"),
            onFetchError: (g, err) =>
                deps.logger?.warn(
                    { group: g, err: String(err) },
                    "milky: 精华列表拉取失败（diff 跳过）",
                ),
        });
    }

    start(channel?: GroupEventChannel): void {
        this.essenceSync.start(channel, this.deps.api.groupApi);
    }

    stop(): void {
        this.essenceSync.stop();
    }

    /** sysmsg 732:1 快路径去重守卫：非精华恒 true；精华 claim 失败（diff 已抢发）→ false。 */
    claimFastPath(ruleKind: string, data: unknown): boolean {
        if (ruleKind !== "group_essence_message_change") {
            return true;
        }
        if (!isRecord(data)) {
            return true; // 非预期载荷不参与去重（保守放行）
        }
        const groupId = data["group_id"];
        const seq = data["message_seq"];
        if (typeof groupId !== "number" || typeof seq !== "number") {
            return true; // 非预期载荷不参与去重（保守放行）
        }
        return this.essenceSync.accepts(String(groupId)) && this.claimChange(groupId, seq, true);
    }

    /** 精华列表变更：拉全量列表 diff（remove 路径 + operator 回填；串行防乱序）。 */
    change(arg: unknown): void {
        const groupCode = narrowEssenceGroupArg(arg);
        if (groupCode === null) {
            this.deps.logger?.warn(
                { raw: sliceRaw(JSON.stringify(arg)) },
                "milky: onGroupEssenceListChange 未知参数形状",
            );
            return;
        }
        this.essenceSync.enqueue(groupCode);
    }

    /** diff 广播：add（operator = add_digest_uin，快路径已发则跳过）→ remove（operator 省略）。 */
    private broadcastAdded(
        groupCode: string,
        added: readonly EssenceAddedItem[],
        signal?: AbortSignal,
    ): void {
        const now = Math.floor(Date.now() / 1000);
        for (const item of added) {
            if (signal?.aborted === true) {
                return;
            }
            if (this.claimChange(groupCode, item.messageSeq, true)) {
                this.broadcastChange(
                    groupCode,
                    item.messageSeq,
                    true,
                    numericUin(item.operatorUin),
                    now,
                );
            }
        }
    }

    private broadcastRemoved(
        groupCode: string,
        removed: readonly number[],
        signal?: AbortSignal,
    ): void {
        const now = Math.floor(Date.now() / 1000);
        for (const seq of removed) {
            if (signal?.aborted === true) {
                return;
            }
            if (this.claimChange(groupCode, seq, false)) {
                this.broadcastChange(groupCode, seq, false, null, now);
            }
        }
    }

    private broadcastChange(
        groupCode: string,
        seq: number,
        isSet: boolean,
        operatorId: number | null,
        time: number,
    ): void {
        this.deps.broadcast({
            time,
            self_id: Number(this.deps.api.self.uin),
            event_type: "group_essence_message_change",
            data: {
                group_id: Number(groupCode),
                message_seq: seq,
                is_set: isSet,
                ...(operatorId !== null ? { operator_id: operatorId } : {}),
            },
        });
    }

    /** 双路径 claim（键 群:seq:方向；true = 未广播过，可发）。 */
    private claimChange(groupCode: number | string, seq: number, isSet: boolean): boolean {
        return this.essenceKeys.claim(`${groupCode}:${seq}:${isSet ? 1 : 0}`);
    }
}
