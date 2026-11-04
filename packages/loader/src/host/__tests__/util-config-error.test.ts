/**
 * util-config-error.test.ts：配置失败判定面 + 公共工具单测。
 *
 * loader 不静态依赖 kernel（运行期动态 import），ConfigError 契约按错误名
 * （name="ConfigError"）复刻：isConfigError 对 kernel 同名错误与 loader 复刻类
 * 都命中；bootstrapExitCode 是 self-host 退出码决策的唯一出口（78 / 1）。
 * 另覆盖 errMsg / forEachRawMessage / createState（引导公共工具）。
 */
import { describe, expect, it } from "vitest";
import {
    bootstrapExitCode,
    ConfigError,
    convergeBootstrapFailure,
    createState,
    errMsg,
    forEachRawMessage,
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

describe("errMsg（错误信息提取，保留 JS 原语义）", () => {
    it("Error → message", () => {
        expect(errMsg(new Error("boom"))).toBe("boom");
    });

    it("带 message 的非 Error 对象 → message", () => {
        expect(errMsg({ message: "原生断言" })).toBe("原生断言");
    });

    it("无 message 对象 / 字符串 / 数字 → String(e)", () => {
        expect(errMsg({})).toBe("[object Object]");
        expect(errMsg("裸字符串")).toBe("裸字符串");
        expect(errMsg(42)).toBe("42");
    });

    it("null / undefined → String(e)", () => {
        expect(errMsg(null)).toBe("null");
        expect(errMsg(undefined)).toBe("undefined");
    });
});

describe("forEachRawMessage（onRecvMsg 参数逐条处理）", () => {
    it("数组：逐条回调，null/非对象项过滤", () => {
        const seen: unknown[] = [];
        forEachRawMessage([null, "str", { msgId: "1" }, { msgId: "2" }], (m) => seen.push(m));
        expect(seen).toEqual([{ msgId: "1" }, { msgId: "2" }]);
    });

    it("单条对象（兼容非数组回调参数）→ 包装后处理", () => {
        const seen: unknown[] = [];
        forEachRawMessage({ msgId: "solo" }, (m) => seen.push(m));
        expect(seen).toEqual([{ msgId: "solo" }]);
    });

    it("无效单条（null / 非对象）→ 不回调", () => {
        const seen: unknown[] = [];
        forEachRawMessage(null, (m) => seen.push(m));
        forEachRawMessage(42, (m) => seen.push(m));
        expect(seen).toHaveLength(0);
    });
});

describe("createState（共享状态初值）", () => {
    it("四字段零值（wrapperExports 空 / 无捕获实例 / 未引导）", () => {
        expect(createState()).toEqual({
            wrapperExports: null,
            qqSession: null,
            qqLoginService: null,
            bootstrapped: false,
        });
    });
});
