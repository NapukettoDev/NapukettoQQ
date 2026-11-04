/**
 * types.ts 测试：MediaError 类型语义（name / message / cause / 继承链）。
 */
import { describe, expect, it } from "vitest";
import { MediaError } from "../types.js";

describe("MediaError", () => {
    it("name 固定为 MediaError，message 透传", () => {
        const err = new MediaError("bad media");

        expect(err.name).toBe("MediaError");
        expect(err.message).toBe("bad media");
    });

    it("是 Error 的子类（instanceof 链完整）", () => {
        const err = new MediaError("x");

        expect(err instanceof MediaError).toBe(true);
        expect(err instanceof Error).toBe(true);
    });

    it("支持 ErrorOptions（cause 保留，供上游定位根因）", () => {
        const cause = new Error("inner failure");
        const err = new MediaError("outer", { cause });

        expect(err.cause).toBe(cause);
    });

    it("不带 options 时 cause 为 undefined", () => {
        expect(new MediaError("plain").cause).toBeUndefined();
    });
});
