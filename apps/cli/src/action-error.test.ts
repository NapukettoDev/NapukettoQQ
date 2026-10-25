/**
 * action-error.test.ts：CLI 退出码契约单测（2026-10-25）。
 *
 * handleActionError 按错误类型设退出码：ConfigError → 78（EX_CONFIG 惯例，
 * 宿主消费，免重启）；其余 → 1（运行时崩溃，现状不回退）。判定只认类型，
 * 不耦合错误文案。
 */
import process from "node:process";
import { ConfigError, KernelError } from "@napuketto/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleActionError } from "./action-error.js";

afterEach(() => {
    process.exitCode = 0;
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
