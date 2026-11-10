/**
 * version.test.ts：CLI 自身版本号读取（cli/version.ts）。
 *
 * 覆盖两条路径：真实 package.json 命中（值 = 包 version，不硬编码）、
 * 兜底常量存在。候选链顺序本身由生产形态（dist 单文件）与源码形态共同约束，
 * 不在此单测里逐一伪造。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliVersion, VERSION_FALLBACK } from "./version.js";

describe("cliVersion", () => {
    it("读到真实 package.json 的 version（非兜底值）", () => {
        const pkgVersion = (
            JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
                version: string;
            }
        ).version;
        expect(cliVersion()).toBe(pkgVersion);
        expect(cliVersion()).not.toBe(VERSION_FALLBACK);
    });

    it("返回值满足 semver 形态（major.minor.patch）", () => {
        expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });
});
