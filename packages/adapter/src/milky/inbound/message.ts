/**
 * Milky inbound 消息域：Msg/onRecvMsg 单条消息——seq 双向登记（含自消息，发送
 * 回查用）与转发 resId 登记 → grayTip（notice / message_recall）→ 群文件上传
 * 事件 → 自消息过滤 → message_receive 组装（回填走 MilkyEnrichment）。
 */
import type { RawMessage } from "@napuketto/kernel";
import { toCanonicalElements } from "@napuketto/kernel";
import { collectGrayTipUids, findRevokeElement, hasGrayTip } from "../../shared/gray-tip.js";
import type { MilkyInboundBase } from "../api.js";
import type { MilkyEnrichment } from "../enrichment.js";
import { toMilkyNoticeEvent } from "../helper/event/notice.js";
import {
    type ReceiveTranslateContext,
    toGroupFileUploadEvent,
    toMessageRecallEvent,
    toMessageReceiveEvent,
} from "../helper/event/translate.js";
import { incomingForwardSegment } from "../helper/message/segments.js";

/** 消息域装配参数 = 管道依赖全集 + enrich（enrichment 共享实例）。 */
export type MilkyInboundMessageDeps = MilkyInboundBase & { enrich: MilkyEnrichment };

/** Milky 消息域处理器（Msg/onRecvMsg 分流与翻译派发）。 */
export class MilkyInboundMessage {
    private readonly deps: MilkyInboundMessageDeps;

    constructor(deps: MilkyInboundMessageDeps) {
        this.deps = deps;
    }

    /** 单条消息：seq 登记 → grayTip→notice / 群文件上传 / message_receive（自消息不上报）。 */
    async handle(msg: RawMessage): Promise<void> {
        this.deps.seqIndex.record(msg);
        this.recordForward(msg);
        if (hasGrayTip(msg)) {
            await this.broadcastNotice(msg);
            return;
        }
        const upload = toGroupFileUploadEvent(msg, this.deps.api.self.uin);
        if (upload !== null) {
            this.deps.broadcast(upload);
            return;
        }
        if (String(msg.senderUin) === this.deps.api.self.uin) {
            return;
        }
        this.deps.broadcast(await this.buildMessageReceiveEvent(msg));
    }

    /** grayTip → notice 事件广播（REVOKE 走 message_recall，其余走 notice 翻译）。 */
    private async broadcastNotice(msg: RawMessage): Promise<void> {
        const uidToUin = await this.deps.enrich.resolveUidToUin(collectGrayTipUids(msg));
        const event =
            findRevokeElement(msg) !== undefined
                ? toMessageRecallEvent(msg, {
                      selfUin: this.deps.api.self.uin,
                      ...(uidToUin !== undefined ? { uidToUin } : {}),
                  })
                : toMilkyNoticeEvent(msg, this.noticeCtx(uidToUin));
        if (event !== null) {
            this.deps.broadcast(event);
        }
    }

    /** notice 翻译上下文（uidToUin 缺省空 Map；logger 透传校准日志）。 */
    private noticeCtx(uidToUin: Map<string, string> | undefined) {
        return {
            selfUin: this.deps.api.self.uin,
            ...(uidToUin !== undefined ? { uidToUin } : { uidToUin: new Map() }),
            ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        };
    }

    /** message_receive 组装：at uid→uin + reply 回填 + 群实体回填 + 转发段（全部 fail-soft）。 */
    private async buildMessageReceiveEvent(msg: RawMessage): Promise<unknown> {
        const elements = toCanonicalElements(msg);
        const ctx: ReceiveTranslateContext = { selfUin: this.deps.api.self.uin };
        await this.deps.enrich.fillMentionUids(elements, ctx);
        const replyIds = elements
            .filter((el) => el.type === "reply")
            .map((el) => (el as { messageId: string }).messageId);
        const meta = this.deps.seqIndex.collectReplyMeta(replyIds);
        if (meta.size > 0) {
            ctx.replyMeta = meta;
        }
        await this.deps.enrich.fillGroupEntities(msg, ctx);
        const forward = this.findForward(msg);
        if (forward !== undefined) {
            ctx.forwardSegments = [incomingForwardSegment(forward.resId, forward.fileName)];
        }
        return toMessageReceiveEvent(msg, ctx);
    }

    /** 转发 resId → 定位登记（get_forwarded_messages 反查用）。 */
    private recordForward(msg: RawMessage): void {
        const forward = this.findForward(msg);
        if (forward !== undefined && forward.resId !== "") {
            this.deps.seqIndex.recordForward(forward.resId, {
                chatType: msg.chatType,
                peerUid: msg.peerUid,
                msgId: msg.msgId,
            });
        }
    }

    private findForward(msg: RawMessage) {
        return msg.elements.find((el) => el.multiForwardMsgElement != null)?.multiForwardMsgElement;
    }
}
