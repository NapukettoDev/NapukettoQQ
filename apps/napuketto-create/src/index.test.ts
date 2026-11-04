/**
 * index.test.ts：create-napukettoqq 交互流程（index.ts）单测。
 *
 * 交互（@clack/prompts）/ 子进程（spawn）/ 脚手架核心（scaffoldProject、
 * checkDirStatus、包管理器检测）全部 mock 到边界；main() 随 import 执行，
 * 用 vi.resetModules + 动态 import 驱动各分支：-h 帮助、未知/多余参数报错、
 * 位置参数与交互命名（-y 跳过 / 取消符号）、非空目录确认清空（-f 强制 /
 * confirm 拒绝）、生成 + 自动 install（成功指引 / 失败退出码 1）、yarn 分支
 * 文件树、PnP NODE_OPTIONS 剥除。
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    spinnerStart: vi.fn(),
    spinnerStop: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    logStep: vi.fn(),
    logSuccess: vi.fn(),
    logMessage: vi.fn(),
    spawn: vi.fn(),
    scaffoldProject: vi.fn(),
    checkDirStatus: vi.fn(),
    detectPackageManager: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
    intro: mocks.intro,
    outro: mocks.outro,
    cancel: mocks.cancel,
    text: mocks.text,
    confirm: mocks.confirm,
    log: {
        info: mocks.logInfo,
        warn: mocks.logWarn,
        error: mocks.logError,
        step: mocks.logStep,
        success: mocks.logSuccess,
        message: mocks.logMessage,
    },
    spinner: vi.fn(() => ({ start: mocks.spinnerStart, stop: mocks.spinnerStop })),
}));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, spawn: mocks.spawn };
});

vi.mock("./scaffold.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        scaffoldProject: mocks.scaffoldProject,
        checkDirStatus: mocks.checkDirStatus,
        detectPackageManager: mocks.detectPackageManager,
    };
});

import { DEFAULT_PROJECT_NAME } from "./scaffold.js";

const CANCEL = Symbol("clack:cancel");

/** spawn 假子进程：下一 tick 发出 exit（runInteractive 的 resolve 路径）。 */
function fakeChild(exitCode: number): EventEmitter {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    queueMicrotask(() => {
        child.emit("exit", exitCode);
    });
    return child;
}

let originalArgv: string[];
let originalCwd: string;
let nextSpawnExitCode: number;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** 设置 argv 后动态加载入口模块（main() 随 import 执行）。 */
async function runCreate(argv: string[]): Promise<void> {
    process.argv = ["node", "create-napukettoqq", ...argv];
    await import("./index.js");
}

/** 等待流程收尾（outro / console.log / 错误输出至少出现一个）。 */
async function untilSettled(): Promise<void> {
    await vi.waitFor(() => {
        const settled =
            mocks.outro.mock.calls.length > 0 ||
            logSpy.mock.calls.length > 0 ||
            mocks.logError.mock.calls.length > 0 ||
            mocks.cancel.mock.calls.length > 0;
        expect(settled).toBe(true);
    });
}

beforeEach(() => {
    vi.resetModules();
    originalArgv = process.argv;
    originalCwd = process.cwd();
    nextSpawnExitCode = 0;
    for (const fn of [
        mocks.intro,
        mocks.outro,
        mocks.cancel,
        mocks.text,
        mocks.confirm,
        mocks.spinnerStart,
        mocks.spinnerStop,
        mocks.logInfo,
        mocks.logWarn,
        mocks.logError,
        mocks.logStep,
        mocks.logSuccess,
        mocks.logMessage,
        mocks.spawn,
        mocks.scaffoldProject,
        mocks.checkDirStatus,
        mocks.detectPackageManager,
    ]) {
        fn.mockReset();
    }
    mocks.detectPackageManager.mockReturnValue("pnpm");
    mocks.checkDirStatus.mockResolvedValue("missing");
    // 产物目录按名称派生（与真实 scaffoldProject 的 resolveTargetDir 语义一致）
    mocks.scaffoldProject.mockImplementation(async (name: string) => ({
        dir: path.join(originalCwd, name),
        packageName: name.toLowerCase().replace(/\s+/g, "-"),
    }));
    mocks.text.mockResolvedValue(DEFAULT_PROJECT_NAME);
    mocks.confirm.mockResolvedValue(true);
    mocks.spawn.mockImplementation((() => {
        return fakeChild(nextSpawnExitCode);
    }) as never);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("__process_exit__");
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined); // 静音输出
    delete process.env["NODE_OPTIONS"];
});

afterEach(() => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
});

describe("参数解析", () => {
    it("-h → 打印帮助后直接返回（不 intro、不生成）", async () => {
        await runCreate(["-h"]);
        await untilSettled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("用法: create-napukettoqq"));
        expect(mocks.intro).not.toHaveBeenCalled();
        expect(mocks.scaffoldProject).not.toHaveBeenCalled();
    });

    it("未知参数 → main catch 打印创建失败并置退出码 1（不 intro）", async () => {
        await runCreate(["--bogus"]);
        await untilSettled();
        expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("未知参数"));
        expect(process.exitCode).toBe(1);
        expect(mocks.intro).not.toHaveBeenCalled();
    });

    it("多余位置参数 → 报「多余的位置参数」", async () => {
        await runCreate(["a", "b"]);
        await untilSettled();
        expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("多余的位置参数"));
        expect(process.exitCode).toBe(1);
    });
});

describe("命名与目标目录", () => {
    it("位置参数命名 → 跳过 text 交互，直接生成（overwrite=false）", async () => {
        await runCreate(["my-bot"]);
        await untilSettled();
        expect(mocks.text).not.toHaveBeenCalled();
        expect(mocks.scaffoldProject).toHaveBeenCalledWith("my-bot", false, "pnpm");
        expect(mocks.spinnerStart).toHaveBeenCalledWith(expect.stringContaining("my-bot"));
    });

    it("-y → 跳过命名交互，用默认名 NapukettoQQ", async () => {
        await runCreate(["-y"]);
        await untilSettled();
        expect(mocks.text).not.toHaveBeenCalled();
        expect(mocks.scaffoldProject).toHaveBeenCalledWith(DEFAULT_PROJECT_NAME, false, "pnpm");
    });

    it("无位置参数 → text 交互问名（placeholder = 默认名）", async () => {
        mocks.text.mockResolvedValue("asked-bot");
        await runCreate([]);
        await untilSettled();
        expect(mocks.text).toHaveBeenCalledWith(
            expect.objectContaining({ message: "部署文件夹名", placeholder: DEFAULT_PROJECT_NAME }),
        );
        expect(mocks.scaffoldProject).toHaveBeenCalledWith("asked-bot", false, "pnpm");
    });

    it("text 返回空白 → 用默认名（空输入不报错）", async () => {
        mocks.text.mockResolvedValue("   ");
        await runCreate([]);
        await untilSettled();
        expect(mocks.scaffoldProject).toHaveBeenCalledWith(DEFAULT_PROJECT_NAME, false, "pnpm");
    });

    it("text 返回取消符号 → cancel 提示并以退出码 0 结束", async () => {
        mocks.text.mockResolvedValue(CANCEL as unknown as string);
        await runCreate([]);
        await untilSettled();
        expect(mocks.cancel).toHaveBeenCalledWith("操作已取消");
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(mocks.scaffoldProject).not.toHaveBeenCalled();
    });
});

describe("非空目录处理", () => {
    it("非空目录 + confirm 拒绝 → outro 取消提示，不生成不安装", async () => {
        mocks.checkDirStatus.mockResolvedValue("nonempty");
        mocks.confirm.mockResolvedValue(false);
        await runCreate(["my-bot"]);
        await untilSettled();
        expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining("已存在且非空"));
        expect(mocks.confirm).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining("my-bot") }),
        );
        expect(mocks.outro).toHaveBeenCalledWith("已取消，未做任何修改。");
        expect(mocks.scaffoldProject).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("非空目录 + confirm 接受 → overwrite=true 覆盖生成", async () => {
        mocks.checkDirStatus.mockResolvedValue("nonempty");
        mocks.confirm.mockResolvedValue(true);
        await runCreate(["my-bot"]);
        await untilSettled();
        expect(mocks.scaffoldProject).toHaveBeenCalledWith("my-bot", true, "pnpm");
    });

    it("-f 强制覆盖 → 跳过 confirm，直接 overwrite=true", async () => {
        mocks.checkDirStatus.mockResolvedValue("nonempty");
        await runCreate(["my-bot", "-f"]);
        await untilSettled();
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.scaffoldProject).toHaveBeenCalledWith("my-bot", true, "pnpm");
    });
});

describe("自动安装与指引", () => {
    it("install 成功 → 打印指引（cd 相对路径 + <pm> start）并打开配置文件，outro 完成", async () => {
        await runCreate(["my-bot"]);
        await vi.waitFor(() => {
            expect(mocks.outro).toHaveBeenCalledWith("完成。");
        });
        // install 子进程：<pm> install，cwd = 生成目录（win 下命令拼接为单字符串）
        const installCall = mocks.spawn.mock.calls[0] as unknown as [
            string,
            string[],
            { cwd: string },
        ];
        const installCmdText = [installCall[0], ...installCall[1]].join(" ");
        expect(installCmdText).toContain("pnpm");
        expect(installCmdText).toContain("install");
        expect(installCall[2].cwd).toBe(path.join(originalCwd, "my-bot"));
        // 打开配置文件（第二次 spawn：win cmd.exe / posix xdg-open）
        expect(mocks.spawn.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(mocks.logStep).toHaveBeenCalledWith(expect.stringContaining("pnpm start"));
        expect(mocks.logMessage).toHaveBeenCalledWith(
            expect.stringContaining("请编辑 napuketto.toml 填写你的 QQ 号"),
        );
    });

    it("install 失败（退出码非 0）→ 打印手动指引并置退出码 1，无「完成」", async () => {
        nextSpawnExitCode = 3;
        await runCreate(["my-bot"]);
        await vi.waitFor(() => {
            expect(mocks.outro).toHaveBeenCalledWith("创建失败，请手动安装后重试。");
        });
        expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("退出码 3"));
        expect(mocks.logStep).toHaveBeenCalledWith(expect.stringContaining("cd "));
        expect(mocks.logStep).toHaveBeenCalledWith(expect.stringContaining("pnpm install"));
        expect(process.exitCode).toBe(1);
        expect(mocks.outro).not.toHaveBeenCalledWith("完成。");
        expect(mocks.spawn).toHaveBeenCalledTimes(1); // 打开编辑器不再执行
    });

    it("yarn 场景 → install 命令带 yarn，文件树含 yarn.lock 隔离说明", async () => {
        mocks.detectPackageManager.mockReturnValue("yarn");
        await runCreate(["yarn-bot"]);
        await vi.waitFor(() => {
            expect(mocks.outro).toHaveBeenCalledWith("完成。");
        });
        expect(mocks.spawn.mock.calls[0]?.[0]).toContain("yarn");
        const tree = mocks.logMessage.mock.calls
            .map((call) => String(call[0]))
            .find((text) => text.includes("package.json"));
        expect(tree).toContain("yarn.lock");
    });

    it("NODE_OPTIONS 中的 PnP 加载器条目在 install 子进程 env 中被剥除", async () => {
        process.env["NODE_OPTIONS"] = "--require /tmp/.pnp.cjs --max-old-space-size=4096";
        await runCreate(["my-bot"]);
        await vi.waitFor(() => {
            expect(mocks.outro).toHaveBeenCalledWith("完成。");
        });
        const env = (
            mocks.spawn.mock.calls[0] as unknown as [
                string,
                string[],
                { env: Record<string, string> },
            ]
        )[2].env;
        expect(env["NODE_OPTIONS"]).toBe("--max-old-space-size=4096");
    });
});

describe("生成失败路径", () => {
    it("scaffoldProject 抛错 → main catch 打印创建失败并置退出码 1", async () => {
        mocks.scaffoldProject.mockRejectedValue(new Error("目录已存在且非空"));
        await runCreate(["my-bot"]);
        await untilSettled();
        expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("创建失败"));
        expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("目录已存在且非空"));
        expect(process.exitCode).toBe(1);
    });
});
