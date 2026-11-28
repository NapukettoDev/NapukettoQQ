import { collectStrings, nodeAt, type SysMsgField, textOf, varintOf } from "./proto-wire.js";

/**
 * 单个候选块 → Uint8Array（Int8Array / Uint8Array / number[] -128..255；其余 null）。
 * 字节值必须是整数：浮点 & 0xff 会静默截断成别的字节。
 */
function toBlob(item: unknown): Uint8Array | null {
    if (item instanceof Int8Array) {
        return Uint8Array.from(item, (b) => b & 0xff);
    }
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
        const b = item[i];
        if (typeof b !== "number" || !Number.isInteger(b) || b < -128 || b > 255) {
            return null;
        }
        out[i] = b & 0xff;
    }
    return out;
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
    const actor = extractActorBlock(nodeAt(tree, [1]));
    return {
        actorUin: actor.uin,
        actorUid: actor.uid,
        targetUin: actor.uin2,
        targetUid: actor.uid2,
        ...extractEnvelopeBlock(nodeAt(tree, [2])),
        strings: collectStrings(tree),
    };
}
