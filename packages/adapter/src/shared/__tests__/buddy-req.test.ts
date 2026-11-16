/**
 * shared/buddy-req.test.ts：好友申请可处理性判定 + 去重单测（OB11 / Milky 共用）。
 *
 * 锁定 issue #122 的两道闸：
 *  - `isActionableBuddyReq` / `filterBuddyReqs`：已读、已处理、自己发起、批内未读数为 0
 *    与启动前历史积压一律不放行；字段缺失/非法（`reqTime` 归一为 0）放行。
 *  - `BuddyReqDedup`：`${friendUid}:${reqTime}` 只推一次，超上限按插入序淘汰。
 */

import type { BuddyReq } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import {
    BuddyReqDedup,
    batchUnreadNums,
    filterBuddyReqs,
    isActionableBuddyReq,
} from "../buddy-req.js";

/** 启动基准（固定时刻，便于构造「基准前 / 基准后」样本）。 */
const BASELINE = 1_794_307_394;

/** 构造好友申请（默认：刚到的未读申请）。 */
function makeReq(overrides: Partial<BuddyReq> = {}): BuddyReq {
    return { reqTime: String(BASELINE + 10), friendUid: "u-1", ...overrides };
}

describe("isActionableBuddyReq（可处理性判定）", () => {
    it("实时未读申请 → 放行", () => {
        expect(isActionableBuddyReq(makeReq(), BASELINE)).toBe(true);
    });

    it("isInitiator=true（自己发起）→ 丢弃", () => {
        expect(isActionableBuddyReq(makeReq({ isInitiator: true }), BASELINE)).toBe(false);
    });

    it("isUnread=false（已读，历史重放主体）→ 丢弃", () => {
        expect(isActionableBuddyReq(makeReq({ isUnread: false }), BASELINE)).toBe(false);
        // true / 缺失都放行（字段语义未实证，不能因缺字段丢申请）
        expect(isActionableBuddyReq(makeReq({ isUnread: true }), BASELINE)).toBe(true);
    });

    it("unreadNums=0（number 或数字串）→ 丢弃；非 0 / 缺失放行", () => {
        expect(isActionableBuddyReq(makeReq({ unreadNums: 0 }), BASELINE)).toBe(false);
        expect(isActionableBuddyReq(makeReq({ unreadNums: "0" }), BASELINE)).toBe(false);
        expect(isActionableBuddyReq(makeReq({ unreadNums: 1 }), BASELINE)).toBe(true);
        expect(isActionableBuddyReq(makeReq(), BASELINE)).toBe(true);
    });

    it("显式 isUnread=true 的项不被 unreadNums=0 误杀（防错杀真实申请）", () => {
        expect(isActionableBuddyReq(makeReq({ isUnread: true, unreadNums: 0 }), BASELINE)).toBe(
            true,
        );
    });

    it("isDecide=true → 丢弃，但 reqType=13（等对方确认）仍放行", () => {
        expect(isActionableBuddyReq(makeReq({ isDecide: true, reqType: 1 }), BASELINE)).toBe(false);
        expect(isActionableBuddyReq(makeReq({ isDecide: true, reqType: 13 }), BASELINE)).toBe(true);
        expect(isActionableBuddyReq(makeReq({ isDecide: false }), BASELINE)).toBe(true);
    });

    it("reqTime 早于启动基准 → 丢弃（秒 / 毫秒两种量级都识别）", () => {
        // 登录 / 重连同步进来的历史积压
        expect(isActionableBuddyReq(makeReq({ reqTime: String(BASELINE - 1) }), BASELINE)).toBe(
            false,
        );
        expect(
            isActionableBuddyReq(makeReq({ reqTime: String((BASELINE - 60) * 1000) }), BASELINE),
        ).toBe(false);
        // 基准本身 / 之后放行
        expect(isActionableBuddyReq(makeReq({ reqTime: String(BASELINE) }), BASELINE)).toBe(true);
        expect(
            isActionableBuddyReq(makeReq({ reqTime: String((BASELINE + 5) * 1000) }), BASELINE),
        ).toBe(true);
    });

    it("reqTime 非时间（归一为 0）→ 放行（宁可多报不可错杀）", () => {
        expect(isActionableBuddyReq(makeReq({ reqTime: "0" }), BASELINE)).toBe(true);
        expect(isActionableBuddyReq(makeReq({ reqTime: "abc" }), BASELINE)).toBe(true);
    });
});

describe("filterBuddyReqs（批量过滤）", () => {
    it("保持输入顺序，只留实时待处理项", () => {
        const reqs = [
            makeReq({ friendUid: "keep-1" }),
            makeReq({ friendUid: "old", reqTime: String(BASELINE - 3600) }),
            makeReq({ friendUid: "read", isUnread: false }),
            makeReq({ friendUid: "keep-2", reqTime: String((BASELINE + 3) * 1000) }),
        ];
        expect(filterBuddyReqs(reqs, BASELINE).map((r) => r.friendUid)).toEqual([
            "keep-1",
            "keep-2",
        ]);
    });

    it("空列表 → 空列表", () => {
        expect(filterBuddyReqs([], BASELINE)).toEqual([]);
    });
});

describe("batchUnreadNums（批级未读数）", () => {
    it("对象带 number → 原值；0 用于整批短路", () => {
        expect(batchUnreadNums({ buddyReqs: [], unreadNums: 0 })).toBe(0);
        expect(batchUnreadNums({ buddyReqs: [], unreadNums: 3 })).toBe(3);
    });

    it("裸数组 / 字段缺失 / 数字串 / 非法值 → undefined（不下判断）", () => {
        expect(batchUnreadNums([makeReq()])).toBeUndefined();
        expect(batchUnreadNums({ buddyReqs: [] })).toBeUndefined();
        expect(batchUnreadNums({ unreadNums: "0" })).toBeUndefined();
        expect(batchUnreadNums({ unreadNums: Number.NaN })).toBeUndefined();
        expect(batchUnreadNums("junk")).toBeUndefined();
        expect(batchUnreadNums(null)).toBeUndefined();
    });
});

describe("BuddyReqDedup（去重）", () => {
    it("同一 `friendUid:reqTime` 首次 true、重复 false", () => {
        const dedup = new BuddyReqDedup();
        const req = makeReq();
        expect(dedup.claim(req)).toBe(true);
        expect(dedup.claim(req)).toBe(false);
        expect(dedup.claim({ ...req })).toBe(false);
    });

    it("friendUid 或 reqTime 不同 → 视为不同申请", () => {
        const dedup = new BuddyReqDedup();
        expect(dedup.claim(makeReq({ friendUid: "u-1" }))).toBe(true);
        expect(dedup.claim(makeReq({ friendUid: "u-2" }))).toBe(true);
        expect(dedup.claim(makeReq({ friendUid: "u-1", reqTime: "1794307405" }))).toBe(true);
    });

    it("超上限按插入序淘汰最旧项（无界增长防护）", () => {
        const dedup = new BuddyReqDedup(2);
        const first = makeReq({ friendUid: "a" });
        expect(dedup.claim(first)).toBe(true);
        expect(dedup.claim(makeReq({ friendUid: "b" }))).toBe(true);
        // 第三条挤掉 a；再次看到 a 视为新申请（极旧请求已先被 reqTime 基准拦掉）
        expect(dedup.claim(makeReq({ friendUid: "c" }))).toBe(true);
        expect(dedup.claim(first)).toBe(true);
        expect(dedup.claim(makeReq({ friendUid: "c" }))).toBe(false);
    });
});
