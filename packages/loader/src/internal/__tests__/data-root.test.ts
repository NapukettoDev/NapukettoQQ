/**
 * data-root.test.ts：数据根解析单测（data-root.ts resolveDataRoot）。
 *
 * 覆盖：
 *  - 显式参数（相对路径 resolve 为绝对 / `~` 展开）
 *  - NAPUKETTO_DATA 新前缀优先、NAPKETTO_DATA 旧前缀回退
 *  - 项目根探测：cwd 向上找 pnpm-workspace.yaml / package.json → <root>/.napuketto
 *  - 无标记目录 → 用户目录兜底（与 kernel resolveDataRoot 同语义）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDataRoot } from "../data-root.js";

let tmpRoot = "";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** 把 process.cwd 指到临时目录（findProjectRoot 从 cwd 向上探测）。 */
function withCwd(dir: string): void {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
}

describe("resolveDataRoot", () => {
    it("显式参数优先（相对路径 resolve 为绝对）", () => {
        const root = resolveDataRoot("rel/data");
        expect(root).toBe(resolve("rel/data"));
    });

    it("显式参数支持 ~ 展开（与 kernel 同语义）", () => {
        expect(resolveDataRoot("~/data")).toBe(join(homedir(), "data"));
        expect(resolveDataRoot("~")).toBe(homedir());
    });

    it("无参数时读 NAPKETTO_DATA（旧前缀回退）", () => {
        vi.stubEnv("NAPKETTO_DATA", "env/data");
        expect(resolveDataRoot()).toBe(resolve("env/data"));
    });

    it("NAPUKETTO_DATA 优先于 NAPKETTO_DATA", () => {
        vi.stubEnv("NAPUKETTO_DATA", "new/data");
        vi.stubEnv("NAPKETTO_DATA", "old/data");
        expect(resolveDataRoot()).toBe(resolve("new/data"));
    });

    it("NAPKETTO_DATA 为空串 → 走项目根探测（不算显式值）", () => {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-dataroot-test-"));
        withCwd(tmpRoot);
        vi.stubEnv("NAPKETTO_DATA", "");
        expect(resolveDataRoot()).toBe(join(homedir(), ".napuketto"));
    });

    it("cwd 有 package.json → 项目根即 cwd，数据根 <cwd>/.napuketto", () => {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-dataroot-test-"));
        writeFileSync(join(tmpRoot, "package.json"), "{}", "utf8");
        withCwd(join(tmpRoot, "nested"));
        mkdirSync(join(tmpRoot, "nested"), { recursive: true });
        expect(resolveDataRoot()).toBe(join(tmpRoot, ".napuketto"));
    });

    it("cwd 有 pnpm-workspace.yaml → 同样命中项目根", () => {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-dataroot-test-"));
        writeFileSync(join(tmpRoot, "pnpm-workspace.yaml"), "", "utf8");
        const nested = join(tmpRoot, "a", "b");
        mkdirSync(nested, { recursive: true });
        withCwd(nested);
        expect(resolveDataRoot()).toBe(join(tmpRoot, ".napuketto"));
    });

    it("无任何项目根标记 → 用户目录兜底（对齐 kernel）", () => {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-dataroot-test-"));
        withCwd(tmpRoot);
        expect(existsSync(join(tmpRoot, "package.json"))).toBe(false);
        expect(resolveDataRoot()).toBe(join(homedir(), ".napuketto"));
    });
});
