/**
 * Milky inbound 精华域：双路径发射——732:1 快路径（sysmsg 域 claim 后即时广播）
 * 与列表 diff（remove 路径 + operator 回填），essenceKeys 按 群:seq:方向 去重。
 */
import type { EssenceAddedItem } from "../../shared/essence.js";
import { EssenceListSync, narrowEssenceGroupArg } from "../../shared/essence.js";
import { sliceRaw } from "../../shared/log.js";
import { numericUin } from "../../shared/uid-uin.js";
import type { MilkyInboundBase } from "../api.js";
import { RecentKeyCache } from "../helper/state/recent-keys.js";
import type { GroupEssenceMessageChangeData } from "../types.js";

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
            fetchList: (groupCode) => deps.api.webApi.getEssenceMsgList(groupCode),
            onAdded: (groupCode, added) => this.broadcastAdded(groupCode, added),
            onRemoved: (groupCode, removed) => this.broadcastRemoved(groupCode, removed),
            onFetchError: (g, err) =>
                deps.logger?.warn(
                    { group: g, err: String(err) },
                    "milky: 精华列表拉取失败（diff 跳过）",
                ),
        });
    }

    /** sysmsg 732:1 快路径去重守卫：非精华恒 true；精华 claim 失败（diff 已抢发）→ false。 */
    claimFastPath(ruleKind: string, data: unknown): boolean {
        if (ruleKind !== "group_essence_message_change") {
            return true;
        }
        const rec = data as Partial<GroupEssenceMessageChangeData>;
        if (typeof rec.group_id !== "number" || typeof rec.message_seq !== "number") {
            return true; // 非预期载荷不参与去重（保守放行）
        }
        return this.claimChange(rec.group_id, rec.message_seq, true);
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
    private broadcastAdded(groupCode: string, added: readonly EssenceAddedItem[]): void {
        const now = Math.floor(Date.now() / 1000);
        for (const item of added) {
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

    private broadcastRemoved(groupCode: string, removed: readonly number[]): void {
        const now = Math.floor(Date.now() / 1000);
        for (const seq of removed) {
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
