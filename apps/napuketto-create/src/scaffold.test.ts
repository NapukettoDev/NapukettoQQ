/**
 * scaffold.test.ts：脚手架核心（scaffold.ts）单测。
 *
 * 用临时目录 + 真实落盘断言产物：名称校验（空 / . / .. / Windows 非法字符 /
 * trim）、包管理器检测（npm_config_user_agent）与 bin 后缀、目标目录状态、
 * 生成产物（package.json 渲染 + napuketto.toml + yarn.lock 隔离）、非空目录
 * 覆盖语义（overwrite true/false）、cliVersionRange 兜底链（自身 package.json
 * workspace:* → registry → ^0.0.1，fetch 全部 mock 不触网）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    checkDirStatus,
    DEFAULT_PROJECT_NAME,
    detectPackageManager,
    pmBin,
    resolveTargetDir,
    scaffoldProject,
    validateProjectName,
} from "./scaffold.js";

let tmp = "";
let originalCwd = "";

/** mock registry 响应（version 传入 null 模拟查询失败）。 */
function stubRegistry(version: string | null | "reject"): void {
    if (version === "reject") {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject(new Error("offline"))),
        );
        return;
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve({
                ok: version !== null,
                status: version !== null ? 200 : 404,
                json: async () => ({ version }),
            }),
        ),
    );
}

beforeEach(() => {
    tmp = path.join(
        tmpdir(),
        `nk-create-scaffold-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    mkdirSync(tmp, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmp);
    delete process.env["npm_config_user_agent"];
});

afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
    delete process.env["npm_config_user_agent"];
});

describe("validateProjectName", () => {
    it("空串 / 纯空白 / . / .. → 报「不能为空或为 . / ..」", () => {
        for (const bad of ["", "   ", ".", ".."]) {
            expect(() => validateProjectName(bad)).toThrow(/不能为空/);
        }
    });

    it('Windows 非法字符逐一拒绝（\\ / : * ? " < > |）', () => {
        for (const ch of ["\\", "/", ":", "*", "?", '"', "<", ">", "|"]) {
            expect(() => validateProjectName(`a${ch}b`)).toThrow(/非法字符/);
        }
    });

    it("合法名称原样返回并 trim 首尾空白", () => {
        expect(validateProjectName("my-bot")).toBe("my-bot");
        expect(validateProjectName("  my bot  ")).toBe("my bot");
    });
});

describe("detectPackageManager", () => {
    it("npm_config_user_agent 前缀判定：yarn/ npm/ 命中，其余兜底 pnpm", () => {
        process.env["npm_config_user_agent"] = "yarn/4.1.0 npm/? node/v24";
        expect(detectPackageManager()).toBe("yarn");
        process.env["npm_config_user_agent"] = "npm/11.0.0 node/v24";
        expect(detectPackageManager()).toBe("npm");
        process.env["npm_config_user_agent"] = "pnpm/12.4.1 npm/? node/v24";
        expect(detectPackageManager()).toBe("pnpm");
    });

    it("无 user_agent（直接 node 运行）→ 兜底 pnpm（项目生态）", () => {
        expect(detectPackageManager()).toBe("pnpm");
    });
});

describe("pmBin", () => {
    it.runIf(process.platform === "win32")("Windows 下 bin 带 .cmd 后缀", () => {
        expect(pmBin("pnpm")).toBe("pnpm.cmd");
        expect(pmBin("npm")).toBe("npm.cmd");
    });

    it.runIf(process.platform !== "win32")("POSIX 下 bin 原名", () => {
        expect(pmBin("pnpm")).toBe("pnpm");
    });
});

describe("checkDirStatus", () => {
    it("不存在 → missing；空目录 → empty；非空目录 → nonempty", async () => {
        expect(await checkDirStatus(path.join(tmp, "不存在"))).toBe("missing");
        const emptyDir = path.join(tmp, "empty");
        mkdirSync(emptyDir, { recursive: true });
        expect(await checkDirStatus(emptyDir)).toBe("empty");
        writeFileSync(path.join(emptyDir, "x.txt"), "", "utf8");
        expect(await checkDirStatus(emptyDir)).toBe("nonempty");
    });
});

describe("resolveTargetDir", () => {
    it("基于 cwd 解析出绝对路径（名称先校验）", () => {
        expect(resolveTargetDir("my-bot")).toBe(path.resolve(process.cwd(), "my-bot"));
        expect(() => resolveTargetDir("a/b")).toThrow(/非法字符/);
    });
});

describe("DEFAULT_PROJECT_NAME", () => {
    it("默认部署文件夹名 = NapukettoQQ", () => {
        expect(DEFAULT_PROJECT_NAME).toBe("NapukettoQQ");
    });
});

describe("scaffoldProject 产物（真实落盘）", () => {
    it("生成 package.json + napuketto.toml（渲染占位符，无 {{}} 残留）", async () => {
        stubRegistry("9.9.9");
        const result = await scaffoldProject("my-bot");
        expect(result.packageName).toBe("my-bot");
        expect(result.dir).toBe(path.resolve(tmp, "my-bot"));
        const pkg = JSON.parse(
            readFileSync(path.join(result.dir, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(pkg["name"]).toBe("my-bot");
        expect(pkg["private"]).toBe(true);
        expect(pkg["type"]).toBe("module");
        const scripts = pkg["scripts"] as Record<string, string>;
        expect(scripts["start"]).toBe("napuketto");
        const deps = pkg["dependencies"] as Record<string, string>;
        expect(deps["@napuketto/cli"]).toBe("^9.9.9");
        const toml = readFileSync(path.join(result.dir, "napuketto.toml"), "utf8");
        expect(toml).toContain("[[accounts]]");
        expect(toml).toContain('qq = "123456"');
        expect(toml).not.toMatch(/\{\{\w+\}\}/);
        // 默认（pnpm）不写 yarn.lock
        expect(existsSync(path.join(result.dir, "yarn.lock"))).toBe(false);
    });

    it("文件夹名派生包名：小写 + 空格转 -", async () => {
        stubRegistry(null);
        const result = await scaffoldProject("My Bot");
        expect(result.packageName).toBe("my-bot");
        const pkg = JSON.parse(readFileSync(path.join(result.dir, "package.json"), "utf8")) as {
            name?: string;
        };
        expect(pkg.name).toBe("my-bot");
    });

    it("yarn → 额外写空 yarn.lock（隔离独立项目，阻断向上探测）", async () => {
        stubRegistry(null);
        const result = await scaffoldProject("yarn-proj", false, "yarn");
        const lockPath = path.join(result.dir, "yarn.lock");
        expect(existsSync(lockPath)).toBe(true);
        expect(readFileSync(lockPath, "utf8")).toBe("");
    });
});

describe("scaffoldProject 目标目录冲突", () => {
    it("目录已存在且非空、overwrite=false → 抛「目录已存在且非空」", async () => {
        stubRegistry(null);
        const dir = path.join(tmp, "occupied");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "old.txt"), "旧内容", "utf8");
        await expect(scaffoldProject("occupied")).rejects.toThrow(/目录已存在且非空/);
        // 未覆盖：旧文件仍在
        expect(existsSync(path.join(dir, "old.txt"))).toBe(true);
    });

    it("overwrite=true → 清空现有内容后重新生成（旧文件移除）", async () => {
        stubRegistry(null);
        const dir = path.join(tmp, "occupied");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "old.txt"), "旧内容", "utf8");
        mkdirSync(path.join(dir, "nested"), { recursive: true });
        const result = await scaffoldProject("occupied", true);
        expect(existsSync(path.join(dir, "old.txt"))).toBe(false);
        expect(existsSync(path.join(dir, "nested"))).toBe(false);
        expect(existsSync(path.join(result.dir, "package.json"))).toBe(true);
        expect(existsSync(path.join(result.dir, "napuketto.toml"))).toBe(true);
    });

    it("空目录直接生成（无需覆盖确认语义）", async () => {
        stubRegistry(null);
        mkdirSync(path.join(tmp, "blank"), { recursive: true });
        const result = await scaffoldProject("blank");
        expect(existsSync(path.join(result.dir, "package.json"))).toBe(true);
    });
});

describe("cliVersionRange 兜底链", () => {
    it("自身 devDependencies 为 workspace:*（本地直跑）→ 回退 registry 查询最新版", async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: async () => ({ version: "1.2.3" }) }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const result = await scaffoldProject("fallback-proj");
        const pkg = JSON.parse(readFileSync(path.join(result.dir, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(pkg.dependencies["@napuketto/cli"]).toBe("^1.2.3");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://registry.npmjs.org/@napuketto/cli/latest",
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    it("registry 查询失败（网络异常 / 非 200）→ 兜底 ^0.0.1（离线可用）", async () => {
        stubRegistry("reject");
        const result = await scaffoldProject("offline-proj");
        const pkg = JSON.parse(readFileSync(path.join(result.dir, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(pkg.dependencies["@napuketto/cli"]).toBe("^0.0.1");
    });

    it("registry 返回 404 → 兜底 ^0.0.1", async () => {
        stubRegistry(null);
        const result = await scaffoldProject("notfound-proj");
        const pkg = JSON.parse(readFileSync(path.join(result.dir, "package.json"), "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(pkg.dependencies["@napuketto/cli"]).toBe("^0.0.1");
    });
});
