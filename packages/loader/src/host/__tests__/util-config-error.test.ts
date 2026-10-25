/**
 * util-config-error.test.ts：配置失败判定面单测（2026-10-25 嵌入式退出码契约）。
 *
 * loader 不静态依赖 kernel（运行期动态 import），ConfigError 契约按错误名
 * （name="ConfigError"）复刻：isConfigError 对 kernel 同名错误与 loader 复刻类
 * 都命中；bootstrapExitCode 是 self-host 退出码决策的唯一出口（78 / 1）。
 */
import { describe, expect, it } from "vitest";
import {
    bootstrapExitCode,
    ConfigError,
    convergeBootstrapFailure,
    isConfigError,
} from "../util.js";

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

describe("convergeBootstrapFailure（2026-10-25 吞异常修复）", () => {
    it("ConfigError 原样重抛——78 链路不得被任何 catch 吞掉", () => {
        const err = new ConfigError("协议配置 kurobot 段校验失败");
        expect(() => convergeBootstrapFailure(err, "lifecycle error")).toThrow(err);
    });

    it("kernel ConfigError（同名 Error）同样重抛——跨包契约不受 instanceof 限制", () => {
        const kernelShaped = new Error("配置文件校验失败");
        kernelShaped.name = "ConfigError";
        expect(() => convergeBootstrapFailure(kernelShaped, "import kernel failed")).toThrow(
            kernelShaped,
        );
    });

    it("普通错误不抛且返回 false（记日志后收敛，引导失败不升级为崩溃）", () => {
        const boom = new Error("dlopen 失败");
        expect(() => convergeBootstrapFailure(boom, "lifecycle error")).not.toThrow();
        expect(convergeBootstrapFailure(boom, "lifecycle error")).toBe(false);
    });
});
