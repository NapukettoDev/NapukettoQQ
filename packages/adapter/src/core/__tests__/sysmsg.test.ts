/**
 * core sysmsg 解码层单测（2026-11-01 自 onebot11/helper/sysmsg.test.ts 上移随迁；
 * 识别层测试归各协议 helper，见 onebot11/helper/sysmsg.test.ts /
 * milky/helper/sysmsg.test.ts）。
 *
 * 双路样本：
 *  - 合成字节（测试内手工构造 varint/嵌套/畸形输入）覆盖解码器边界行为；
 *  - 脱敏真实样本 fixture（c3 观测窗 2026-09-09 实触 2 条，各 151 字节）覆盖
 *    真实 wire 字节端到端。
 *
 * ⚠️ 脱敏说明：原始样本含本机登录账号 uin / uid / 群标识 / base64 尾部，
 * 已做**等长字节替换**（uin→10000000001、uid→u_MASKEDUID…、群标识对→
 * 0xAAAAAAAA(+1)/0xBBBBBBBB(+1)、base64 尾部清零）——msgType/subType
 * （528/382）、时间戳、varint 边界与嵌套长度等结构字节原样保留，真实样本的
 * 回归价值不受影响。
 */
import { describe, expect, it } from "vitest";
import {
    collectStrings,
    decodeProtoTree,
    extractSysMsgEnvelope,
    narrowSysMsgBlobs,
    nodeAt,
    type SysMsgField,
    textOf,
    toHex,
    varintAt,
    varintOf,
    varintToNumber,
} from "../shared/sysmsg.js";

/** hex → Uint8Array。 */
function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i + 1 < hex.length; i += 2) {
        out[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
    }
    return out;
}

/** varint 编码。 */
function encVarint(value: number | bigint): Uint8Array {
    let v = BigInt(value);
    const out: number[] = [];
    while (true) {
        const b = Number(v & 0x7fn);
        v >>= 7n;
        if (v === 0n) {
            out.push(b);
            return Uint8Array.from(out);
        }
        out.push(b | 0x80);
    }
}

/** varint 字段（wire 0）。 */
function encVarintField(no: number, value: number | bigint): Uint8Array {
    return Uint8Array.from([...encVarint(BigInt(no) << 3n), ...encVarint(value)]);
}

/** length-delimited 字段（wire 2）。 */
function encBytesField(no: number, payload: Uint8Array): Uint8Array {
    return Uint8Array.from([
        ...encVarint((BigInt(no) << 3n) | 2n),
        ...encVarint(payload.length),
        ...payload,
    ]);
}

/** 嵌套包裹：payload 变成 field 1 的子消息。 */
function wrap(payload: Uint8Array): Uint8Array {
    return encBytesField(1, payload);
}

/** 最内层 bytes 节点的 children（沿首个 bytes 节点下钻；null = 不透明降级）。 */
function deepestChildren(tree: readonly SysMsgField[]): readonly SysMsgField[] | null {
    const f = tree[0];
    if (f === undefined || f.kind !== "bytes") {
        return tree;
    }
    return f.children === null ? null : deepestChildren(f.children);
}

// ---------------------------------------------------------------------------
// 脱敏真实样本 fixture（c3 观测窗 2026-09-09 实触，脱敏说明见文件头）
// ---------------------------------------------------------------------------

const SAMPLE_1_HEX =
    "0a400881c8afa0251218755f4d41534b45445549444d41534b45445549444d4154512881c8afa0253218755f4d41534b45445549444d41534b45445549444d415451123108900410fe0218fe0220aad5aad50a28abd5aad50a308d9486d50660aad5aad58a808080028002e6a0c2e5f3af9ee8b4011a200a00121c4367496f4168442b416741414141414141414141414141414141413d";
const SAMPLE_2_HEX =
    "0a400881c8afa0251218755f4d41534b45445549444d41534b45445549444d4154512881c8afa0253218755f4d41534b45445549444d41534b45445549444d415451123108900410fe0218fe0220bbf7eedd0b28bcf7eedd0b30919486d50660bbf7eedd8b808080028002cbd4f89b82b8d7b6d9011a200a00121c4367496f4168442b416741414141414141414141414141414141413d";

describe("decodeProtoTree：wire-format 解码", () => {
    it("varint 单字段（多字节值）", () => {
        expect(decodeProtoTree(encVarintField(1, 300))).toEqual([
            { no: 1, kind: "varint", value: 300n },
        ]);
    });

    it("64 位 varint 精度保持（BigInt）", () => {
        const big = 2n ** 57n + 2863311530n;
        expect(decodeProtoTree(encVarintField(12, big))).toEqual([
            { no: 12, kind: "varint", value: big },
        ]);
    });

    it("嵌套 msg（varint + 不可解析字符串子块 → 不透明字节）", () => {
        const text = new TextEncoder().encode("abc"); // "abc" 作 protobuf 解析失败
        const inner = Uint8Array.from([...encVarintField(1, 7), ...encBytesField(2, text)]);
        expect(decodeProtoTree(encBytesField(3, inner))).toEqual([
            {
                no: 3,
                kind: "bytes",
                value: inner,
                children: [
                    { no: 1, kind: "varint", value: 7n },
                    { no: 2, kind: "bytes", value: text, children: null },
                ],
            },
        ]);
    });

    it("try-parse 失败 → children null（不透明字节）", () => {
        const opaque = Uint8Array.from([0x0f]); // field 1 wire 7 非法
        expect(decodeProtoTree(encBytesField(1, opaque))).toEqual([
            { no: 1, kind: "bytes", value: opaque, children: null },
        ]);
    });

    it("wire 1/5（fixed64/32）跳过不产出节点", () => {
        const data = Uint8Array.from([
            0x09,
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8, // f1 fixed64
            0x0d,
            9,
            8,
            7,
            6, // f2 fixed32
            ...encVarintField(3, 1),
        ]);
        expect(decodeProtoTree(data)).toEqual([{ no: 3, kind: "varint", value: 1n }]);
    });

    it("畸形输入顶层判失败 → null：wire 3 / 截断 varint / field 0 / length 越界", () => {
        expect(decodeProtoTree(Uint8Array.from([0x0b]))).toBeNull(); // field1 wire3
        expect(decodeProtoTree(Uint8Array.from([0x08]))).toBeNull(); // varint 截断
        expect(decodeProtoTree(Uint8Array.from([0x00]))).toBeNull(); // field 0
        expect(decodeProtoTree(Uint8Array.from([0x0a, 0x05, 0x01]))).toBeNull(); // length 越界
        expect(decodeProtoTree(Uint8Array.from([0x60]))).toBeNull(); // field12 wire0 无值
    });

    it("深度上限：16 层包裹解析到底，17 层降级为不透明字节（防栈溢出）", () => {
        let ok = encVarintField(1, 1);
        for (let i = 0; i < 16; i += 1) {
            ok = wrap(ok);
        }
        // 根 + 16 层 bytes：最内层 children = [varint 叶子]
        expect(deepestChildren(decodeProtoTree(ok) ?? [])).toEqual([
            { no: 1, kind: "varint", value: 1n },
        ]);
        // 再包一层（第 17 层）：超深部分整体降级为 children null，树不炸
        const deep = wrap(ok);
        expect(deepestChildren(decodeProtoTree(deep) ?? [])).toBeNull();
    });

    it("字段数上限：256 字段可解析，257 判失败", () => {
        const ok = new Uint8Array(512);
        for (let i = 0; i < 256; i += 1) {
            ok[i * 2] = 0x08; // field 1 varint
            ok[i * 2 + 1] = 0x01;
        }
        expect(decodeProtoTree(ok)).not.toBeNull();
        expect(decodeProtoTree(Uint8Array.from([0x08, 0x01, ...ok]))).toBeNull();
    });

    it("空输入 → 空树（非 null）", () => {
        expect(decodeProtoTree(new Uint8Array(0))).toEqual([]);
    });
});

describe("narrowSysMsgBlobs：回调参数防御性收窄", () => {
    it("实测批形状 [[signed bytes]] → Uint8Array（&0xFF 归一）", () => {
        const blobs = narrowSysMsgBlobs([[10, 64, -100, 200]]);
        expect(blobs?.length).toBe(1);
        expect(Array.from(blobs?.[0] ?? [])).toEqual([10, 64, 156, 200]);
    });

    it("多条批量 → 多块", () => {
        expect(narrowSysMsgBlobs([[1, 2], [3]])?.length).toBe(2);
    });

    it("单块裸字节数组兜底", () => {
        const blobs = narrowSysMsgBlobs([10, 64, 8]);
        expect(blobs?.length).toBe(1);
        expect(Array.from(blobs?.[0] ?? [])).toEqual([10, 64, 8]);
    });

    it("TypedArray 输入（Uint8Array 批 / Int8Array 裸块）", () => {
        expect(narrowSysMsgBlobs([new Uint8Array([1, 2])])?.length).toBe(1);
        const fromInt8 = narrowSysMsgBlobs(new Int8Array([10, -100]));
        expect(Array.from(fromInt8?.[0] ?? [])).toEqual([10, 156]);
    });

    it("批内垃圾项跳过、有效项保留", () => {
        expect(narrowSysMsgBlobs(["垃圾", [1, 2], {}, [3]])?.length).toBe(2);
    });

    it("未知形状 → null：垃圾 / 空批 / 空数组 / 越界数值 / 浮点 / NaN", () => {
        expect(narrowSysMsgBlobs({ foo: 1 })).toBeNull();
        expect(narrowSysMsgBlobs("str")).toBeNull();
        expect(narrowSysMsgBlobs([])).toBeNull();
        expect(narrowSysMsgBlobs([[]])).toBeNull();
        expect(narrowSysMsgBlobs([[300]])).toBeNull();
        expect(narrowSysMsgBlobs([[-129]])).toBeNull();
        expect(narrowSysMsgBlobs([[1.5]])).toBeNull();
        expect(narrowSysMsgBlobs([[Number.NaN]])).toBeNull();
    });
});

describe("extractSysMsgEnvelope：脱敏真实样本信封提取（design.md §7.3）", () => {
    it("样本 1：信封字段全量断言", () => {
        const tree = decodeProtoTree(hexToBytes(SAMPLE_1_HEX)) ?? [];
        const env = extractSysMsgEnvelope(tree);
        expect(env.actorUin).toBe(10000000001);
        expect(env.actorUid).toBe("u_MASKEDUIDMASKEDUIDMATQ");
        expect(env.targetUin).toBe(10000000001);
        expect(env.targetUid).toBe("u_MASKEDUIDMASKEDUIDMATQ");
        expect(env.msgType).toBe(528);
        expect(env.subType).toBe(382);
        expect(env.subTypeAlt).toBe(382);
        expect(env.groupCodes).toEqual([2863311530, 2863311531]); // 0xAAAAAAAA / +1
        expect(env.time).toBe(1788971533); // 2026-09-09T16:32:13Z
        expect(env.strings).toEqual([
            "u_MASKEDUIDMASKEDUIDMATQ",
            "u_MASKEDUIDMASKEDUIDMATQ",
            "CgIoAhD+AgAAAAAAAAAAAAAAAAA=",
        ]);
    });

    it("样本 2：同构不同群标识与时间戳", () => {
        const env = extractSysMsgEnvelope(decodeProtoTree(hexToBytes(SAMPLE_2_HEX)) ?? []);
        expect(env.msgType).toBe(528);
        expect(env.subType).toBe(382);
        expect(env.groupCodes).toEqual([3149642683, 3149642684]); // 0xBBBBBBBB / +1
        expect(env.time).toBe(1788971537); // 2026-09-09T16:32:17Z
    });

    it("空树 / 缺字段 → 全 null 软失败", () => {
        const env = extractSysMsgEnvelope([]);
        expect(env.actorUin).toBeNull();
        expect(env.msgType).toBeNull();
        expect(env.groupCodes).toBeNull();
        expect(env.time).toBeNull();
        expect(env.strings).toEqual([]);
    });
});

describe("collectStrings / varintToNumber / toHex", () => {
    it("collectStrings：先序、跳过空字节段、不透明字节也取文本", () => {
        const text = new TextEncoder().encode("abc"); // 解析失败 → children null，文本仍收集
        const tree =
            decodeProtoTree(
                Uint8Array.from([
                    ...encBytesField(1, text),
                    ...encBytesField(2, new Uint8Array(0)),
                    ...encVarintField(3, 1),
                ]),
            ) ?? [];
        expect(collectStrings(tree)).toEqual(["abc"]);
    });

    it("varintToNumber：安全整数内转 number，超限 null", () => {
        expect(varintToNumber(1n)).toBe(1);
        expect(varintToNumber(3567141148n)).toBe(3567141148);
        expect(varintToNumber(2n ** 57n)).toBeNull();
    });

    it("toHex：小写补零", () => {
        expect(toHex(Uint8Array.from([0x0a, 0x40, 0xff]))).toBe("0a40ff");
    });
});

describe("nodeAt / varintAt / varintOf / textOf：规则路径导航原语", () => {
    it("nodeAt 沿 bytes 子树下钻（每段首个命中）；断链返回 null", () => {
        const tree = decodeProtoTree(
            Uint8Array.from([...encBytesField(3, encBytesField(2, encVarintField(1, 42)))]),
        );
        expect(varintAt(tree, [3, 2, 1])).toBe(42);
        expect(nodeAt(tree, [3, 9])).toBeNull();
        expect(varintAt(tree, [3, 9, 1])).toBeNull();
    });

    it("varintAt 命中 bytes 而非 varint → null；varintOf/textOf 单节点取值", () => {
        const text = new TextEncoder().encode("76");
        const tree = decodeProtoTree(
            Uint8Array.from([
                ...encBytesField(
                    1,
                    Uint8Array.from([...encVarintField(5, 1), ...encBytesField(1, text)]),
                ),
            ]),
        );
        expect(varintAt(tree, [1, 1])).toBeNull(); // f1 是 bytes 子块
        const inner = nodeAt(tree, [1]);
        expect(varintOf(inner, 5)).toBe(1);
        expect(textOf(inner, 1)).toBe("76");
        expect(textOf(inner, 9)).toBeNull();
    });
});

describe("varintAt 空路径守卫（defensive 分支补漏）", () => {
    it("path 为空：直接返回 null（不触树）", () => {
        expect(varintAt(null, [])).toBeNull();
        expect(varintAt([], [])).toBeNull();
    });

    it("末段字段不存在：返回 null", () => {
        expect(varintAt([], [99])).toBeNull();
    });
});
