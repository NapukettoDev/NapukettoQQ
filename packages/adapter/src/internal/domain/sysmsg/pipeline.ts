import type { AdapterLoggerLike } from "../../infra/log.js";
import { extractSysMsgEnvelope, type SysMsgEnvelope } from "./envelope.js";
import { decodeProtoTree, type SysMsgField, toHex } from "./proto-wire.js";

/** 规则执行上下文（信封与调用方装配信息，OB11 补 base 事件头用）。 */
export interface SysMsgRuleContext {
    /** 机器人自身 uin（数值）。 */
    selfUin: number;
    /** 事件时间（Unix 秒；sysmsg 信封 f2.f6，缺省进程当时）。 */
    time: number;
}

/**
 * 单条识别规则：表命中后从字段树提取协议事件体；提取失败 → null（降级校准日志）。
 *
 * - `kind`：协议侧事件种类（OB11 notice_type / Milky event_type）。
 * - `collectUids`（可选）：声明提取所需的 uid 集合——调用方批量 uid→uin 后经
 *   `uinOf` 解析器传入 extract（OB11 group_card 场景；不需要则不声明）。
 * - `uinOf`：uid → uin 解析器（未收集/解析失败返回 0，协议侧口径自定）。
 */
export interface SysMsgKindRule<TEvent> {
    readonly kind: string;
    collectUids?(tree: readonly SysMsgField[], env: SysMsgEnvelope): readonly string[];
    extract(
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
        uinOf: (uid: string) => number,
        ctx: SysMsgRuleContext,
    ): TEvent | null;
}

/** 识别结果三态。 */
export type SysMsgRecognition<TEvent> =
    | { readonly kind: "notice"; readonly rule: SysMsgKindRule<TEvent> }
    | { readonly kind: "observed_unnamed" }
    | { readonly kind: "unknown" };

/**
 * 已观测但未命名的原生分发键（OB11 / Milky 共用）：不广播，仅进校准日志。
 * 键 = `"${msgType}:${subType}"`。
 */
export const OBSERVED_UNNAMED_SYSMSG_KEYS: ReadonlySet<string> = new Set([
    "528:382",
    "528:349",
    "528:381",
]);

/**
 * (msgType, subType) → 识别结果。table / observedUnnamed 由各协议注入
 * （键 = `"${msgType}:${subType}"`，原生分发键）。
 */
export function recognizeSysMsg<TEvent>(
    msgType: number | null,
    subType: number | null,
    table: ReadonlyMap<string, SysMsgKindRule<TEvent>>,
    observedUnnamed: ReadonlySet<string> = new Set(),
): SysMsgRecognition<TEvent> {
    if (msgType === null || subType === null) {
        return { kind: "unknown" };
    }
    const rule = table.get(`${msgType}:${subType}`);
    if (rule !== undefined) {
        return { kind: "notice", rule };
    }
    return observedUnnamed.has(`${msgType}:${subType}`)
        ? { kind: "observed_unnamed" }
        : { kind: "unknown" };
}

/** processSysMsgBlob 装配参数（识别表 / 命中分流 / 校准日志由协议侧注入）。 */
export interface SysMsgBlobPipelineOptions<TEvent> {
    /** 日志前缀（协议名："ob11" / "milky"）。 */
    scope: string;
    /** 校准日志（缺省静默：解码失败与未识别日志都不输出）。 */
    logger?: AdapterLoggerLike | undefined;
    /**
     * 解码失败日志级别（协议既有口径，刻意不统一：OB11 warn——字节损坏值得
     * 警示；Milky debug——校准遥测口径）。
     */
    decodeFailLevel: "warn" | "debug";
    /** (msgType, subType) → 识别结果（协议各自绑表）。 */
    recognize: (msgType: number | null, subType: number | null) => SysMsgRecognition<TEvent>;
    /**
     * 已解码块分流（识别结果整体透传，供协议侧做表外触发器，如 OB11 732:1
     * 精华加速器）：返回 true = 已消费不进校准日志；false = 落入未识别校准
     * 路径（触发器 / 规则提取失败，不广播半成品）。
     */
    onNotice: (
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
        rec: SysMsgRecognition<TEvent>,
    ) => boolean | Promise<boolean>;
}

/**
 * 单条 sysmsg 字节块通用管线：解码 → 信封 → 识别 → onNotice 分流；未消费走
 * 结构化 debug 校准日志（verdict + 信封全字段 + raw hex，协议逆向用遥测）。
 * OB11 / Milky 共用流程，差异只在识别表、命中处理与解码失败日志级别。
 */
export async function processSysMsgBlob<TEvent>(
    blob: Uint8Array,
    opts: SysMsgBlobPipelineOptions<TEvent>,
): Promise<void> {
    const tree = decodeProtoTree(blob);
    if (tree === null) {
        const payload = { raw: toHex(blob).slice(0, 1024) };
        const message = `${opts.scope}: onRecvSysMsg protobuf 解码失败`;
        if (opts.decodeFailLevel === "warn") {
            opts.logger?.warn(payload, message);
        } else {
            opts.logger?.debug(payload, message);
        }
        return;
    }
    const env = extractSysMsgEnvelope(tree);
    const rec = opts.recognize(env.msgType, env.subType);
    if (await opts.onNotice(tree, env, rec)) {
        return;
    }
    // 未识别事件的信封与原始字节仅写入 debug 校准日志。
    opts.logger?.debug(
        {
            verdict: rec.kind,
            msgType: env.msgType,
            subType: env.subType,
            subTypeAlt: env.subTypeAlt,
            groupCodes: env.groupCodes,
            time: env.time,
            actorUin: env.actorUin,
            actorUid: env.actorUid,
            strings: env.strings,
            raw: toHex(blob).slice(0, 1024),
        },
        `${opts.scope}: onRecvSysMsg 校准数据（未识别，不广播）`,
    );
}
