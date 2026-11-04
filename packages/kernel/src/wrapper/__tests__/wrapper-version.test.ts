/**
 * wrapper-version.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 QQ 安装目录版本探测：
 *  - resolveWrapperPath 路径拼接
 *  - resolveQQVersion 读 package.json / 缺 wrapper.node 抛错
 *  - listQQVersions 目录扫描
 * 用临时目录模拟 QQ 安装结构，不依赖真实安装。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listQQVersions, resolveQQVersion, resolveWrapperPath } from "../wrapper-version.js";

/** 临时 QQ 安装目录。 */
let installDir: string;

beforeEach(() => {
    installDir = join(tmpdir(), `napuketto-version-test-${Date.now()}-${Math.random()}`);
    mkdirSync(join(installDir, "versions", "9.9.31-49919", "resources", "app"), {
        recursive: true,
    });
    writeFileSync(
        join(installDir, "versions", "9.9.31-49919", "resources", "app", "package.json"),
        JSON.stringify({ name: "qq-chat", version: "9.9.31-49919", buildVersion: "49919" }),
        "utf8",
    );
    writeFileSync(
        join(installDir, "versions", "9.9.31-49919", "resources", "app", "wrapper.node"),
        "",
    );
});

afterEach(() => {
    rmSync(installDir, { recursive: true, force: true });
});

describe("resolveWrapperPath", () => {
    it("按 ADR-018 目录约定拼接", () => {
        expect(resolveWrapperPath(installDir, "9.9.31-49919")).toBe(
            join(installDir, "versions", "9.9.31-49919", "resources", "app", "wrapper.node"),
        );
    });
});

describe("resolveQQVersion", () => {
    it("版本目录完整时返回版本信息", () => {
        const info = resolveQQVersion(installDir, "9.9.31-49919");
        expect(info.fullVersion).toBe("9.9.31-49919");
        expect(info.buildVersion).toBe("49919");
        expect(info.wrapperPath).toContain("wrapper.node");
    });

    it("缺 wrapper.node 抛 NOT_FOUND", () => {
        const other = join(installDir, "versions", "10.0.0-10000");
        mkdirSync(join(other, "resources", "app"), { recursive: true });
        writeFileSync(
            join(other, "resources", "app", "package.json"),
            JSON.stringify({ name: "qq-chat", version: "10.0.0-10000" }),
            "utf8",
        );
        expect(() => resolveQQVersion(installDir, "10.0.0-10000")).toThrow(/未找到 wrapper.node/);
    });

    it("package.json 解析失败抛 INVALID_PARAM", () => {
        const other = join(installDir, "versions", "11.0.0-11000");
        mkdirSync(join(other, "resources", "app"), { recursive: true });
        writeFileSync(join(other, "resources", "app", "wrapper.node"), "");
        writeFileSync(join(other, "resources", "app", "package.json"), "not-json", "utf8");
        expect(() => resolveQQVersion(installDir, "11.0.0-11000")).toThrow(/解析失败/);
    });

    it("package.json 缺 buildVersion 时回退空串", () => {
        const other = join(installDir, "versions", "12.0.0-12000");
        mkdirSync(join(other, "resources", "app"), { recursive: true });
        writeFileSync(join(other, "resources", "app", "wrapper.node"), "");
        writeFileSync(
            join(other, "resources", "app", "package.json"),
            JSON.stringify({ name: "qq-chat", version: "12.0.0-12000" }),
            "utf8",
        );
        const info = resolveQQVersion(installDir, "12.0.0-12000");
        expect(info.fullVersion).toBe("12.0.0-12000");
        expect(info.buildVersion).toBe("");
    });
});

describe("listQQVersions", () => {
    it("扫描 versions 目录按名字倒序", () => {
        mkdirSync(join(installDir, "versions", "9.9.30-49000", "resources", "app"), {
            recursive: true,
        });
        writeFileSync(
            join(installDir, "versions", "9.9.30-49000", "resources", "app", "wrapper.node"),
            "",
        );
        const versions = listQQVersions(installDir);
        expect(versions[0]).toBe("9.9.31-49919");
        expect(versions[1]).toBe("9.9.30-49000");
    });

    it("缺 versions 目录返回空数组", () => {
        expect(listQQVersions(join(installDir, "nonexistent"))).toEqual([]);
    });

    it("无 wrapper.node 的版本目录被过滤", () => {
        mkdirSync(join(installDir, "versions", "9.9.29-48000", "resources", "app"), {
            recursive: true,
        });
        const versions = listQQVersions(installDir);
        expect(versions).toEqual(["9.9.31-49919"]);
    });
});

describe("版本元数据缺省分支", () => {
    it("缺 package.json 抛 NOT_FOUND（明确失败而非静默）", () => {
        rmSync(join(installDir, "versions", "9.9.31-49919", "resources", "app", "package.json"));
        expect(() => resolveQQVersion(installDir, "9.9.31-49919")).toThrow(
            /QQ 版本目录缺少 package\.json/,
        );
    });

    it("package.json 缺 name/version → name/version 空串，fullVersion 回退目录版本号", () => {
        writeFileSync(
            join(installDir, "versions", "9.9.31-49919", "resources", "app", "package.json"),
            "{}",
            "utf8",
        );
        const info = resolveQQVersion(installDir, "9.9.31-49919");
        expect(info.fullVersion).toBe("9.9.31-49919");
        expect(info.buildVersion).toBe("");
    });
});
