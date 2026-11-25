/**
 * 精华协议层提取器单测（列表缓存 / diff 已随 ADR-028 迁至 kernel 缓存层）
 *
 * 732:1 fixture 为按识别表（milky.md §0.8.6）合成的 protobuf 字节——路径来自
 * 三轮录制 wire bytes 解码；真实样本回归待重录窗口补充。
 */

import { describe, expect, it } from "vitest";
import { extractEssenceSetSysMsg } from "../../../src/internal/domain/essence.js";
import { decodeProtoTree } from "../../../src/internal/domain/sysmsg.js";

describe("extractEssenceSetSysMsg：732:1 路径提取", () => {
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
    function encVarintField(no: number, value: number): Uint8Array {
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

    /** 732:1 合成样本：f1.f1=群号 + f1.f8.f8.f1=msgSeq（识别表实证路径）。 */
    function essenceBlob(): Uint8Array {
        const f1 = Uint8Array.from([
            ...encVarintField(1, 1101729931),
            ...encBytesField(8, encBytesField(8, encVarintField(1, 150))),
        ]);
        const f2 = Uint8Array.from([...encVarintField(1, 732), ...encVarintField(2, 1)]);
        return Uint8Array.from([...encBytesField(1, f1), ...encBytesField(2, f2)]);
    }

    it("命中：群号 + msgSeq", () => {
        const tree = decodeProtoTree(essenceBlob());
        if (tree === null) {
            throw new Error("decode failed");
        }
        expect(extractEssenceSetSysMsg(tree)).toEqual({
            groupCode: 1101729931,
            messageSeq: 150,
        });
    });

    it("路径缺失 → null", () => {
        const bare = Uint8Array.from([...encVarintField(1, 732), ...encVarintField(2, 1)]);
        const tree = decodeProtoTree(Uint8Array.from([...encBytesField(2, bare)]));
        if (tree === null) {
            throw new Error("decode failed");
        }
        expect(extractEssenceSetSysMsg(tree)).toBeNull();
    });
});
