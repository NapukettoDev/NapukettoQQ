/**
 * paths.ts 测试：数据根 / 配置路径解析与 PathWrapper 目录装配。
 * 跨平台注意：路径断言用 path.join 拼（CI ubuntu 与 windows 同跑）；
 * 环境变量进出成对（beforeEach 存档 / afterAll 恢复）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_DATA_ROOT_NAME,
    MAIN_CONFIG_FILE,
    PathWrapper,
    resolveConfigPath,
    resolveDataRoot,
} from "../paths.js";

const tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    savedEnv["NAPKETTO_DATA"] = process.env["NAPKETTO_DATA"];
    savedEnv["NAPKETTO_CONFIG"] = process.env["NAPKETTO_CONFIG"];
    delete process.env["NAPKETTO_DATA"];
    delete process.env["NAPKETTO_CONFIG"];
});

afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

afterAll(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nk-test-paths-"));
    tmpDirs.push(dir);
    return dir;
}

describe("resolveDataRoot", () => {
    it("显式参数优先于环境变量", () => {
        process.env["NAPKETTO_DATA"] = "/from-env";
        const root = resolveDataRoot("/from-arg");
        expect(root.endsWith("from-arg")).toBe(true);
    });

    it("NAPKETTO_DATA 环境变量生效", () => {
        const dir = tmpDir();
        process.env["NAPKETTO_DATA"] = join(dir, "env-root");
        expect(resolveDataRoot()).toBe(join(dir, "env-root"));
    });

    it("相对路径相对 cwd 解析为绝对路径", () => {
        const root = resolveDataRoot("rel-root");
        expect(join(...root.split(/[\\/]/).slice(-1))).toBe("rel-root");
        expect(root.includes("rel-root")).toBe(true);
    });

    it("~ 前缀展开为用户主目录（~/ 与 ~ 两种形态）", () => {
        const tilde = resolveDataRoot("~");
        expect(tilde).toBe(homedir());
        const tildeSub = resolveDataRoot("~/sub-dir");
        expect(tildeSub).toBe(join(homedir(), "sub-dir"));
    });

    it("~ 开头但非前缀语义（~abc）不展开", () => {
        const root = resolveDataRoot("~abc");
        expect(root.includes("~abc")).toBe(true);
    });

    it("空字符串环境变量 / 空参数 → 走默认项目根", () => {
        process.env["NAPKETTO_DATA"] = "";
        const root = resolveDataRoot("");
        expect(root.endsWith(DEFAULT_DATA_ROOT_NAME)).toBe(true);
        // 本仓为 monorepo：项目根 = 含 pnpm-workspace.yaml 的目录
        expect(existsSync(join(root, "..", "pnpm-workspace.yaml"))).toBe(true);
    });

    it("默认值 = 项目根/.napuketto", () => {
        const root = resolveDataRoot();
        expect(root.endsWith(DEFAULT_DATA_ROOT_NAME)).toBe(true);
    });
});

describe("resolveConfigPath", () => {
    it("NAPKETTO_CONFIG 显式路径优先（相对路径也解析为绝对）", () => {
        process.env["NAPKETTO_CONFIG"] = "explicit.toml";
        const p = resolveConfigPath({ dataRoot: "/tmp/dr" });
        expect(p.includes("explicit.toml")).toBe(true);
    });

    it("无 NAPKETTO_CONFIG → 项目根/napuketto.toml", () => {
        const p = resolveConfigPath({ dataRoot: "/tmp/dr" });
        expect(p.endsWith(MAIN_CONFIG_FILE)).toBe(true);
        expect(p.includes(DEFAULT_DATA_ROOT_NAME)).toBe(false);
        expect(existsSync(join(p, "..", "pnpm-workspace.yaml"))).toBe(true);
    });
});

describe("PathWrapper", () => {
    it("无 account：root/accountDir 同级，config/logs/cache 挂在 root 下", () => {
        const dir = tmpDir();
        const paths = new PathWrapper({ dataRoot: dir });
        expect(paths.root).toBe(dir);
        expect(paths.accountDir).toBe(dir);
        expect(paths.configDir).toBe(join(dir, "config"));
        expect(paths.logsDir).toBe(join(dir, "logs"));
        expect(paths.cacheDir).toBe(join(dir, "cache"));
    });

    it("带 account：账号目录隔离", () => {
        const dir = tmpDir();
        const paths = new PathWrapper({ dataRoot: dir, account: "10001" });
        expect(paths.accountDir).toBe(join(dir, "10001"));
        expect(paths.configDir).toBe(join(dir, "10001", "config"));
    });

    it("ensure：递归创建全部目录", () => {
        const dir = tmpDir();
        const paths = new PathWrapper({ dataRoot: dir, account: "a1" });
        paths.ensure();
        expect(existsSync(paths.configDir)).toBe(true);
        expect(existsSync(paths.logsDir)).toBe(true);
        expect(existsSync(paths.cacheDir)).toBe(true);
    });

    it("file：账号目录内相对片段拼接", () => {
        const dir = tmpDir();
        const paths = new PathWrapper({ dataRoot: dir, account: "a2" });
        expect(paths.file("config", "napuketto.json")).toBe(
            join(dir, "a2", "config", "napuketto.json"),
        );
    });

    it("clearCache：清空 cache 目录条目（保留目录与外部内容）", () => {
        const dir = tmpDir();
        const paths = new PathWrapper({ dataRoot: dir, account: "a3" });
        paths.ensure();
        writeFileSync(join(paths.cacheDir, "f.txt"), "x");
        mkdirSync(join(paths.cacheDir, "sub"));
        writeFileSync(join(paths.cacheDir, "sub", "g.txt"), "y");
        writeFileSync(join(paths.accountDir, "keep.txt"), "z");
        paths.clearCache();
        expect(existsSync(join(paths.cacheDir, "f.txt"))).toBe(false);
        expect(existsSync(join(paths.cacheDir, "sub"))).toBe(false);
        expect(existsSync(paths.cacheDir)).toBe(true);
        expect(existsSync(join(paths.accountDir, "keep.txt"))).toBe(true);
    });

    it("clearCache：目录不存在静默跳过（不抛错）", () => {
        const dir = tmpDir();
        const paths = new PathWrapper({ dataRoot: dir, account: "never-created" });
        expect(() => paths.clearCache()).not.toThrow();
    });
});
