/**
 * error.test.ts：CLI 错误出口契约单测（2026-10-25 退出码；2026-11 预期错误去堆栈）。
 *
 * handleActionError 按错误类型设退出码：ConfigError → 78（EX_CONFIG 惯例，
 * 宿主消费，免重启）；其余 → 1（运行时崩溃，现状不回退）。判定只认类型，
 * 不耦合错误文案。
 *
 * 日志契约：预期错误（ConfigError / KernelError INVALID_PARAM）单行输出
 * err → cause 消息链，只带 errorType/code 字段；完整 err 降级到 debug。
 * 预期外错误保持 { err } + message。
 */
import process from "node:process";
import { ConfigError, KernelError } from "@napuketto/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../logger.js";
import { handleActionError } from "./error.js";

afterEach(() => {
    process.exitCode = 0;
    vi.clearAllMocks();
});

describe("handleActionError 退出码映射", () => {
    it("ConfigError（含内核包装形态）→ 78", () => {
        handleActionError(new ConfigError("内联配置 JSON 解析失败: ..."));
        expect(process.exitCode).toBe(78);
        handleActionError(new ConfigError('主配置账号 qq "123456" 是模板占位值'));
        expect(process.exitCode).toBe(78);
    });

    it("KernelError 非 ConfigError / 普通 Error → 1（现状不变）", () => {
        handleActionError(new KernelError("发送失败", "SEND_FAILED"));
        expect(process.exitCode).toBe(1);
        handleActionError(new KernelError("数据目录被占用", "INVALID_STATE"));
        expect(process.exitCode).toBe(1);
        handleActionError(new Error("定位/下载 QQ 原生文件失败"));
        expect(process.exitCode).toBe(1);
    });
});

describe("handleActionError 日志输出", () => {
    it("ConfigError：err → cause 拼成单行，不传 { err }，堆栈降级 debug", () => {
        const cause = new ConfigError(
            '主配置账号 qq "123456" 是模板占位值，请编辑配置文件填入真实 QQ 号后再启动',
        );
        const err = new ConfigError("配置文件校验失败: C:\\x\\napuketto.toml", { cause });

        handleActionError(err);

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            { errorType: "ConfigError", code: "INVALID_PARAM" },
            '配置文件校验失败: C:\\x\\napuketto.toml — 主配置账号 qq "123456" 是模板占位值，请编辑配置文件填入真实 QQ 号后再启动',
        );
        expect(logger.debug).toHaveBeenCalledWith({ err }, "详细错误堆栈");
        expect(process.exitCode).toBe(78);
    });

    it("KernelError INVALID_PARAM：同样去堆栈，退出码仍为 1（不升级为配置失败）", () => {
        const err = new KernelError("外部配置 not.toml 不是合法 toml", "INVALID_PARAM", {
            cause: new Error("Invalid TOML document"),
        });

        handleActionError(err);

        expect(logger.error).toHaveBeenCalledWith(
            { errorType: "KernelError", code: "INVALID_PARAM" },
            "外部配置 not.toml 不是合法 toml — Invalid TOML document",
        );
        expect(logger.debug).toHaveBeenCalledWith({ err }, "详细错误堆栈");
        expect(process.exitCode).toBe(1);
    });

    it("多级 cause 与换行折叠为单行", () => {
        const root = new Error("字段 log.level 必须是字符串\n实际类型: number");
        const middle = new ConfigError("主配置 [log] 段非法: 字段 log.level 必须是字符串", {
            cause: root,
        });
        const err = new ConfigError("配置文件校验失败: napuketto.toml", { cause: middle });

        handleActionError(err);

        expect(logger.error).toHaveBeenCalledWith(
            { errorType: "ConfigError", code: "INVALID_PARAM" },
            "配置文件校验失败: napuketto.toml — 主配置 [log] 段非法: 字段 log.level 必须是字符串 — 字段 log.level 必须是字符串 实际类型: number",
        );
    });

    it("预期外 KernelError / 普通 Error：保持 { err } + message，不降级 debug", () => {
        const sendErr = new KernelError("发送失败", "SEND_FAILED");
        handleActionError(sendErr);
        expect(logger.error).toHaveBeenCalledWith({ err: sendErr }, "发送失败");

        const plainErr = new Error("定位/下载 QQ 原生文件失败");
        handleActionError(plainErr);
        expect(logger.error).toHaveBeenCalledWith({ err: plainErr }, "定位/下载 QQ 原生文件失败");

        expect(logger.debug).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
    });

    it("非 Error 抛出值：保持 { err } + String(err)", () => {
        handleActionError("boom");

        expect(logger.error).toHaveBeenCalledWith({ err: "boom" }, "boom");
        expect(logger.debug).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
    });
});
