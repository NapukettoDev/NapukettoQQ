/**
 * OB11 inbound sysmsg 域（自 event-pipeline.ts 拆出）
 *
 * Msg/onRecvSysMsg 总闸：参数收窄（未知形状 raw warn）→ 单条字节块走
 * core/shared/sysmsg.ts 的 processSysMsgBlob 通用管线（解码 → 信封 → 识别 →
 * 分流）。表命中做两件事：732:1 精华加速触发器（表外，踢入 essence 域的串行
 * diff 链）与识别表规则广播（uid→uin 经 enrichment 批量回填后 extract）；
 * 未识别 / 提取失败落校准路径，不广播半成品。
 */

import { truncRaw } from "../../shared/log.js";
import {
    narrowSysMsgBlobs,
    processSysMsgBlob,
    type SysMsgEnvelope,
    type SysMsgField,
    type SysMsgRecognition,
} from "../../shared/sysmsg.js";
import { MS_TO_SEC } from "../../shared/uid-uin.js";
import type { Ob11Enrichment } from "../enrichment.js";
import type { OB11NoticeEvent } from "../event/index.js";
import type { Ob11EventPipelineDeps } from "../event-pipeline.js";
import { recognizeOb11SysMsg } from "../helper/sysmsg.js";
import type { Ob11InboundEssence } from "./essence.js";

/** sysmsg 域装配参数 = 管道依赖全集 + enrich / essence（管道共享实例）。 */
export type Ob11InboundSysMsgDeps = Ob11EventPipelineDeps & {
    enrich: Ob11Enrichment;
    essence: Ob11InboundEssence;
};

/** OB11 sysmsg 域处理器（解码识别分流 + 精华触发器）。 */
export class Ob11InboundSysMsg {
    private readonly deps: Ob11InboundSysMsgDeps;

    constructor(deps: Ob11InboundSysMsgDeps) {
        this.deps = deps;
    }

    /** onRecvSysMsg 总闸：参数收窄（未知形状 raw warn）→ 逐块走通用管线。 */
    handleRawArg(arg: unknown): void {
        const blobs = narrowSysMsgBlobs(arg);
        if (blobs === null) {
            this.deps.logger?.warn(
                { raw: truncRaw(JSON.stringify(arg)) },
                "ob11: onRecvSysMsg 未知参数形状",
            );
            return;
        }
        for (const blob of blobs) {
            void processSysMsgBlob(blob, {
                scope: "ob11",
                logger: this.deps.logger,
                // 解码失败 warn：字节损坏值得警示（OB11 既有口径，与 Milky debug 不同）
                decodeFailLevel: "warn",
                recognize: (msgType, subType) => recognizeOb11SysMsg(msgType, subType),
                onNotice: (tree, env, rec) => this.handleRecognized(tree, env, rec),
            });
        }
    }

    /**
     * 已解码 sysmsg 分流（732:1 精华触发器 / 识别表规则广播）；返回 true =
     * 已消费。提取失败返回 false 落入校准路径（不硬广播半成品事件）。
     */
    private async handleRecognized(
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
        rec: SysMsgRecognition<OB11NoticeEvent>,
    ): Promise<boolean> {
        // 732:1 群精华设置（识别表实证，表外触发器）：push 无 sender/operator，
        // 不直接翻译，踢入列表 diff 串行链（design.md §1 group_essence bullet）；
        // 抽取失败落入校准路径
        if (env.msgType === 732 && env.subType === 1 && this.deps.essence.triggerFromSysMsg(tree)) {
            return true;
        }
        if (rec.kind !== "notice") {
            return false;
        }
        const uinOf = await this.deps.enrich.sysMsgUinResolver(rec.rule, tree, env);
        const ctx = {
            selfUin: Number(this.deps.selfUin),
            time: env.time ?? Math.floor(Date.now() / MS_TO_SEC),
        };
        const event = rec.rule.extract(tree, env, uinOf, ctx);
        if (event === null) {
            return false;
        }
        this.deps.broadcast(event);
        return true;
    }
}
