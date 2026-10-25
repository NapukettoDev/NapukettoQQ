/**
 * util-config-error.test.ts：配置失败判定面单测（2026-10-25 嵌入式退出码契约）。
 *
 * loader 不静态依赖 kernel（运行期动态 import），ConfigError 契约按错误名
 * （name="ConfigError"）复刻：isConfigError 对 kernel 同名错误与 loader 复刻类
 * 都命中；bootstrapExitCode 是 self-host 退出码决策的唯一出口（78 / 1）。
 */
import { describe, expect, it } from "vitest";
import { bootstrapExitCode, ConfigError, isConfigError } from "../util.js";

describe("isConfigError（name 契约）", () => {
    it("loader 复刻类命中", () => {
        expect(isConfigError(new ConfigError("协议配置 kurobot 段校验失败"))).toBe(true);
    });

    it("kernel ConfigError（同名 Error）命中——跨包动态 import 场景", () => {
        const kernelShaped = new Error("配置文件校验失败: /x/napuketto.toml");
        kernelShaped.name = "ConfigError";
        expect(isConfigError(kernelShaped)).toBe(true);
    });

    it("普通 Error / KernelError / 非错误值不命中", () => {
        expect(isConfigError(new Error("协议装配失败"))).toBe(false);
        const kernelErr = new Error("发送失败");
        kernelErr.name = "KernelError";
        expect(isConfigError(kernelErr)).toBe(false);
        expect(isConfigError("ConfigError")).toBe(false);
        expect(isConfigError(null)).toBe(false);
    });
});

describe("bootstrapExitCode", () => {
    it("ConfigError 一族 → 78（EX_CONFIG，宿主据此免重启）", () => {
        expect(bootstrapExitCode(new ConfigError("协议配置 onebot11 段校验失败"))).toBe(78);
    });

    it("其余运行时失败 → 1（现状不回退）", () => {
        expect(bootstrapExitCode(new Error("dlopen 失败"))).toBe(1);
        expect(bootstrapExitCode(undefined)).toBe(1);
    });
});
