/**
 * OB11 inbound 请求域（自 event-pipeline.ts 拆出）
 *
 * 群系统通知 → group request（type 1/5=invite、7=add，只推未处理 KUNHANDLE，
 * doubt 可疑通知跳过）；好友申请 → friend request（flag=reqTime）。uid→uin 在
 * 边界批量回填（enrichment，fail-soft 空 Map），翻译函数纯函数。通知载荷按
 * kernel GroupNotify 类型消费（原 unknown + 属性断言已消除）。
 *
 * 好友申请额外过两道闸（issue #122）：启动前历史积压 / 已读 / 已处理 / 自己发起
 * 的项直接丢弃，剩余项按 `${friendUid}:${reqTime}` 去重——否则「全量重放 →
 * 自动同意 → 再次全量重放」会成死循环。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { BuddyReqDedup, processInboundBuddyReqs } from "../../shared/buddy-req.js";
import { logEventFailure, truncRaw } from "../../shared/log.js";
import { startupBaselineSec } from "../../shared/startup-cutoff.js";
import { collectGroupNotifyUids, type RequestTranslateContext } from "../../shared/uid-uin.js";
import type { Ob11EventPipelineDeps } from "../api/onebot-api.js";
import type { Ob11Enrichment } from "../enrichment.js";
import { toOb11FriendRequestEvent, toOb11GroupRequestEvent } from "../helper/request.js";

/** 请求域处理装配参数（event-pipeline 注入；enrich 为共享实例）。 */
export type Ob11InboundRequestDeps = Ob11EventPipelineDeps & { enrich: Ob11Enrichment };

/** OB11 请求域处理器（群通知 / 好友申请的 uid 回填与广播）。 */
export class Ob11InboundRequest {
    private readonly deps: Ob11InboundRequestDeps;
    /** 已广播申请的 `${friendUid}:${reqTime}`（实例级，跨 reloadTransports 保留）。 */
    private readonly dedup = new BuddyReqDedup();
    /** 历史积压基准（订阅时刷新：重连后以此刻为界）。 */
    private baselineSec = startupBaselineSec();

    constructor(deps: Ob11InboundRequestDeps) {
        this.deps = deps;
    }

    /** 刷新启动基准（pipeline subscribe 时调用）。 */
    markStartup(): void {
        this.baselineSec = startupBaselineSec();
    }

    /** 群系统通知 → group request 事件（批量 uidToUin 后翻译，纯函数）。 */
    async groupNotifies(doubt: boolean, notifies: readonly GroupNotify[]): Promise<void> {
        // doubt = 可疑通知整批跳过；载荷形状兜底（防御非数组）
        if (doubt || !Array.isArray(notifies)) {
            return;
        }
        const ctx = await this.requestCtx(collectGroupNotifyUids(notifies));
        for (const notify of notifies) {
            const event = toOb11GroupRequestEvent(notify, ctx);
            if (event !== null) {
                this.deps.broadcast(event);
            }
        }
    }

    /** 好友申请 → friend request 事件（防御收窄；未知形状 raw warn 校准）。 */
    buddyReqs(arg: unknown): void {
        // 回填/翻译失败只丢本批事件，不打断收链路
        this.broadcastBuddyReqs(arg).catch((err: unknown) =>
            logEventFailure(this.deps.logger, "ob11: friend request 翻译失败（整批丢弃）", err),
        );
    }

    /** 好友申请翻译派发（flag=reqTime；uid→uin 批量失败退空 Map）。 */
    private async broadcastBuddyReqs(arg: unknown): Promise<void> {
        // 四步守门：unreadNums=0 短路 → 收窄 → 可处理性过滤 → 去重（共享管线）
        const fresh = processInboundBuddyReqs(arg, {
            baselineSec: this.baselineSec,
            dedup: this.dedup,
            scope: "ob11",
            formatRaw: truncRaw,
            logger: this.deps.logger,
        });
        if (fresh.length === 0) {
            return;
        }
        const ctx = await this.requestCtx(
            fresh.map((r) => r.friendUid).filter((uid) => uid !== ""),
        );
        for (const req of fresh) {
            this.deps.broadcast(toOb11FriendRequestEvent(req, ctx));
        }
    }

    /** request 翻译上下文（uid→uin 批量；失败退空 Map 不阻塞上报）。 */
    private async requestCtx(uids: string[]): Promise<RequestTranslateContext> {
        return { selfUin: this.deps.selfUin, uidToUin: await this.deps.enrich.uidToUinMap(uids) };
    }
}
