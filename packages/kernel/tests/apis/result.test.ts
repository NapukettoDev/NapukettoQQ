/**
 * result.ts 基线测试（fallow refactoring target #1，untested risk）
 * 锁定 unwrap / checkLooseResult / unwrapResult 现有行为，重构后回归。
 */
import { describe, expect, it } from "vitest";
import { checkLooseResult, unwrap, unwrapResult } from "../../src/apis/result.js";
import { isKernelError } from "../../src/infra/index.js";

describe("unwrap", () => {
    it("result=0 不抛", () => {
        expect(() => unwrap("sendMsg", 0)).not.toThrow();
    });

    it("result 非 0 抛 KernelError（无 errMsg 用默认文案）", () => {
        try {
            unwrap("sendMsg", 1);
            expect.unreachable("应抛出");
        } catch (e) {
            expect(isKernelError(e)).toBe(true);
            expect(e).toMatchObject({ code: "UNKNOWN", message: "sendMsg 失败: 无错误详情" });
        }
    });

    it("result 非 0 附带 errMsg", () => {
        try {
            unwrap("sendMsg", -1, "发送超时");
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ message: "sendMsg 失败: 发送超时" });
        }
    });
});

describe("checkLooseResult", () => {
    it("undefined / null / 非数字 / 0 均视为成功", () => {
        expect(() => checkLooseResult("getGroupInfo", undefined)).not.toThrow();
        expect(() => checkLooseResult("getGroupInfo", null)).not.toThrow();
        expect(() => checkLooseResult("getGroupInfo", {})).not.toThrow();
        expect(() => checkLooseResult("getGroupInfo", { result: 0 })).not.toThrow();
    });

    it("result 为数字非 0 抛 KernelError", () => {
        try {
            checkLooseResult("getGroupInfo", { result: 1, errMsg: "群不存在" });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(isKernelError(e)).toBe(true);
            expect(e).toMatchObject({ code: "UNKNOWN", message: "getGroupInfo 失败: 群不存在" });
        }
    });

    it("errMsg 缺失时文案为空串", () => {
        try {
            checkLooseResult("getGroupInfo", { result: 2 });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ message: "getGroupInfo 失败: " });
        }
    });
});

describe("unwrapResult", () => {
    it("result=0 不抛", () => {
        expect(() => unwrapResult("sendMsg", { result: 0, errMsg: "" })).not.toThrow();
    });

    it("errMsg 缺省用「无错误详情」，sendMsg 兜底 SEND_FAILED", () => {
        try {
            unwrapResult("sendMsg", { result: 1, errMsg: "" });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ code: "SEND_FAILED", message: "sendMsg 失败: 无错误详情" });
        }
    });

    it("非 sendMsg 且 errMsg 缺失 → UNKNOWN", () => {
        try {
            unwrapResult("kick", { result: 1, errMsg: "" });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ code: "UNKNOWN" });
        }
    });

    it("未登录 → NOT_LOGIN（中文与英文均命中）", () => {
        for (const msg of ["账号未登录", "not login yet"]) {
            try {
                unwrapResult("sendMsg", { result: 1, errMsg: msg });
                expect.unreachable("应抛出");
            } catch (e) {
                expect(e).toMatchObject({ code: "NOT_LOGIN" });
            }
        }
    });

    it("无权限 → PERMISSION_DENIED（中文与英文均命中）", () => {
        for (const msg of ["无权限操作", "permission denied"]) {
            try {
                unwrapResult("kick", { result: 1, errMsg: msg });
                expect.unreachable("应抛出");
            } catch (e) {
                expect(e).toMatchObject({ code: "PERMISSION_DENIED" });
            }
        }
    });

    it("不存在 → NOT_FOUND（中文与英文均命中）", () => {
        for (const msg of ["群不存在", "message not found"]) {
            try {
                unwrapResult("getMsg", { result: 1, errMsg: msg });
                expect.unreachable("应抛出");
            } catch (e) {
                expect(e).toMatchObject({ code: "NOT_FOUND" });
            }
        }
    });

    it("sendMsg 其他失败 → SEND_FAILED", () => {
        try {
            unwrapResult("sendMsg", { result: 1, errMsg: "风控拦截" });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ code: "SEND_FAILED" });
        }
    });

    it("非 sendMsg 其他失败 → UNKNOWN", () => {
        try {
            unwrapResult("kick", { result: 1, errMsg: "服务端错误" });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ code: "UNKNOWN" });
        }
    });

    it("语义码优先级高于 sendMsg 兜底（未登录在 sendMsg 下仍是 NOT_LOGIN）", () => {
        try {
            unwrapResult("sendMsg", { result: 1, errMsg: "未登录" });
            expect.unreachable("应抛出");
        } catch (e) {
            expect(e).toMatchObject({ code: "NOT_LOGIN" });
        }
    });
});
