/**
 * stranger-info.ts 基线测试（fallow refactoring target #1，untested risk）
 *
 * 锁定 flattenStrangerInfo 宽松取值行为，重构后回归：
 *  - info（uid 完整详情）优先，字段缺失回退 byUin（uin 初查详情）
 *  - 两份都缺 → 默认值（"" / 0 / false / "unknown" / login_days 恒 0）
 *  - sex 数值映射：1=male 2=female 其余 unknown
 */
import { describe, expect, it } from "vitest";
import type { UserDetailInfoByUin } from "../../../types/index.js";
import { flattenStrangerInfo } from "../stranger-info.js";

/** 构造详情（detail 为可选对象，缺字段即缺失）。 */
function detail(partial: UserDetailInfoByUin["detail"]): UserDetailInfoByUin {
    return partial === undefined ? {} : { detail: partial };
}

describe("flattenStrangerInfo", () => {
    it("info 完整时全部取 info", () => {
        const byUin = detail({ uid: "u_old", simpleInfo: { coreInfo: { nick: "旧昵称" } } });
        const info = detail({
            uid: "u_new",
            simpleInfo: {
                coreInfo: { nick: "新昵称", remark: "备注" },
                baseInfo: { age: 25, qid: "q1", sex: 1, longNick: "签名" },
                vasInfo: { svipFlag: true, yearVipFlag: false, vipLevel: 7 },
                status: { status: 1 },
            },
            commonExt: { qqLevel: 5, regTime: 12345 },
        });
        expect(flattenStrangerInfo("10001", "u_new", byUin, info)).toEqual({
            user_id: 10001,
            uid: "u_new",
            nickname: "新昵称",
            age: 25,
            qid: "q1",
            qq_level: 5,
            sex: "male",
            long_nick: "签名",
            reg_time: 12345,
            is_vip: true,
            is_years_vip: false,
            vip_level: 7,
            remark: "备注",
            status: 1,
            login_days: 0,
        });
    });

    it("info 缺失字段回退 byUin", () => {
        const byUin = detail({
            uid: "u_old",
            simpleInfo: {
                coreInfo: { nick: "旧昵称", remark: "旧备注" },
                baseInfo: { age: 18, qid: "q_old", sex: 2, longNick: "旧签名" },
                vasInfo: { svipFlag: false, yearVipFlag: true, vipLevel: 3 },
                status: { status: 2 },
            },
            commonExt: { qqLevel: 1, regTime: 999 },
        });
        const info = detail({ uid: "u_new" });
        expect(flattenStrangerInfo("10001", "u_new", byUin, info)).toEqual({
            user_id: 10001,
            uid: "u_new",
            nickname: "旧昵称",
            age: 18,
            qid: "q_old",
            qq_level: 1,
            sex: "female",
            long_nick: "旧签名",
            reg_time: 999,
            is_vip: false,
            is_years_vip: true,
            vip_level: 3,
            remark: "旧备注",
            status: 2,
            login_days: 0,
        });
    });

    it("两份详情都缺 → 默认值", () => {
        expect(flattenStrangerInfo("10001", "u_1", {}, {})).toEqual({
            user_id: 10001,
            uid: "u_1",
            nickname: "",
            age: 0,
            qid: "",
            qq_level: 0,
            sex: "unknown",
            long_nick: "",
            reg_time: 0,
            is_vip: false,
            is_years_vip: false,
            vip_level: 0,
            remark: "",
            status: 0,
            login_days: 0,
        });
    });

    it("sex 映射：1=male 2=female 其余 unknown", () => {
        const mk = (sex: number | undefined) => {
            const baseInfo = sex === undefined ? {} : { sex };
            return flattenStrangerInfo("1", "u", {}, detail({ simpleInfo: { baseInfo } }));
        };
        expect(mk(1).sex).toBe("male");
        expect(mk(2).sex).toBe("female");
        expect(mk(3).sex).toBe("unknown");
        expect(mk(undefined).sex).toBe("unknown");
    });

    it("status 字段级回退：info 有 status 对象但字段缺 → 用 byUin", () => {
        const byUin = detail({ simpleInfo: { status: { status: 7 } } });
        const info = detail({ simpleInfo: { status: {} } });
        expect(flattenStrangerInfo("1", "u", byUin, info).status).toBe(7);
    });
});
