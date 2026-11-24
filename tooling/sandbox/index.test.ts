import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(new URL("./index.ts", import.meta.url));
const REPO = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const DISABLED_ACCOUNT = '\n[[accounts]]\nqq = "10001"\nenabled = false\n';

let fixture: string;
let sandbox: string;

beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), "napuketto-sandbox-test-")));
    sandbox = join(fixture, "instance with spaces");
});

afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
});

function run(...args: string[]): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", LAUNCHER, ...args], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10_000,
        env: {
            ...process.env,
            NAPUKETTO_SANDBOX_DIR: sandbox,
            NAPUKETTO_CONFIG: join(fixture, "outside.toml"),
            NAPUKETTO_CONFIG_JSON: "",
            NAPUKETTO_DATA: join(fixture, "outside-data"),
            NAPUKETTO_LOG_LEVEL: "info",
            NAPUKETTO_NO_BANNER: "1",
        },
    });
    if (result.error) {
        throw result.error;
    }
    return { status: result.status, output: result.stdout + result.stderr };
}

describe("外部调试沙箱", () => {
    it("初始化到指定外部目录，复用已有配置且保留 CLI 退出码", () => {
        const config = join(sandbox, "napuketto.toml");
        expect(run("init").status).toBe(0);
        expect(readFileSync(config, "utf8")).toContain("Napuketto 全局配置文件");
        expect(run("config", "validate").status).toBe(78);
        writeFileSync(config, DISABLED_ACCOUNT);
        expect(run("init").output).not.toContain("[[accounts]]");
        expect(readFileSync(config, "utf8")).toBe(DISABLED_ACCOUNT);
        expect(run("config", "validate").status).toBe(0);
        expect(run("run", "--", "--version").status).toBe(0);
        expect(existsSync(join(fixture, "outside.toml"))).toBe(false);
        expect(existsSync(join(fixture, "outside-data"))).toBe(false);
    });

    it("允许沙箱内的文件日志，拒绝越界的 CLI 数据目录、日志和协议缓存", () => {
        expect(run("init").status).toBe(0);
        const config = join(sandbox, "napuketto.toml");
        writeFileSync(config, `[log.file]\npath = "logs/debug.log"\n${DISABLED_ACCOUNT}`);
        expect(run("run").status).toBe(0);
        expect(existsSync(join(sandbox, ".napuketto", "logs", "debug.log"))).toBe(true);

        const outside = join(fixture, "escape");
        expect(run("run", "--data-dir", outside, "status").status).toBe(78);
        writeFileSync(
            config,
            `[log.file]\npath = '${join(outside, "debug.log")}'\n${DISABLED_ACCOUNT}`,
        );
        expect(run("run")).toMatchObject({
            status: 78,
            output: expect.stringContaining("log.file.path"),
        });
        writeFileSync(config, `${DISABLED_ACCOUNT}\n[accounts.satori]\ncacheDir = '${outside}'\n`);
        expect(run("config", "validate")).toMatchObject({
            status: 78,
            output: expect.stringContaining("accounts.satori.cacheDir"),
        });
        expect(existsSync(outside)).toBe(false);
    });

    it("拒绝仓库路径、别名和沙箱里通往外部的链接", () => {
        const target = sandbox;
        sandbox = join(REPO, "apps", "cli");
        expect(run("init").output).toContain("必须位于仓库外");

        const alias = join(fixture, "checkout-alias");
        symlinkSync(REPO, alias, "junction");
        sandbox = join(alias, "apps", "cli");
        expect(run("init").output).toContain("必须位于仓库外");

        sandbox = target;
        expect(run("init").status).toBe(0);
        symlinkSync(fixture, join(sandbox, ".napuketto", "escape"), "junction");
        expect(run("run", "status")).toMatchObject({
            status: 1,
            output: expect.stringContaining("链接指向调试沙箱外"),
        });
    });

    it("保留未由本工具管理的目录", () => {
        mkdirSync(sandbox);
        const existing = join(sandbox, "keep.txt");
        writeFileSync(existing, "keep");
        expect(run("init")).toMatchObject({
            status: 1,
            output: expect.stringContaining("不属于此仓库"),
        });
        expect(readFileSync(existing, "utf8")).toBe("keep");
        expect(existsSync(join(sandbox, "napuketto.toml"))).toBe(false);
    });
});
