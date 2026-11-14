/**
 * sysmsg 解码与识别共享层（2026-11-01 自 onebot11/helper/sysmsg.ts 上移，
 * milky.md §0.8.3/§0.8.6——OB11 与 Milky 共用同一识别机制）
 *
 * Msg/onRecvSysMsg 是群名片/头衔/精华/表情回应等系统事件的 sys msg 总闸，payload =
 * 原始 protobuf 字节（djinni int8 数组透传，实测 `[[10,64,…]]` 形状）。本模块：
 *  - decodeProtoTree：手写 protobuf wire-format 解码器（varint/length-delimited，
 *    零依赖，BigInt 保 64 位精度）
 *  - narrowSysMsgBlobs：回调参数防御性收窄（未知形状 → null，调用方打 raw 日志）
 *  - extractSysMsgEnvelope：按实测样本布局提取信封（逐字段可空）
 *  - recognizeSysMsg + SysMsgKindRule<TEvent>：(msgType, subType) → 协议事件。
 *    识别表按协议各自维护（onebot11/helper/sysmsg.ts / milky/helper/sysmsg.ts），
 *    表条目随录制窗口样本扩充；未识别一律走结构化校准日志，不广播。
 *
 * 证据：真实样本（c3 观测窗 2026-09-09 双样本 528/382）+ 批次三轮录制
 * （2026-11-01，732:16 / 732:1 / 732:21 / 528:349/381/382，wire bytes 全量解码，
 * milky.md §0.8.6 识别表）+ wrapper.node OnSysMsg* 处理器分类学（原生分发键 =
 * msg_type/sub_type）。翻译纯函数（ADR-008）。
 */
import type { AdapterLoggerLike } from "./log.js";

// ---------------------------------------------------------------------------
// wire-format 解码器
// ---------------------------------------------------------------------------

/** 递归深度上限（防御：恶意/畸形字节防栈溢出）。 */
const MAX_DEPTH = 16;

/** 单层字段数上限。 */
const MAX_FIELDS = 256;

/** 单个 varint 最大字节数（64 位 + 1 冗余）。 */
const MAX_VARINT_BYTES = 10;

/** protobuf 字段树节点（判别联合）。 */
export type SysMsgField =
    | {
          readonly no: number;
          readonly kind: "varint";
          /** 原始 64 位值（BigInt；安全转换走 varintToNumber）。 */
          readonly value: bigint;
      }
    | {
          readonly no: number;
          readonly kind: "bytes";
          readonly value: Uint8Array;
          /** 子树（try-parse 成功时；null = 不透明字节，empty [] = 空消息）。 */
          readonly children: readonly SysMsgField[] | null;
      };

/** 读 varint：成功返回 [值, 下一偏移]，越界/超长返回 null。 */
function readVarint(data: Uint8Array, start: number): [bigint, number] | null {
    let value = 0n;
    let shift = 0n;
    let i = start;
    while (true) {
        if (i >= data.length || i - start >= MAX_VARINT_BYTES) {
            return null;
        }
        const byte = data[i];
        if (byte === undefined) {
            return null;
        }
        i += 1;
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
            return [value, i];
        }
        shift += 7n;
    }
}

/** 单字段解码产物：field = 产出节点（定长跳过类无产出），next = 下一偏移。 */
interface DecodedField {
    readonly field: SysMsgField | undefined;
    readonly next: number;
}

/** wire 2：length-delimited 字段（递归 try-parse 子树，失败 → 不透明字节）。 */
function decodeLengthDelimited(
    data: Uint8Array,
    afterTag: number,
    no: number,
    depth: number,
): DecodedField | null {
    const len = readVarint(data, afterTag);
    if (len === null) {
        return null;
    }
    const payloadStart = len[1];
    const end = payloadStart + Number(len[0]);
    if (end > data.length) {
        return null;
    }
    const slice = data.slice(payloadStart, end);
    return {
        field: { no, kind: "bytes", value: slice, children: decodeProtoTree(slice, depth + 1) },
        next: end,
    };
}

/** 解码单个带 tag 字段；畸形（field 0 / group / 截断 / 越界）返回 null。 */
function decodeTaggedField(data: Uint8Array, start: number, depth: number): DecodedField | null {
    const tag = readVarint(data, start);
    if (tag === null) {
        return null;
    }
    const [tagValue, afterTag] = tag;
    const no = Number(tagValue >> 3n);
    if (no === 0) {
        return null;
    }
    return decodeFieldByWire(data, afterTag, no, Number(tagValue & 7n), depth);
}

/** 按 wire type 分派字段解码。 */
function decodeFieldByWire(
    data: Uint8Array,
    afterTag: number,
    no: number,
    wireType: number,
    depth: number,
): DecodedField | null {
    if (wireType === 0) {
        return decodeVarintFieldAt(data, afterTag, no);
    }
    if (wireType === 2) {
        return decodeLengthDelimited(data, afterTag, no, depth);
    }
    return decodeFixedField(data, afterTag, wireType);
}

/** wire 0：varint 字段。 */
function decodeVarintFieldAt(data: Uint8Array, afterTag: number, no: number): DecodedField | null {
    const v = readVarint(data, afterTag);
    if (v === null) {
        return null;
    }
    return { field: { no, kind: "varint", value: v[0] }, next: v[1] };
}

/** wire 1/5（fixed64/32）：跳过（QQ NT blob 未观测到，防御性兼容）；其余判失败。 */
function decodeFixedField(
    data: Uint8Array,
    afterTag: number,
    wireType: number,
): DecodedField | null {
    const width = fixedWireWidth(wireType);
    if (width === null) {
        return null; // wire 3/4（group）未观测到，整层判失败
    }
    return skipFixedBytes(data, afterTag, width);
}

/** fixed 类 wire 的字节宽度（非 fixed → null）。 */
function fixedWireWidth(wireType: number): number | null {
    if (wireType === 1) {
        return 8;
    }
    return wireType === 5 ? 4 : null;
}

/** 定长跳过（越界判失败）。 */
function skipFixedBytes(data: Uint8Array, start: number, width: number): DecodedField | null {
    const next = start + width;
    if (next > data.length) {
        return null;
    }
    return { field: undefined, next };
}

/**
 * 解码 protobuf wire-format 为递归字段树（不维护字段重复/顺序语义以外的信息）。
 *
 * - wire 0 varint / wire 2 length-delimited：支持；wire 2 递归 try-parse，
 *   子解析失败按不透明字节挂树（ASCII 串偶发误判嵌套无实害——树仅用于观测）。
 * - wire 1/5（fixed64/32）：跳过（QQ NT blob 未观测到，防御性兼容）。
 * - wire 3/4（group）、截断、field 0、超限：判失败返回 null。
 */
export function decodeProtoTree(data: Uint8Array, depth = 0): readonly SysMsgField[] | null {
    if (depth > MAX_DEPTH) {
        return null;
    }
    const fields: SysMsgField[] = [];
    let i = 0;
    while (i < data.length) {
        if (fields.length >= MAX_FIELDS) {
            return null;
        }
        const decoded = decodeTaggedField(data, i, depth);
        if (decoded === null) {
            return null;
        }
        if (decoded.field !== undefined) {
            fields.push(decoded.field);
        }
        i = decoded.next;
    }
    return fields;
}

/** 取字段号首个命中的节点（规则实现用，路径导航原语）。 */
export function firstField(
    tree: readonly SysMsgField[] | null,
    no: number,
): SysMsgField | undefined {
    return tree?.find((f) => f.no === no);
}

/** bytes 节点的子树（非 bytes/不透明 → null）。 */
export function getChildren(field: SysMsgField | undefined): readonly SysMsgField[] | null {
    return field?.kind === "bytes" ? field.children : null;
}

/** varint → number（超安全整数返回 null，调用方按缺字段处理）。 */
export function varintToNumber(value: bigint): number | null {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** UTF-8 严格解码 + 可打印检查（含控制字符判不可解码，返回 null）。 */
export function decodeText(bytes: Uint8Array): string | null {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        for (const ch of text) {
            const code = ch.codePointAt(0) ?? 0;
            if (code < 0x20 && code !== 0x09) {
                return null;
            }
        }
        return text;
    } catch {
        return null;
    }
}

/** 递归收集树内全部可打印字符串（校准观测用；先序遍历，空字节段跳过）。 */
export function collectStrings(tree: readonly SysMsgField[]): string[] {
    const out: string[] = [];
    for (const f of tree) {
        if (f.kind === "varint") {
            continue;
        }
        const text = decodeText(f.value);
        if (text !== null && text.length > 0) {
            out.push(text);
        }
        if (f.children !== null) {
            out.push(...collectStrings(f.children));
        }
    }
    return out;
}

/** 按字段号路径下钻 bytes 子树（每段取首个命中；任一段不成立 → null）。 */
export function nodeAt(
    tree: readonly SysMsgField[] | null,
    path: readonly number[],
): readonly SysMsgField[] | null {
    let node = tree;
    for (const no of path) {
        if (node === null) {
            return null;
        }
        node = getChildren(firstField(node, no));
    }
    return node;
}

/** 按路径取 varint 数值（bytes 子树末段的 varint 字段；缺失 → null）。 */
export function varintAt(
    tree: readonly SysMsgField[] | null,
    path: readonly number[],
): number | null {
    if (path.length === 0) {
        return null;
    }
    const parent = nodeAt(tree, path.slice(0, -1));
    const f = firstField(parent, path[path.length - 1] ?? -1);
    return f?.kind === "varint" ? varintToNumber(f.value) : null;
}

/** 单节点内 varint 字段数值（缺失 → null）。 */
export function varintOf(node: readonly SysMsgField[] | null, no: number): number | null {
    const f = firstField(node, no);
    return f?.kind === "varint" ? varintToNumber(f.value) : null;
}

/** 单节点内 UTF-8 字符串字段（缺失/不可解码 → null）。 */
export function textOf(node: readonly SysMsgField[] | null, no: number): string | null {
    const f = firstField(node, no);
    return f?.kind === "bytes" ? decodeText(f.value) : null;
}

// ---------------------------------------------------------------------------
// 回调参数收窄（onRecvSysMsg arg = 带符号字节数组的数组）
// ---------------------------------------------------------------------------

/** 单个候选块 → Uint8Array（number[] -128..255 / TypedArray；其余 null）。 */
function toBlob(item: unknown): Uint8Array | null {
    if (item instanceof Int8Array) {
        return Uint8Array.from(item, (b) => b & 0xff);
    }
    return blobFromGeneric(item);
}

/** Uint8Array / 字节数组形态（Int8Array 已在上层处理）。 */
function blobFromGeneric(item: unknown): Uint8Array | null {
    if (item instanceof Uint8Array) {
        return new Uint8Array(item);
    }
    if (Array.isArray(item) && item.length > 0) {
        return blobFromArray(item);
    }
    return null;
}

/** 字节形态数组 → Uint8Array（含非法元素整体判失败）。 */
function blobFromArray(item: unknown[]): Uint8Array | null {
    const out = new Uint8Array(item.length);
    for (let i = 0; i < item.length; i += 1) {
        const byte = signedToUnsigned(item[i]);
        if (byte === null) {
            return null;
        }
        out[i] = byte;
    }
    return out;
}

/** 带符号/无符号字节归一（非整数拒绝：浮点 & 0xff 会静默截断成别的字节）。 */
function signedToUnsigned(b: unknown): number | null {
    if (typeof b !== "number" || !Number.isInteger(b) || b < -128 || b > 255) {
        return null;
    }
    return b & 0xff;
}

/**
 * onRecvSysMsg 参数 → sysmsg 字节块列表（防御性收窄）。
 * 接受批数组（实测形状）/ 单块裸数组 / TypedArray；零有效块返回 null
 * （调用方打 raw 日志，与 narrowOfflineFiles 同模式）。
 */
export function narrowSysMsgBlobs(arg: unknown): readonly Uint8Array[] | null {
    if (Array.isArray(arg)) {
        // 优先按「批」解释（实测：外层数组内层字节块）
        const blobs = arg.map(toBlob).filter((b): b is Uint8Array => b !== null);
        if (blobs.length > 0) {
            return blobs;
        }
        // 兜底：arg 本身是裸字节数组
        const single = toBlob(arg);
        return single === null ? null : [single];
    }
    const single = toBlob(arg);
    return single === null ? null : [single];
}

// ---------------------------------------------------------------------------
// 信封提取（字段号依据 = 实测样本观察，逐字段软失败）
// ---------------------------------------------------------------------------

/** 实测样本信封（全部可空 = 提取失败不打死整条事件）。 */
export interface SysMsgEnvelope {
    /** f1.f1：行为人 uin（观测 = 自身账号；语义待校准）。 */
    actorUin: number | null;
    /** f1.f2：行为人 uid。 */
    actorUid: string | null;
    /** f1.f5：对象 uin（观测与 actor 相等）。 */
    targetUin: number | null;
    /** f1.f6：对象 uid。 */
    targetUid: string | null;
    /** f2.f1：msgType（原生分发键之一）。 */
    msgType: number | null;
    /** f2.f2：subType（原生分发键之一）。 */
    subType: number | null;
    /** f2.f3：备用 subType（观测恒等于 subType）。 */
    subTypeAlt: number | null;
    /** f2.f4/f5：群标识对（观测恒相邻整数，语义待校准）。 */
    groupCodes: readonly [number, number] | null;
    /** f2.f6：事件时间戳（秒）。 */
    time: number | null;
    /** 树内全部可打印字符串（校准观测用，含 base64 文本）。 */
    strings: readonly string[];
}

/** 顶层 f1 块的字段（uin/uid 对）。 */
function extractActorBlock(block: readonly SysMsgField[] | null): {
    uin: number | null;
    uid: string | null;
    uin2: number | null;
    uid2: string | null;
} {
    const empty = { uin: null, uid: null, uin2: null, uid2: null };
    if (block === null) {
        return empty;
    }
    return {
        uin: varintOf(block, 1),
        uid: textOf(block, 2),
        uin2: varintOf(block, 5),
        uid2: textOf(block, 6),
    };
}

/** 顶层 f2 块 → 信封数值字段。 */
function extractEnvelopeBlock(
    block: readonly SysMsgField[] | null,
): Pick<SysMsgEnvelope, "msgType" | "subType" | "subTypeAlt" | "groupCodes" | "time"> {
    const empty = { msgType: null, subType: null, subTypeAlt: null, groupCodes: null, time: null };
    if (block === null) {
        return empty;
    }
    const code4 = varintOf(block, 4);
    const code5 = varintOf(block, 5);
    return {
        msgType: varintOf(block, 1),
        subType: varintOf(block, 2),
        subTypeAlt: varintOf(block, 3),
        groupCodes: code4 !== null && code5 !== null ? ([code4, code5] as const) : null,
        time: varintOf(block, 6),
    };
}

/** 字段树 → 信封（任何字段缺失/非法 = null，不抛错）。 */
export function extractSysMsgEnvelope(tree: readonly SysMsgField[]): SysMsgEnvelope {
    const actor = extractActorBlock(getChildren(firstField(tree, 1)));
    return {
        actorUin: actor.uin,
        actorUid: actor.uid,
        targetUin: actor.uin2,
        targetUid: actor.uid2,
        ...extractEnvelopeBlock(getChildren(firstField(tree, 2))),
        strings: collectStrings(tree),
    };
}

// ---------------------------------------------------------------------------
// 识别层（协议各自持表；不得猜错还硬广播）
// ---------------------------------------------------------------------------

/**
 * 单条识别规则：表命中后从字段树提取协议事件体；提取失败 → null（降级校准日志）。
 *
 * - `kind`：协议侧事件种类（OB11 notice_type / Milky event_type）。
 * - `collectUids`（可选）：声明提取所需的 uid 集合——调用方批量 uid→uin 后经
 *   `uinOf` 解析器传入 extract（OB11 group_card 场景；不需要则不声明）。
 * - `uinOf`：uid → uin 解析器（未收集/解析失败返回 0，协议侧口径自定）。
 */
/** 规则执行上下文（信封与调用方装配信息，OB11 补 base 事件头用）。 */
export interface SysMsgRuleContext {
    /** 机器人自身 uin（数值）。 */
    selfUin: number;
    /** 事件时间（Unix 秒；sysmsg 信封 f2.f6，缺省进程当时）。 */
    time: number;
}

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

/** 字节块 → 小写 hex（校准日志用；超长由调用方截断）。 */
export function toHex(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) {
        out += b.toString(16).padStart(2, "0");
    }
    return out;
}

// ---------------------------------------------------------------------------
// 单条字节块通用管线（OB11 / Milky 同构流程收拢，2026-11-14）
// ---------------------------------------------------------------------------

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
    // 校准遥测（协议逆向用）：info/warn 级不出（2026-10-25 级别重分配），debug
    // 级保留全量字段（含 raw hex）供校准采集
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
