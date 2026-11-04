/**
 * errors.ts 测试：KernelError / ConfigError 错误形态契约（协议层映射与退出码依据）。
 */
import { describe, expect, it } from "vitest";
import {
    ConfigError,
    configError,
    EXIT_CONFIG_INVALID,
    isKernelError,
    KERNEL_ERROR_CODES,
    KernelError,
    kernelError,
} from "../errors.js";

describe("KernelError", () => {
    it("默认 code=UNKNOWN、name=KernelError", () => {
        const err = new KernelError("出错了");
        expect(err.code).toBe("UNKNOWN");
        expect(err.name).toBe("KernelError");
        expect(err).toBeInstanceOf(Error);
    });

    it("携带错误码与 cause（原生异常链保留）", () => {
        const cause = new Error("root");
        const err = new KernelError("原生失败", "NOT_FOUND", { cause });
        expect(err.code).toBe("NOT_FOUND");
        expect(err.cause).toBe(cause);
    });

    it("kernelError 便捷构造同形态", () => {
        const err = kernelError("参数坏", "INVALID_PARAM");
        expect(err).toBeInstanceOf(KernelError);
        expect(err.message).toBe("参数坏");
        expect(err.code).toBe("INVALID_PARAM");
    });
});

describe("错误码集合", () => {
    it("8 个错误码（协议层映射表可推导）", () => {
        expect(KERNEL_ERROR_CODES).toHaveLength(8);
        expect(KERNEL_ERROR_CODES).toContain("SEND_FAILED");
        expect(KERNEL_ERROR_CODES).toContain("NOT_LOGIN");
        expect(KERNEL_ERROR_CODES).toContain("INVALID_STATE");
    });
});

describe("isKernelError 类型守卫", () => {
    it("KernelError / 子类 → true；普通 Error / 非 Error → false", () => {
        expect(isKernelError(new KernelError("x"))).toBe(true);
        expect(isKernelError(configError("y"))).toBe(true);
        expect(isKernelError(new Error("z"))).toBe(false);
        expect(isKernelError("str")).toBe(false);
        expect(isKernelError(null)).toBe(false);
    });
});

describe("ConfigError", () => {
    it("是 KernelError 子型；code 恒 INVALID_PARAM、name 恒 ConfigError", () => {
        const err = new ConfigError("配置缺失");
        expect(err).toBeInstanceOf(KernelError);
        expect(err.code).toBe("INVALID_PARAM");
        expect(err.name).toBe("ConfigError");
        expect(err.message).toBe("配置缺失");
    });

    it("configError 便捷构造带 cause", () => {
        const cause = new Error("zod");
        const err = configError("校验失败", { cause });
        expect(err.cause).toBe(cause);
    });

    it("退出码常量 = 78（EX_CONFIG）", () => {
        expect(EXIT_CONFIG_INVALID).toBe(78);
    });
});
