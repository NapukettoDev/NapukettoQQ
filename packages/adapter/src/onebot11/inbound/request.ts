/**
 * OB11 inbound 请求域（2026-11-14 自 event-pipeline.ts 拆出）
 *
 * 群系统通知 → group request（type 1/5=invite、7=add，只推未处理 KUNHANDLE，
 * doubt 可疑通知跳过）；好友申请 → friend request（flag=reqTime）。uid→uin 在
 * 边界批量回填（enrichment，fail-soft 空 Map），翻译函数纯函数。通知载荷按
 * kernel GroupNotify 类型消费（原 unknown + 属性断言已消除）。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { narrowBuddyReqs } from "../../core/shared/buddy-req.js";
import { truncRaw } from "../../core/shared/log.js";
import type { RequestTranslateContext } from "../../core/shared/uid-uin.js";
import type { Ob11Enrichment } from "../enrichment.js";
import type { Ob11EventPipelineDeps } from "../event-pipeline.js";
import { toOb11FriendRequestEvent, toOb11GroupRequestEvent } from "../helper/request.js";

/** 请求域处理装配参数（event-pipeline 注入；enrich 为共享实例）。 */
export type Ob11InboundRequestDeps = Ob11EventPipelineDeps & { enrich: Ob11Enrichment };

/** OB11 请求域处理器（群通知 / 好友申请的 uid 回填与广播）。 */
export class Ob11InboundRequest {
    private readonly deps: Ob11InboundRequestDeps;

    constructor(deps: Ob11InboundRequestDeps) {
        this.deps = deps;
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
        void this.broadcastBuddyReqs(arg);
    }

    /** 好友申请翻译派发（flag=reqTime；uid→uin 批量失败退空 Map）。 */
    private async broadcastBuddyReqs(arg: unknown): Promise<void> {
        const reqs = narrowBuddyReqs(arg);
        if (reqs === null) {
            // 未知形状：raw 日志积累校准数据（T10 实测后回填 narrowBuddyReqs）
            this.deps.logger?.warn(
                { raw: truncRaw(JSON.stringify(arg)) },
                "ob11: onBuddyReqChange 未知参数形状",
            );
            return;
        }
        const ctx = await this.requestCtx(reqs.map((r) => r.friendUid).filter((uid) => uid !== ""));
        for (const req of reqs) {
            this.deps.broadcast(toOb11FriendRequestEvent(req, ctx));
        }
    }

    /** request 翻译上下文（uid→uin 批量；失败退空 Map 不阻塞上报）。 */
    private async requestCtx(uids: string[]): Promise<RequestTranslateContext> {
        return { selfUin: this.deps.selfUin, uidToUin: await this.deps.enrich.uidToUinMap(uids) };
    }
}

/** 收集群系统通知涉及的 uid（user1/user2 双方，空 uid 跳过）。 */
function collectGroupNotifyUids(notifies: readonly GroupNotify[]): string[] {
    const uids: string[] = [];
    for (const notify of notifies) {
        for (const user of [notify.user1, notify.user2]) {
            if (typeof user?.uid === "string" && user.uid !== "") {
                uids.push(user.uid);
            }
        }
    }
    return uids;
}
