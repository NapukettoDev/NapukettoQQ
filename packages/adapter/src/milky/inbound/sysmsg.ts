/**
 * Milky inbound sysmsg 域：Msg/onRecvSysMsg 总闸——参数收窄（未知形状 raw warn）
 * → 单条字节块走 core/shared/sysmsg.ts 的 processSysMsgBlob 通用管线（解码 →
 * 信封 → 识别 → 分流）。表命中提取 data 体 → 精华快路径 claim 去重 → 信封包装
 * 广播；未识别 / 提取失败落校准路径，不广播半成品。
 */
import { sliceRaw } from "../../shared/log.js";
import {
    narrowSysMsgBlobs,
    processSysMsgBlob,
    type SysMsgEnvelope,
    type SysMsgField,
    type SysMsgRecognition,
} from "../../shared/sysmsg.js";
import type { MilkyInboundBase } from "../api.js";
import { recognizeMilkySysMsg } from "../helper/event/sysmsg.js";
import type { MilkyInboundEssence } from "./essence.js";

/** sysmsg 域装配参数 = 管道依赖全集 + essence（精华域共享实例，快路径 claim）。 */
export type MilkyInboundSysMsgDeps = MilkyInboundBase & { essence: MilkyInboundEssence };

/** Milky sysmsg 域处理器（解码识别分流 + 精华快路径去重）。 */
export class MilkyInboundSysMsg {
    private readonly deps: MilkyInboundSysMsgDeps;

    constructor(deps: MilkyInboundSysMsgDeps) {
        this.deps = deps;
    }

    /** onRecvSysMsg 总闸：参数收窄（未知形状 raw warn）→ 逐块走通用管线。 */
    handleRawArg(arg: unknown): void {
        const blobs = narrowSysMsgBlobs(arg);
        if (blobs === null) {
            this.deps.logger?.warn(
                { raw: sliceRaw(JSON.stringify(arg)) },
                "milky: onRecvSysMsg 未知参数形状",
            );
            return;
        }
        for (const blob of blobs) {
            void processSysMsgBlob(blob, {
                scope: "milky",
                logger: this.deps.logger,
                // 解码失败 debug：校准遥测口径（与 OB11 warn 不同，协议既有级别）
                decodeFailLevel: "debug",
                recognize: (msgType, subType) => recognizeMilkySysMsg(msgType, subType),
                onNotice: (tree, env, rec) => this.handleHit(tree, env, rec),
            });
        }
    }

    /** 表命中分流：提取 data 体 → 精华快路径 claim → 信封包装广播；失败落校准。 */
    private async handleHit(
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
        rec: SysMsgRecognition<unknown>,
    ): Promise<boolean> {
        if (rec.kind !== "notice") {
            return false;
        }
        const data = rec.rule.extract(tree, env, () => 0, {
            selfUin: Number(this.deps.api.self.uin),
            time: env.time ?? Math.floor(Date.now() / 1000),
        });
        if (data === null) {
            return false;
        }
        if (!this.deps.essence.claimFastPath(rec.rule.kind, data)) {
            return true; // 已由列表 diff 抢发，静默跳过
        }
        this.deps.broadcast({
            time: env.time ?? Math.floor(Date.now() / 1000),
            self_id: Number(this.deps.api.self.uin),
            event_type: rec.rule.kind,
            data,
        });
        return true;
    }
}
