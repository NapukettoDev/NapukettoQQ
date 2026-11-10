/**
 * program.test.ts：commander 装配层（cli/program.ts）路由单测。
 *
 * commands 层与 logger 全部注入假实现，只断言 CLI 契约：子命令 → 用例函数的
 * 参数路由（-d 数据根共享、-q 收集、config validate 结果 stdout）、主命令默认
 * 动作分发、banner preAction 决策、错误出口（ConfigError → 78，其余 → 1）、
 * --version 输出。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError, resolveDataRoot } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cmdConfigInit: vi.fn(),
    cmdConfigList: vi.fn(),
    cmdConfigApply: vi.fn(),
    cmdConfigValidate: vi.fn(),
    cmdStatus: vi.fn(),
    cmdStop: vi.fn(),
    cmdRestart: vi.fn(),
    dispatchMainAction: vi.fn(),
    runSupervisorCommand: vi.fn(),
    resolveCliLogConfig: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../commands/config.js", () => ({
    cmdConfigInit: mocks.cmdConfigInit,
    cmdConfigList: mocks.cmdConfigList,
    cmdConfigApply: mocks.cmdConfigApply,
    cmdConfigValidate: mocks.cmdConfigValidate,
}));
vi.mock("../commands/ops.js", () => ({
    cmdStatus: mocks.cmdStatus,
    cmdStop: mocks.cmdStop,
    cmdRestart: mocks.cmdRestart,
}));
vi.mock("../commands/start.js", () => ({
    dispatchMainAction: mocks.dispatchMainAction,
    runSupervisorCommand: mocks.runSupervisorCommand,
}));
vi.mock("../logger.js", () => ({
    logger: mocks.logger,
    resolveCliLogConfig: mocks.resolveCliLogConfig,
}));

import { flushAsync } from "../__tests__/test-support.js";
import { main } from "./program.js";

let tmp = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let originalArgv: string[] = [];
let exitCodeBefore: number | undefined;

/** 以给定用户参数运行 main（替换 process.argv 后恢复）。 */
function runArgv(argv: string[]): void {
    originalArgv = process.argv;
    process.argv = ["node", "napuketto", ...argv];
    try {
        main();
    } finally {
        process.argv = originalArgv;
    }
}

/** 最近一次 stdout 输出的拼接文本。 */
function stdoutText(): string {
    return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-program-test-"));
    exitCodeBefore = process.exitCode as number | undefined;
    process.exitCode = undefined;
    for (const fn of [
        mocks.cmdConfigInit,
        mocks.cmdConfigList,
        mocks.cmdConfigApply,
        mocks.cmdConfigValidate,
        mocks.cmdStatus,
        mocks.cmdStop,
        mocks.cmdRestart,
        mocks.dispatchMainAction,
        mocks.runSupervisorCommand,
        mocks.resolveCliLogConfig,
        ...Object.values(mocks.logger),
    ]) {
        fn.mockReset();
    }
    mocks.resolveCliLogConfig.mockReturnValue({ banner: false });
    mocks.cmdConfigInit.mockResolvedValue(undefined);
    mocks.cmdConfigList.mockResolvedValue(undefined);
    mocks.cmdConfigApply.mockResolvedValue(undefined);
    mocks.cmdConfigValidate.mockResolvedValue({ source: "inline" });
    mocks.cmdStatus.mockReturnValue(undefined);
    mocks.cmdStop.mockResolvedValue(undefined);
    mocks.cmdRestart.mockResolvedValue(undefined);
    mocks.dispatchMainAction.mockResolvedValue(undefined);
    mocks.runSupervisorCommand.mockResolvedValue(undefined);
    const bound = process.stdout.write.bind(process.stdout);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        bound(chunk);
        return true;
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
    process.exitCode = exitCodeBefore as number | undefined;
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
});

describe("banner preAction 决策", () => {
    it("banner = true → 每个 action 前输出启动字符画", async () => {
        mocks.resolveCliLogConfig.mockReturnValue({ banner: true });
        runArgv(["config", "init"]);
        await flushAsync();
        expect(stdoutText()).toContain("_   __");
        expect(mocks.cmdConfigInit).toHaveBeenCalledTimes(1);
    });

    it("banner = false → 不输出字符画", async () => {
        runArgv(["config", "init"]);
        await flushAsync();
        expect(stdoutText()).not.toContain("_   __");
    });

    it("preAction 以已解析的 -d 数据根决策（resolveCliLogConfig 收到 dataDir）", async () => {
        const dir = join(tmp, "data");
        runArgv(["-d", dir, "config", "init"]);
        await flushAsync();
        expect(mocks.resolveCliLogConfig).toHaveBeenCalledWith(dir);
    });
});

describe("主命令默认动作路由", () => {
    it("无参数 → dispatchMainAction（qq 缺省空数组）", async () => {
        runArgv([]);
        await flushAsync();
        expect(mocks.dispatchMainAction).toHaveBeenCalledWith({ qq: [] });
    });

    it("单 -q → qq 单元素数组", async () => {
        runArgv(["-q", "10001"]);
        await flushAsync();
        expect(mocks.dispatchMainAction).toHaveBeenCalledWith(
            expect.objectContaining({ qq: ["10001"] }),
        );
    });

    it("多 -q 可重复收集（collectQq 累积）", async () => {
        runArgv(["-q", "10001", "-q", "10002"]);
        await flushAsync();
        expect(mocks.dispatchMainAction).toHaveBeenCalledWith(
            expect.objectContaining({ qq: ["10001", "10002"] }),
        );
    });

    it("-d / --qq-path / --stub-dir 透传主命令 opts", async () => {
        runArgv(["-d", "d1", "--qq-path", "p1", "--stub-dir", "s1"]);
        await flushAsync();
        expect(mocks.dispatchMainAction).toHaveBeenCalledWith(
            expect.objectContaining({ dataDir: "d1", qqPath: "p1", stubDir: "s1" }),
        );
    });

    it("supervisor 子命令 → runSupervisorCommand（-d 共享）", async () => {
        runArgv(["supervisor", "-d", "d2"]);
        await flushAsync();
        expect(mocks.runSupervisorCommand).toHaveBeenCalledWith({ dataDir: "d2" });
    });
});

describe("config 子命令路由", () => {
    it("config init → cmdConfigInit（无 -d 时不带 dataDir 键）", async () => {
        runArgv(["config", "init"]);
        await flushAsync();
        expect(mocks.cmdConfigInit).toHaveBeenCalledWith({});
    });

    it("config init -d → rootDataDir 透传", async () => {
        runArgv(["config", "init", "-d", "dd"]);
        await flushAsync();
        expect(mocks.cmdConfigInit).toHaveBeenCalledWith({ dataDir: "dd" });
    });

    it("config list → cmdConfigList", async () => {
        runArgv(["config", "list"]);
        await flushAsync();
        expect(mocks.cmdConfigList).toHaveBeenCalledWith({});
    });

    it("config apply <file> → cmdConfigApply 位置参数", async () => {
        runArgv(["config", "apply", "patch.toml"]);
        await flushAsync();
        expect(mocks.cmdConfigApply).toHaveBeenCalledWith("patch.toml", {});
    });

    it("config validate --config → 结果以 file 来源单行输出到 stdout", async () => {
        mocks.cmdConfigValidate.mockResolvedValue({ source: "file", path: "cfg.toml" });
        runArgv(["config", "validate", "--config", "cfg.toml"]);
        await flushAsync();
        expect(mocks.cmdConfigValidate).toHaveBeenCalledWith(
            expect.objectContaining({ configPath: "cfg.toml" }),
        );
        expect(stdoutText()).toContain("配置校验通过（来源: file cfg.toml）");
    });

    it("config validate --config-json → inline 来源输出", async () => {
        runArgv(["config", "validate", "--config-json", '{"accounts":[{"qq":"10001"}]}']);
        await flushAsync();
        expect(mocks.cmdConfigValidate).toHaveBeenCalledWith(
            expect.objectContaining({ configJson: '{"accounts":[{"qq":"10001"}]}' }),
        );
        expect(stdoutText()).toContain("配置校验通过（来源: inline）");
    });
});

describe("运维子命令路由（status/stop/restart）", () => {
    // ⚠️ 已知行为（疑似生产 bug，测试如实记录）：主命令也定义了 -q（collectQq），
    // commander 根命令解析会吞掉 `status -q <uin>` 的 -q（进根 opts.qq，ops action
    // 收不到）——因此此处只断言无 -q 形态；带 -q 形态的预期行为需修复生产代码后补断言。
    it("status → cmdStatus(数据根, {})", async () => {
        runArgv(["status"]);
        await flushAsync();
        expect(mocks.cmdStatus).toHaveBeenCalledWith(resolveDataRoot(), {});
    });

    it("stop / restart → cmdStop / cmdRestart（-d 影响数据根解析）", async () => {
        runArgv(["stop", "-d", tmp]);
        runArgv(["restart", "-d", tmp]);
        await flushAsync();
        expect(mocks.cmdStop).toHaveBeenCalledWith(resolveDataRoot(tmp), {});
        expect(mocks.cmdRestart).toHaveBeenCalledWith(resolveDataRoot(tmp), {});
    });
});

describe("错误出口（handleActionError）", () => {
    it("ConfigError → 退出码 78（宿主免重启契约）", async () => {
        mocks.cmdConfigInit.mockRejectedValue(new ConfigError("配置无效"));
        runArgv(["config", "init"]);
        await flushAsync();
        expect(process.exitCode).toBe(78);
        expect(mocks.logger.error).toHaveBeenCalled();
    });

    it("普通 Error → 退出码 1", async () => {
        mocks.cmdConfigList.mockRejectedValue(new Error("运行时崩溃"));
        runArgv(["config", "list"]);
        await flushAsync();
        expect(process.exitCode).toBe(1);
    });

    it("ops action 异常同样收敛到退出码 1", async () => {
        mocks.cmdStatus.mockImplementation(() => {
            throw new Error("boom");
        });
        runArgv(["status"]);
        await flushAsync();
        expect(process.exitCode).toBe(1);
    });
});

describe("--version", () => {
    it("输出版本号为自身 package.json 的 version（不再硬编码 0.0.1）", () => {
        const pkgVersion = (
            JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
                version: string;
            }
        ).version;
        runArgv(["--version"]);
        expect(stdoutText()).toContain(pkgVersion);
        expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
