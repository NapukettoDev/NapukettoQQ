/**
 * OB11 inbound 消息域：Msg/onRecvMsg 单条消息分流——grayTip → notice（uid 查询
 * 失败丢弃整个事件是原语义，本次补 debug 日志不再静默）、自身消息默认丢弃
 * （reportSelfMessage 可开）、群文件报形式开关（groupUploadAsNotice →
 * group_upload notice）、其余翻译 message 事件。回填走 Ob11Enrichment。
 */
import type { RawMessage } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import { logEventFailure } from "../../shared/log.js";
import type { Ob11Enrichment } from "../enrichment.js";
import type { Ob11EventPipelineDeps } from "../event-pipeline.js";
import type { OB11Config } from "../helper/index.js";
import { toOb11MessageEvent } from "../helper/message-event.js";
import {
    collectGrayTipUids,
    hasFileElement,
    hasGrayTip,
    toGroupUpload,
    toOb11NoticeEvent,
} from "../helper/notice.js";

/** 消息域处理装配参数 = 管道依赖全集 + enrich（管道共享实例；按需取用字段）。 */
export type Ob11InboundMessageDeps = Ob11EventPipelineDeps & { enrich: Ob11Enrichment };

/** OB11 消息域处理器（Msg/onRecvMsg 分流与翻译派发）。 */
export class Ob11InboundMessage {
    private readonly deps: Ob11InboundMessageDeps;
    // 收链路开关（start/subscribeOnly/reload 经 applyConfig 刷新）
    private reportSelfMessage = false;
    private messageFormat: "array" | "string" = "array";
    /** 群文件报形式（）：true = fileElement 群消息报 group_upload notice 替代 message。 */
    private groupUploadAsNotice = false;

    constructor(deps: Ob11InboundMessageDeps) {
        this.deps = deps;
    }

    /** 刷新收链路开关（start / subscribeOnly / reload 共用）。 */
    applyConfig(config: OB11Config): void {
        this.reportSelfMessage = config.reportSelfMessage;
        this.messageFormat = config.messagePostFormat;
        this.groupUploadAsNotice = config.groupUploadAsNotice;
    }

    /** 单条收向消息：grayTip→notice / 自消息过滤 / 群文件开关 / message 事件。 */
    handleRawMessage(msg: RawMessage): void {
        // grayTip（系统事件）→ notice；否则 → 消息事件
        if (hasGrayTip(msg)) {
            this.broadcastNotice(msg).catch((err: unknown) => {
                // uid 查询炸掉丢弃整个 notice 是原语义（enrichment.noticeUidMap
                // 上抛）；补 debug 日志，不再静默吞
                this.deps.logger?.debug(
                    { err: err instanceof Error ? err.message : String(err) },
                    "ob11: notice 翻译失败（整个事件丢弃）",
                );
            });
            return;
        }
        // 自身消息：默认不上报（OB11 规范行为；reportSelfMessage=true 时上报）
        if (!this.reportSelfMessage && String(msg.senderUin) === this.deps.selfUin) {
            return;
        }
        // 群文件报形式开关（）：on = group_upload notice 替代 message 事件
        if (this.groupUploadAsNotice && msg.chatType === ChatType.GROUP && hasFileElement(msg)) {
            const notice = toGroupUpload(msg, this.deps.selfUin);
            if (notice !== null) {
                this.deps.broadcast(notice);
                return;
            }
        }
        // 回填/翻译失败只丢单条事件，不打断收链路
        this.broadcastMessageEvent(msg).catch((err: unknown) =>
            logEventFailure(this.deps.logger, "ob11: message 事件翻译失败（单条丢弃）", err),
        );
    }

    /**
     * 广播消息事件：回填 ctx 后交纯函数翻译；ID 转换在 enrichment 批量完成。
     */
    private async broadcastMessageEvent(msg: RawMessage): Promise<void> {
        const ctx = await this.deps.enrich.messageContext(msg);
        this.deps.broadcast(
            toOb11MessageEvent(
                msg,
                this.deps.selfUin,
                this.deps.api.messageUnique,
                this.messageFormat,
                ctx,
            ),
        );
    }

    /** 广播 grayTip → notice 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastNotice(msg: RawMessage): Promise<void> {
        const uidToUin = await this.deps.enrich.noticeUidMap(collectGrayTipUids(msg));
        const notice = toOb11NoticeEvent(msg, {
            selfUin: this.deps.selfUin,
            uidToUin,
            ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        });
        if (notice !== null) {
            this.deps.broadcast(notice);
        }
    }
}
