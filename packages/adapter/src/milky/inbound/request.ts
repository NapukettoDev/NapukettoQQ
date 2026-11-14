/**
 * Milky inbound 请求域：群通知（入群请求 / 成员邀请 / 邀请自身，doubt 透传给
 * 翻译函数）与好友申请（防御收窄，未知形状 raw warn）。uid→uin 边界批量回填
 * （enrichment，fail-soft），翻译函数纯函数。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { narrowBuddyReqs } from "../../core/shared/buddy-req.js";
import { sliceRaw } from "../../core/shared/log.js";
import type { RequestTranslateContext } from "../../core/shared/uid-uin.js";
import type { MilkyEnrichment } from "../enrichment.js";
import {
    collectNotifyUids,
    toFriendRequestEvent,
    toGroupRequestEvent,
} from "../helper/event/request.js";
import type { MilkyInboundBase } from "./base.js";

/** 请求域装配参数 = 管道依赖全集 + enrich（enrichment 共享实例）。 */
export type MilkyInboundRequestDeps = MilkyInboundBase & { enrich: MilkyEnrichment };

/** Milky 请求域处理器（群通知 / 好友申请的 uid 回填与广播）。 */
export class MilkyInboundRequest {
    private readonly deps: MilkyInboundRequestDeps;

    constructor(deps: MilkyInboundRequestDeps) {
        this.deps = deps;
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
        void this.broadcastBuddyReqs(arg);
    }

    private async broadcastBuddyReqs(arg: unknown): Promise<void> {
        const reqs = narrowBuddyReqs(arg);
        if (reqs === null) {
            this.deps.logger?.warn(
                { raw: sliceRaw(JSON.stringify(arg)) },
                "milky: onBuddyReqChange 未知参数形状",
            );
            return;
        }
        const ctx = await this.requestCtx(reqs.map((req) => req.friendUid));
        for (const req of reqs) {
            this.deps.broadcast(toFriendRequestEvent(req, ctx));
        }
    }

    /** request 翻译上下文（uid→uin 批量转换；失败退空 Map）。 */
    private async requestCtx(uids: string[]): Promise<RequestTranslateContext> {
        const uidToUin = await this.deps.enrich.resolveUidToUin(uids);
        return {
            selfUin: this.deps.api.self.uin,
            ...(uidToUin !== undefined ? { uidToUin } : { uidToUin: new Map() }),
        };
    }
}
