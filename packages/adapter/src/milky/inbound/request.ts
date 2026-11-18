/**
 * Milky inbound 请求域：群通知（入群请求 / 成员邀请 / 邀请自身，doubt 透传给
 * 翻译函数）与好友申请（防御收窄，未知形状 raw warn）。uid→uin 边界批量回填
 * （enrichment，fail-soft），翻译函数纯函数。
 *
 * 好友申请额外过两道闸（issue #122，与 OB11 同源）：启动前历史积压 / 已读 /
 * 已处理 / 自己发起的项丢弃，剩余项按 `${friendUid}:${reqTime}` 去重。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { logEventFailure, sliceRaw } from "../../internal/infra/log.js";
import { BuddyReqDedup, processInboundBuddyReqs } from "../../internal/qq/buddy-req.js";
import { startupBaselineSec } from "../../internal/qq/startup-cutoff.js";
import type { RequestTranslateContext } from "../../internal/qq/uid-uin.js";
import type { MilkyInboundBase } from "../api.js";
import type { MilkyEnrichment } from "../enrichment.js";
import {
    collectNotifyUids,
    toFriendRequestEvent,
    toGroupRequestEvent,
} from "../helper/event/request.js";

/** 请求域装配参数 = 管道依赖全集 + enrich（enrichment 共享实例）。 */
export type MilkyInboundRequestDeps = MilkyInboundBase & { enrich: MilkyEnrichment };

/** Milky 请求域处理器（群通知 / 好友申请的 uid 回填与广播）。 */
export class MilkyInboundRequest {
    private readonly deps: MilkyInboundRequestDeps;
    /** 已广播申请的 `${friendUid}:${reqTime}`（实例级，跨 reloadTransports 保留）。 */
    private readonly dedup = new BuddyReqDedup();
    /** 历史积压基准（订阅时刷新：重连后以此刻为界）。 */
    private baselineSec = startupBaselineSec();

    constructor(deps: MilkyInboundRequestDeps) {
        this.deps = deps;
    }

    /** 刷新启动基准（pipeline subscribe 时调用）。 */
    markStartup(): void {
        this.baselineSec = startupBaselineSec();
    }

    /** 群通知通道：入群请求 / 成员邀请 / 邀请自身（uid→uin 批量后翻译）。 */
    async groupNotifies(doubt: boolean, notifies: GroupNotify[]): Promise<void> {
        const ctx = await this.requestCtx(collectNotifyUids(notifies));
        for (const notify of notifies) {
            const event = toGroupRequestEvent(notify, doubt, ctx);
            if (event !== null) {
                this.deps.broadcast(event);
            }
        }
    }

    /** 好友请求通道：Buddy/onBuddyReqChange（防御收窄，未知形状 raw 日志）。 */
    buddyReqs(arg: unknown): void {
        // 回填/翻译失败只丢本批事件，不打断收链路
        this.broadcastBuddyReqs(arg).catch((err: unknown) =>
            logEventFailure(this.deps.logger, "milky: friend request 翻译失败（整批丢弃）", err),
        );
    }

    private async broadcastBuddyReqs(arg: unknown): Promise<void> {
        // 四步守门：unreadNums=0 短路 → 收窄 → 可处理性过滤 → 去重（共享管线）
        const fresh = processInboundBuddyReqs(arg, {
            baselineSec: this.baselineSec,
            dedup: this.dedup,
            scope: "milky",
            formatRaw: sliceRaw,
            logger: this.deps.logger,
        });
        if (fresh.length === 0) {
            return;
        }
        const ctx = await this.requestCtx(fresh.map((req) => req.friendUid));
        for (const req of fresh) {
            this.deps.broadcast(toFriendRequestEvent(req, ctx));
        }
    }

    /** request 翻译上下文（uid→uin 批量转换 + 资料兜底；失败退空 Map）。 */
    private async requestCtx(uids: string[]): Promise<RequestTranslateContext> {
        const uidToUin = await this.deps.enrich.resolveUidToUin(uids, { profileFallback: true });
        return {
            selfUin: this.deps.api.self.uin,
            ...(uidToUin !== undefined ? { uidToUin } : { uidToUin: new Map() }),
        };
    }
}
