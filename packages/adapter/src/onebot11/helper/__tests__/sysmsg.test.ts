/**
 * OB11 sysmsg 识别表单测（解码层测试在 core/sysmsg.test.ts）
 *
 * 732:21 群名片变更规则用合成 wire bytes（按轮录制实证的 strings 顺序
 * [群号, 对象 uid, 新值, 旧值] 构造）覆盖：命中提取 / 判别式拒收 / uid 解析。
 */
import { describe, expect, it } from "vitest";
import {
    decodeProtoTree,
    extractSysMsgEnvelope,
    recognizeOb11SysMsg,
    type SysMsgKindRuleOB11,
} from "../sysmsg.js";

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

/**
 * 构造 732:21 形状样本：f2 块内 [f1=msgType 732, f2=subType 21, 群号, uid,
 * 新值, 旧值]（collectStrings 先序 = 录制实证顺序）。
 */
function cardChangeBlob(group: string, uid: string, cardNew: string, cardOld: string): Uint8Array {
    const f2 = Uint8Array.from([
        ...encVarintField(1, 732),
        ...encVarintField(2, 21),
        ...encTextField(4, group),
        ...encTextField(5, uid),
        ...encTextField(6, cardNew),
        ...encTextField(7, cardOld),
    ]);
    return Uint8Array.from([...encBytesField(2, f2)]);
}

describe("recognizeSysMsg：OB11 识别三态", () => {
    it("已观测未命名键（528 族）→ observed_unnamed（不广播）", () => {
        expect(recognizeOb11SysMsg(528, 382).kind).toBe("observed_unnamed");
        expect(recognizeOb11SysMsg(528, 349).kind).toBe("observed_unnamed");
        expect(recognizeOb11SysMsg(528, 381).kind).toBe("observed_unnamed");
    });

    it("未知对 / null → unknown（不广播）", () => {
        expect(recognizeOb11SysMsg(1, 2).kind).toBe("unknown");
        expect(recognizeOb11SysMsg(null, 382).kind).toBe("unknown");
        expect(recognizeOb11SysMsg(528, null).kind).toBe("unknown");
    });

    it("732:21 → notice（表命中）", () => {
        const rec = recognizeOb11SysMsg(732, 21);
        expect(rec.kind).toBe("notice");
        expect(rec.kind === "notice" && rec.rule.kind).toBe("group_card");
    });
});

describe("732:21 group_card 规则提取", () => {
    const uinOf = (uid: string): number => (uid === "u_OP" ? 10001 : 0);

    it("命中：strings [群号, uid, 新值, 旧值] → group_card 事件（uid → uin）", () => {
        const rec = recognizeOb11SysMsg(732, 21);
        if (rec.kind !== "notice") {
            throw new Error("expected notice");
        }
        const tree =
            decodeProtoTree(cardChangeBlob("1101729931", "u_OP", "新名片", "旧名片")) ?? [];
        const env = extractSysMsgEnvelope(tree);
        const event = rec.rule.extract(tree, env, uinOf, { selfUin: 3567141148, time: 1793540000 });
        expect(event).toMatchObject({
            time: 1793540000,
            self_id: 3567141148,
            post_type: "notice",
            notice_type: "group_card",
            group_id: 1101729931,
            user_id: 10001,
            card_new: "新名片",
            card_old: "旧名片",
        });
    });

    it("collectUids 声明 = 对象 uid（提取前批量解析）", () => {
        const rec = recognizeOb11SysMsg(732, 21);
        if (rec.kind !== "notice") {
            throw new Error("expected notice");
        }
        const tree = decodeProtoTree(cardChangeBlob("1101729931", "u_OP", "A", "B")) ?? [];
        const env = extractSysMsgEnvelope(tree);
        expect(rec.rule.collectUids?.(tree, env)).toEqual(["u_OP"]);
    });

    it("判别式拒收：群号非数字 / 对象非 uid 形 → null（降级校准日志）", () => {
        const rec = recognizeOb11SysMsg(732, 21);
        if (rec.kind !== "notice") {
            throw new Error("expected notice");
        }
        const bad1 = decodeProtoTree(cardChangeBlob("not-a-group", "u_OP", "A", "B")) ?? [];
        const bad2 = decodeProtoTree(cardChangeBlob("1101729931", "plain-text", "A", "B")) ?? [];
        const env1 = extractSysMsgEnvelope(bad1);
        const env2 = extractSysMsgEnvelope(bad2);
        const ctx = { selfUin: 1, time: 1 };
        expect(rec.rule.extract(bad1, env1, uinOf, ctx)).toBeNull();
        expect(rec.rule.extract(bad2, env2, uinOf, ctx)).toBeNull();
    });

    it("注入合成表仍走通用识别（协议无关核心）", () => {
        const rule: SysMsgKindRuleOB11 = { kind: "group_card", extract: () => null };
        const table = new Map([["1:2", rule]]);
        const rec = recognizeOb11SysMsg(1, 2, table);
        expect(rec).toEqual({ kind: "notice", rule });
    });
});
