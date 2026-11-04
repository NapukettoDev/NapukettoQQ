/**
 * data-root.test.ts：数据根解析单测（data-root.ts resolveDataRoot）。
 *
 * 覆盖：
 *  - 显式参数（相对路径 resolve 为绝对）
 *  - NAPKETTO_DATA 环境变量兜底
 *  - 项目根探测：cwd 向上找 pnpm-workspace.yaml / package.json → <root>/.napuketto
 *  - 无标记目录 → cwd 自身作项目根
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDataRoot } from "./data-root.js";

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

    it("无参数时读 NAPKETTO_DATA", () => {
        vi.stubEnv("NAPKETTO_DATA", "env/data");
        expect(resolveDataRoot()).toBe(resolve("env/data"));
    });

    it("NAPKETTO_DATA 为空串 → 走项目根探测（不算显式值）", () => {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-dataroot-test-"));
        withCwd(tmpRoot);
        vi.stubEnv("NAPKETTO_DATA", "");
        expect(resolveDataRoot()).toBe(join(tmpRoot, ".napuketto"));
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

    it("无任何项目根标记 → cwd 自身作项目根兜底", () => {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-dataroot-test-"));
        withCwd(tmpRoot);
        expect(existsSync(join(tmpRoot, "package.json"))).toBe(false);
        expect(resolveDataRoot()).toBe(join(tmpRoot, ".napuketto"));
    });
});
