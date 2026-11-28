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
    const wireType = Number(tagValue & 7n);
    switch (wireType) {
        case 0: {
            const v = readVarint(data, afterTag);
            if (v === null) {
                return null;
            }
            return { field: { no, kind: "varint", value: v[0] }, next: v[1] };
        }
        case 2:
            return decodeLengthDelimited(data, afterTag, no, depth);
        // wire 1/5（fixed64/32）：QQ NT blob 未观测到，按定长跳过（防御性兼容）
        case 1:
        case 5: {
            const next = afterTag + (wireType === 1 ? 8 : 4);
            if (next > data.length) {
                return null;
            }
            return { field: undefined, next };
        }
        default:
            // wire 3/4（group）未观测到，整层判失败
            return null;
    }
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
function firstField(tree: readonly SysMsgField[] | null, no: number): SysMsgField | undefined {
    return tree?.find((f) => f.no === no);
}

/** bytes 节点的子树（非 bytes/不透明 → null）。 */
function getChildren(field: SysMsgField | undefined): readonly SysMsgField[] | null {
    return field?.kind === "bytes" ? field.children : null;
}

/** varint → number（超安全整数返回 null，调用方按缺字段处理）。 */
export function varintToNumber(value: bigint): number | null {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** UTF-8 严格解码 + 可打印检查（含控制字符判不可解码，返回 null）。 */
function decodeText(bytes: Uint8Array): string | null {
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

/** 字节块 → 小写 hex（校准日志用；超长由调用方截断）。 */
export function toHex(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) {
        out += b.toString(16).padStart(2, "0");
    }
    return out;
}
