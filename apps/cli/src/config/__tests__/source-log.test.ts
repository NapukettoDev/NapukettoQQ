/**
 * source-log.test.ts：内联配置来源日志的 env 键名（2026-11 前缀统一兼容期）。
 *
 * 旧前缀 NAPKETTO_CONFIG_JSON 仍双读回退，来源日志必须输出实际命中的键名，
 * 否则排查时按日志写死的新名去核对环境变量会对不上。store 的 sourceLogged
 * 每进程一行，故本文件用 resetModules 让每条用例拿到全新模块状态。
 */
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INLINE_DOC = '{"accounts":[{"qq":"10086"}]}';

let onInfo: (msgOrObj: unknown, msg?: string) => void;

beforeEach(() => {
    vi.resetModules();
    delete process.env["NAPKETTO_CONFIG_JSON"];
    delete process.env["NAPUKETTO_CONFIG_JSON"];
    onInfo = vi.fn();
});

afterEach(() => {
    delete process.env["NAPKETTO_CONFIG_JSON"];
    delete process.env["NAPUKETTO_CONFIG_JSON"];
});

/** 按当前 env 重新加载 store 并取来源日志。 */
async function loadWithFreshStore(): Promise<void> {
    const { loadCliConfigWithSource } = await import("../store.js");
    await loadCliConfigWithSource({ onInfo });
}

describe("配置来源日志 env 键名", () => {
    it("新前缀命中 → 日志输出 NAPUKETTO_CONFIG_JSON", async () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = INLINE_DOC;
        await loadWithFreshStore();
        expect(onInfo).toHaveBeenCalledWith("配置来源: inline（NAPUKETTO_CONFIG_JSON）");
    });

    it("仅旧前缀命中 → 日志输出 NAPKETTO_CONFIG_JSON", async () => {
        process.env["NAPKETTO_CONFIG_JSON"] = INLINE_DOC;
        await loadWithFreshStore();
        expect(onInfo).toHaveBeenCalledWith("配置来源: inline（NAPKETTO_CONFIG_JSON）");
    });

    it("新旧同时设置 → 新前缀优先，日志输出新键名", async () => {
        process.env["NAPKETTO_CONFIG_JSON"] = INLINE_DOC;
        process.env["NAPUKETTO_CONFIG_JSON"] = INLINE_DOC;
        await loadWithFreshStore();
        expect(onInfo).toHaveBeenCalledWith("配置来源: inline（NAPUKETTO_CONFIG_JSON）");
    });
});
