/**
 * Milky sysmsg 识别表单测（批次三，2026-11-01）
 *
 * 732:16 / 732:1 fixture 为按识别表（milky.md §0.8.6）合成的 protobuf 字节——
 * 路径与判别值来自三轮录制 wire bytes 解码；真实样本回归待重录窗口补充。
 */
import { describe, expect, it } from "vitest";
import { decodeProtoTree, extractSysMsgEnvelope } from "../../core/sysmsg.js";
import { recognizeMilkySysMsg } from "./sysmsg.js";

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

/** 文本 bytes 字段。 */
function encTextField(no: number, text: string): Uint8Array {
    return encBytesField(no, new TextEncoder().encode(text));
}

/** 732:16 合成样本：路径 f1.f1=群号 + f3.f2.f44.f1.f1={f1, f2.f1=msgSeq, f3={f1,f5,f3}}。 */
function reactionBlob(add: boolean): Uint8Array {
    // face 块：f1=faceId 字符串，f5=1 添加/2 撤销，f3=1 仅添加时存在，f4=bot uid 占位
    const faceParts: number[] = [
        ...encTextField(1, "76"),
        ...encVarintField(5, add ? 1 : 2),
        ...encTextField(4, "u_BOTUIDPLACEHOLDER"),
    ];
    if (add) {
        faceParts.push(...encVarintField(3, 1));
    }
    const face = Uint8Array.from(faceParts);
    const detail = Uint8Array.from([
        ...encVarintField(1, 1), // f1 变动值
        ...encBytesField(2, encVarintField(1, 150)), // f2.f1 = msgSeq
        ...encBytesField(3, face),
    ]);
    const f1 = encVarintField(1, 1101729931); // f1.f1 群号
    const f2 = Uint8Array.from([
        ...encVarintField(1, 732),
        ...encVarintField(2, 16),
        ...encVarintField(6, 1793540000),
    ]);
    const f3 = encBytesField(
        3,
        encBytesField(2, encBytesField(44, encBytesField(1, encBytesField(1, detail)))),
    );
    return Uint8Array.from([...encBytesField(1, f1), ...encBytesField(2, f2), ...f3]);
}

/** 732:1 合成样本：f1.f1=群号 + f1.f8.f8.f1=msgSeq。 */
function essenceBlob(): Uint8Array {
    const f1 = Uint8Array.from([
        ...encVarintField(1, 1101729931),
        ...encBytesField(8, encBytesField(8, encVarintField(1, 150))),
    ]);
    const f2 = Uint8Array.from([
        ...encVarintField(1, 732),
        ...encVarintField(2, 1),
        ...encVarintField(6, 1793540100),
    ]);
    return Uint8Array.from([...encBytesField(1, f1), ...encBytesField(2, f2)]);
}

describe("recognizeSysMsg：Milky 识别三态", () => {
    it("528 族（多端同步）→ observed_unnamed（不广播）", () => {
        expect(recognizeMilkySysMsg(528, 382).kind).toBe("observed_unnamed");
        expect(recognizeMilkySysMsg(528, 349).kind).toBe("observed_unnamed");
    });

    it("未知对 / null → unknown", () => {
        expect(recognizeMilkySysMsg(732, 99).kind).toBe("unknown");
        expect(recognizeMilkySysMsg(null, 16).kind).toBe("unknown");
    });
});

describe("732:16 group_message_reaction 规则提取", () => {
    it("添加回应：face_id / msgSeq / is_add=true（f5=1 + f3=1 双判据）", () => {
        const rec = recognizeMilkySysMsg(732, 16);
        if (rec.kind !== "notice") {
            throw new Error("expected notice");
        }
        const tree = decodeProtoTree(reactionBlob(true));
        if (tree === null) {
            throw new Error("decode failed");
        }
        const env = extractSysMsgEnvelope(tree);
        const data = rec.rule.extract(tree, env, () => 0, { selfUin: 1, time: 1 });
        expect(data).toEqual({
            group_id: 1101729931,
            message_seq: 150,
            face_id: 76,
            reaction_type: "face",
            is_add: true,
        });
    });

    it("撤销回应：f5=2（无 f3）→ is_add=false", () => {
        const rec = recognizeMilkySysMsg(732, 16);
        if (rec.kind !== "notice") {
            throw new Error("expected notice");
        }
        const tree = decodeProtoTree(reactionBlob(false));
        if (tree === null) {
            throw new Error("decode failed");
        }
        const env = extractSysMsgEnvelope(tree);
        expect(rec.rule.extract(tree, env, () => 0, { selfUin: 1, time: 1 })).toMatchObject({
            is_add: false,
        });
    });
});

describe("732:1 group_essence_message_change 规则提取（set 快路径）", () => {
    it("命中：群号 + msgSeq + is_set=true（operator 不可得省略）", () => {
        const rec = recognizeMilkySysMsg(732, 1);
        if (rec.kind !== "notice") {
            throw new Error("expected notice");
        }
        const tree = decodeProtoTree(essenceBlob());
        if (tree === null) {
            throw new Error("decode failed");
        }
        const env = extractSysMsgEnvelope(tree);
        expect(rec.rule.extract(tree, env, () => 0, { selfUin: 1, time: 1 })).toEqual({
            group_id: 1101729931,
            message_seq: 150,
            is_set: true,
        });
    });
});
