/**
 * load-config.test.ts：协议配置段读取单测（2026-10-25 内联配置接入）。
 *
 * 覆盖：内联优先级矩阵（NAPKETTO_CONFIG_JSON > NAPKETTO_CONFIG > NAPUTO_CFG_DIR
 * 兜底）、内联生效不读任何 toml 文件（cfgFile = "<inline>" 哨兵）、按登录 uin
 * 取协议段、内联 JSON 坏值宽松回退文件形态、空串/纯空白/大小写别名不识别。
 * env 是模块加载期快照——每用例 resetModules 后重导（与 log-cfg.test.ts 同法）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelLike } from "../types.js";

type LoadConfigModule = typeof import("../load-config.js");

/** 本用例涉及的 env 键（用例内显式置空，隔离宿主环境残留）。 */
const ENV_KEYS = ["NAPKETTO_CONFIG", "NAPKETTO_CONFIG_JSON", "NAPUTO_CFG_DIR"];

let tmp = "";

function freshDir(): string {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-loadcfg-test-"));
    return tmp;
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

/** 设定 env 快照后重载 load-config 模块。 */
async function freshLoadConfig(env: Record<string, string | undefined>): Promise<LoadConfigModule> {
    for (const key of ENV_KEYS) {
        setEnv(key, env[key]);
    }
    vi.resetModules();
    return await import("../load-config.js");
}

const ALIAS_CONFIG_KEY = "NAPKETTO_CONFIG_json";

/** kernel 桩：parseToml 返回固定文档（文件分支只走桩，不依赖 smol-toml）。 */
function stubKernel(doc: Record<string, unknown>): KernelLike {
    return { parseToml: () => doc } as unknown as KernelLike;
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
    // 别名键：POSIX 用例可能中途断言失败，统一兜底清理（Windows 上未设置，删除无害）
    delete process.env[ALIAS_CONFIG_KEY];
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

/** 两账号文档（10001 带 kurobot + ob11；10002 空协议）。 */
const accountsDoc = (kurobotUrl: string): Record<string, unknown> => ({
    accounts: [
        {
            qq: "10001",
            onebot11: { token: "t1" },
            kurobot: { url: kurobotUrl },
        },
        { qq: "10002" },
    ],
});

describe("loadProtocolSections 内联分支", () => {
    it("内联生效：按 uin 取段，cfgFile 为 <inline> 哨兵，不读任何 toml 文件", async () => {
        const mod = await freshLoadConfig({
            NAPKETTO_CONFIG_JSON: JSON.stringify(accountsDoc("ws://inline:9000")),
            NAPKETTO_CONFIG: join(freshDir(), "不存在.toml"),
        });
        const sections = mod.loadProtocolSections(stubKernel({}), "10001");
        expect(sections.cfgFile).toBe("<inline>");
        expect(sections.ob11Section).toEqual({ token: "t1" });
        expect(sections.kurobotSection).toEqual({ url: "ws://inline:9000" });
        expect(sections.satoriSection).toEqual({});
    });

    it("内联优先级高于 NAPKETTO_CONFIG 文件（文件内容不同的账号也不串）", async () => {
        const cfgFile = join(freshDir(), "napuketto.toml");
        writeFileSync(
            cfgFile,
            '[[accounts]]\nqq = "10001"\n[accounts.kurobot]\nurl = "ws://file:9000"\n',
        );
        const mod = await freshLoadConfig({
            NAPKETTO_CONFIG_JSON: JSON.stringify(accountsDoc("ws://inline:9000")),
            NAPKETTO_CONFIG: cfgFile,
        });
        const sections = mod.loadProtocolSections(stubKernel({ accounts: [] }), "10001");
        expect(sections.cfgFile).toBe("<inline>");
        expect(sections.kurobotSection).toEqual({ url: "ws://inline:9000" });
    });

    it("内联 JSON 解析失败：宽松回退文件形态（不阻塞引导）", async () => {
        const cfgFile = join(freshDir(), "napuketto.toml");
        writeFileSync(
            cfgFile,
            '[[accounts]]\nqq = "10001"\n[accounts.kurobot]\nurl = "ws://file:9000"\n',
        );
        const mod = await freshLoadConfig({
            NAPKETTO_CONFIG_JSON: "{not-json",
            NAPKETTO_CONFIG: cfgFile,
        });
        const sections = mod.loadProtocolSections(
            stubKernel({ accounts: [{ qq: "10001", kurobot: { url: "ws://file:9000" } }] }),
            "10001",
        );
        expect(sections.cfgFile).toBe(cfgFile);
        expect(sections.kurobotSection).toEqual({ url: "ws://file:9000" });
    });

    it("内联非 JSON 对象（数组）：回退文件形态", async () => {
        const mod = await freshLoadConfig({
            NAPKETTO_CONFIG_JSON: "[1,2,3]",
            NAPKETTO_CONFIG: join(freshDir(), "不存在.toml"),
        });
        const sections = mod.loadProtocolSections(stubKernel({}), "10001");
        expect(sections.cfgFile).not.toBe("<inline>");
        expect(sections.kurobotSection).toEqual({});
    });

    it("空串 / 纯空白视为未设置", async () => {
        const cfgFile = join(freshDir(), "napuketto.toml");
        writeFileSync(
            cfgFile,
            '[[accounts]]\nqq = "10001"\n[accounts.kurobot]\nurl = "ws://file:9000"\n',
        );
        for (const value of ["", "   "]) {
            const mod = await freshLoadConfig({
                NAPKETTO_CONFIG_JSON: value,
                NAPKETTO_CONFIG: cfgFile,
            });
            const sections = mod.loadProtocolSections(
                stubKernel({ accounts: [{ qq: "10001", kurobot: { url: "ws://file:9000" } }] }),
                "10001",
            );
            expect(sections.cfgFile).toBe(cfgFile);
        }
    });

    // 大小写别名（NAPKETTO_CONFIG_json）不识别：env 读取是精确键访问。
    // 仅 POSIX 可测——Windows 的 process.env 是大小写不敏感代理，别名键赋值
    // 直接改写原变量，物理上无法共存两个仅大小写不同的变量（宿主侧天然免疫）。
    it.runIf(process.platform !== "win32")("大小写别名拼写不识别（键名区分大小写）", async () => {
        const cfgFile = join(freshDir(), "napuketto.toml");
        writeFileSync(
            cfgFile,
            '[[accounts]]\nqq = "10001"\n[accounts.kurobot]\nurl = "ws://file:9000"\n',
        );
        setEnv(ALIAS_CONFIG_KEY, JSON.stringify(accountsDoc("ws://inline:9000")));
        // 别名不识别 → 走文件形态：NAPKETTO_CONFIG 指向临时文件（env 清理由 afterEach 兜底）
        setEnv("NAPKETTO_CONFIG", cfgFile);
        vi.resetModules();
        const mod = await import("../load-config.js");
        const sections = mod.loadProtocolSections(
            stubKernel({ accounts: [{ qq: "10001", kurobot: { url: "ws://file:9000" } }] }),
            "10001",
        );
        expect(sections.cfgFile).toBe(cfgFile);
        expect(sections.kurobotSection).toEqual({ url: "ws://file:9000" });
    });
});

describe("loadProtocolSections 文件分支（行为不回退）", () => {
    it("按 uin 匹配账号；未匹配账号 → 全空段", async () => {
        const cfgFile = join(freshDir(), "napuketto.toml");
        writeFileSync(cfgFile, "placeholder = true\n");
        const mod = await freshLoadConfig({ NAPKETTO_CONFIG: cfgFile });
        const hit = mod.loadProtocolSections(stubKernel(accountsDoc("ws://f:1")), "10002");
        expect(hit.cfgFile).toBe(cfgFile);
        expect(hit.ob11Section).toEqual({});
        const miss = mod.loadProtocolSections(stubKernel(accountsDoc("ws://f:1")), "99999");
        expect(miss.kurobotSection).toEqual({});
    });

    it("文件读取失败：空段 + 不抛错（宽松）", async () => {
        const mod = await freshLoadConfig({ NAPKETTO_CONFIG: join(freshDir(), "不存在.toml") });
        const sections = mod.loadProtocolSections(stubKernel({}), "10001");
        expect(sections.ob11Section).toEqual({});
        expect(sections.kurobotSection).toEqual({});
    });
});
