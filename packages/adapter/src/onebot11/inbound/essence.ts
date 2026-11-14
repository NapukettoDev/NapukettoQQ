/**
 * OB11 inbound 精华域：列表 diff 是唯一发射路径（串行链复用 core 共享
 * EssenceListSync），sysmsg 732:1 作加速触发器；operator 仅 add 回填。
 */

import type { EssenceAddedItem } from "../../shared/essence.js";
import {
    EssenceListSync,
    extractEssenceSetSysMsg,
    narrowEssenceGroupArg,
} from "../../shared/essence.js";
import { truncRaw } from "../../shared/log.js";
import type { SysMsgField } from "../../shared/sysmsg.js";
import { MS_TO_SEC, numericUin } from "../../shared/uid-uin.js";
import type { Ob11Enrichment } from "../enrichment.js";
import type { Ob11EventPipelineDeps } from "../event-pipeline.js";

export type Ob11InboundEssenceDeps = Ob11EventPipelineDeps & { enrich: Ob11Enrichment };

/** OB11 精华域处理器（串行 diff 同步 + group_essence notice 广播）。 */
export class Ob11InboundEssence {
    private readonly deps: Ob11InboundEssenceDeps;
    private readonly essenceSync: EssenceListSync;

    constructor(deps: Ob11InboundEssenceDeps) {
        this.deps = deps;
        this.essenceSync = new EssenceListSync({
            fetchList: (groupCode) => deps.api.webApi.getEssenceMsgList(groupCode),
            onAdded: (groupCode, added) => this.broadcastDiff(groupCode, added, "add"),
            onRemoved: (groupCode, removed, prev) =>
                this.broadcastDiff(
                    groupCode,
                    removed.map((seq) => ({
                        messageSeq: seq,
                        senderUin: prev.get(seq)?.senderUin ?? null,
                        operatorUin: null,
                        addDigestTime: null,
                    })),
                    "delete",
                ),
            onFetchError: (g, err) =>
                deps.logger?.warn(
                    { group: g, err: String(err) },
                    "ob11: 精华列表拉取失败（diff 跳过）",
                ),
        });
    }

    /** sysmsg 732:1 加速触发器：抽取群号踢入串行链（抽取失败 → false 落校准路径）。 */
    triggerFromSysMsg(tree: readonly SysMsgField[]): boolean {
        const hit = extractEssenceSetSysMsg(tree);
        if (hit === null) {
            return false;
        }
        this.essenceSync.enqueue(String(hit.groupCode));
        return true;
    }

    /** 精华列表变更：拉全量列表 diff（唯一发射路径；参数收窄失败走校准日志）。 */
    change(arg: unknown): void {
        const groupCode = narrowEssenceGroupArg(arg);
        if (groupCode === null) {
            this.deps.logger?.warn(
                { raw: truncRaw(JSON.stringify(arg)) },
                "ob11: onGroupEssenceListChange 未知参数形状",
            );
            return;
        }
        this.essenceSync.enqueue(groupCode);
    }

    /** diff 逐条广播（add/delete 共用）：sender 必填 → message_id 反查 → notice 装配。 */
    private async broadcastDiff(
        groupCode: string,
        items: readonly EssenceAddedItem[],
        subType: "add" | "delete",
    ): Promise<void> {
        const { enrich, broadcast, selfUin } = this.deps;
        for (const item of items) {
            const senderId = numericUin(item.senderUin);
            if (senderId === null) {
                const detail = subType === "add" ? "新增 sender_uin 缺失" : "移除 sender 不可得";
                this.deps.logger?.warn(
                    { group: groupCode, seq: item.messageSeq },
                    `ob11: 精华${detail}（跳过事件）`,
                );
                continue;
            }
            const messageId = await enrich.resolveEssenceMsgId(groupCode, item.messageSeq);
            if (messageId === null) {
                continue; // resolveEssenceMsgId 内已校准日志
            }
            const operatorId = numericUin(item.operatorUin);
            broadcast({
                // addDigestTime 仅 add 有值；delete 恒 now（与原实现一致）
                time: item.addDigestTime ?? Math.floor(Date.now() / MS_TO_SEC),
                self_id: Number(selfUin),
                post_type: "notice",
                notice_type: "group_essence",
                sub_type: subType,
                group_id: Number(groupCode),
                sender_id: senderId,
                ...(operatorId !== null ? { operator_id: operatorId } : {}),
                message_id: messageId,
            });
        }
    }
}
