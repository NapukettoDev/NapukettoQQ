/**
 * helper/error.test.ts：KernelErrorCode → HTTP 状态码映射单测（ADR-017）。
 *
 * 锁定：satoriHttpStatusMap 全码表值与 HTTP_STATUS 常量契约。
 */
import type { KernelErrorCode } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { HTTP_STATUS, satoriHttpStatusMap } from "../error.js";

describe("satoriHttpStatusMap", () => {
    it("NOT_FOUND → 404；PERMISSION_DENIED / NOT_LOGIN → 403", () => {
        expect(satoriHttpStatusMap.NOT_FOUND).toBe(404);
        expect(satoriHttpStatusMap.PERMISSION_DENIED).toBe(403);
        expect(satoriHttpStatusMap.NOT_LOGIN).toBe(403);
    });

    it("INVALID_PARAM → 400；发送/超时/状态/未知 → 500", () => {
        expect(satoriHttpStatusMap.INVALID_PARAM).toBe(400);
        expect(satoriHttpStatusMap.SEND_FAILED).toBe(500);
        expect(satoriHttpStatusMap.TIMEOUT).toBe(500);
        expect(satoriHttpStatusMap.INVALID_STATE).toBe(500);
        expect(satoriHttpStatusMap.UNKNOWN).toBe(500);
    });

    it("映射表覆盖全部 KernelErrorCode（防新增码漏登记）", () => {
        const codes: KernelErrorCode[] = [
            "SEND_FAILED",
            "PERMISSION_DENIED",
            "NOT_FOUND",
            "TIMEOUT",
            "NOT_LOGIN",
            "INVALID_PARAM",
            "INVALID_STATE",
            "UNKNOWN",
        ];
        for (const code of codes) {
            expect(satoriHttpStatusMap[code]).toEqual(expect.any(Number));
        }
    });
});

describe("HTTP_STATUS", () => {
    it("常量契约：200/400/401/403/404/501/500", () => {
        expect(HTTP_STATUS).toEqual({
            ok: 200,
            badRequest: 400,
            unauthorized: 401,
            forbidden: 403,
            notFound: 404,
            notImplemented: 501,
            serverError: 500,
        });
    });
});
