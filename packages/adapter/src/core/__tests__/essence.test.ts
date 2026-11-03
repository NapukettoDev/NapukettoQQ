/**
 * 精华共享翻译层单测（2026-11-03 自 milky/helper/essence.test.ts 迁移扩展）
 *
 * 732:1 fixture 为按识别表（milky.md §0.8.6）合成的 protobuf 字节——路径来自
 * 三轮录制 wire bytes 解码；真实样本回归待重录窗口补充。
 */

import type { EssenceMsgItem } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import {
    diffEssenceList,
    extractEssenceSetSysMsg,
    narrowEssenceGroupArg,
} from "../shared/essence.js";
import { decodeProtoTree } from "../shared/sysmsg.js";

describe("narrowEssenceGroupArg：回调参数 → 群号", () => {
    it("录制实证形状（参数数组首项字符串）", () => {
        expect(narrowEssenceGroupArg(["1101729931"])).toBe("1101729931");
    });

    it("裸字符串 / 数字 / 对象字段兜底 / 无效 → null", () => {
        expect(narrowEssenceGroupArg("1101729931")).toBe("1101729931");
        expect(narrowEssenceGroupArg(1101729931)).toBe("1101729931");
        expect(narrowEssenceGroupArg({ groupCode: "1101729931" })).toBe("1101729931");
        expect(narrowEssenceGroupArg({ peerUid: 1101729931 })).toBe("1101729931");
        expect(narrowEssenceGroupArg("")).toBeNull();
        expect(narrowEssenceGroupArg(undefined)).toBeNull();
        expect(narrowEssenceGroupArg([{ other: 1 }])).toBeNull();
    });
});

describe("diffEssenceList：列表 diff", () => {
    const item = (seq: number, adder: string, sender = "10001", time = 1): EssenceMsgItem =>
        ({
            msg_seq: seq,
            msg_random: seq,
            sender_uin: sender,
            sender_nick: "s",
            add_digest_uin: adder,
            add_digest_nick: "op",
            add_digest_time: time,
            msg_content: [],
        }) as EssenceMsgItem;

    it("基线未建立：只建缓存不产出事件", () => {
        const out = diffEssenceList(undefined, [item(1, "10001")]);
        expect(out.added).toEqual([]);
        expect(out.removed).toEqual([]);
        expect(out.cache.get(1)).toEqual({
            operatorUin: "10001",
            senderUin: "10001",
            addDigestTime: 1,
        });
    });

    it("新增 → added（operator + sender 回填）；移除 → removed", () => {
        const prev = new Map([
            [1, { operatorUin: "10001", senderUin: "10002", addDigestTime: 1 }],
            [2, { operatorUin: null, senderUin: null, addDigestTime: null }],
        ]);
        const out = diffEssenceList(prev, [item(2, "10001"), item(3, "10002", "10003")]);
        expect(out.added).toEqual([
            { messageSeq: 3, operatorUin: "10002", senderUin: "10003", addDigestTime: 1 },
        ]);
        expect(out.removed).toEqual([1]);
    });

    it("add_digest_uin / sender_uin 缺失 → null（OB11 侧省略/跳过口径）", () => {
        const prev = new Map([[1, { operatorUin: "10001", senderUin: "10001", addDigestTime: 1 }]]);
        const out = diffEssenceList(prev, [
            item(1, ""),
            item(2, "", ""),
            item(3, "10001", "10001", 0),
        ]);
        expect(out.added).toEqual([
            { messageSeq: 2, operatorUin: null, senderUin: null, addDigestTime: 1 },
            { messageSeq: 3, operatorUin: "10001", senderUin: "10001", addDigestTime: null },
        ]);
    });

    it("无变化 → 空 diff", () => {
        const prev = new Map([[1, { operatorUin: "10001", senderUin: "10001", addDigestTime: 1 }]]);
        const out = diffEssenceList(prev, [item(1, "10001")]);
        expect(out.added).toEqual([]);
        expect(out.removed).toEqual([]);
    });
});

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
