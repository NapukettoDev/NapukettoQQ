/**
 * start.test.ts：默认动作分发（dispatchMainAction / runSupervisorCommand）单测。
 *
 * 覆盖分支：无 -q 读配置 supervisor 拉起全部账号（含账号缺失防御报错）、
 * 单 -q 单账号（boot 透传 dataDir/qqPath/stubDir）、多 -q supervisor（qqs 列表）、
 * supervisor 子命令转发。配置加载与进程编排均注入假实现（编排层单测）。
 */
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    loadCliConfigWithSource: vi.fn(),
    runSingleAccount: vi.fn(),
    runSupervisor: vi.fn(),
}));

vi.mock("../../src/config/store.js", () => ({
    loadCliConfigWithSource: mocks.loadCliConfigWithSource,
}));
vi.mock("../../src/runtime/boot.js", () => ({ runSingleAccount: mocks.runSingleAccount }));
vi.mock("../../src/runtime/supervisor.js", () => ({ runSupervisor: mocks.runSupervisor }));

import { dispatchMainAction, runSupervisorCommand } from "../../src/commands/start.js";

beforeEach(() => {
    for (const fn of Object.values(mocks)) {
        fn.mockReset();
        fn.mockResolvedValue(undefined);
    }
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("dispatchMainAction 无 -q 分支（读配置拉起）", () => {
    it("读主配置并 supervisor 拉起（不透传 dataDir 时不带该键）", async () => {
        mocks.loadCliConfigWithSource.mockResolvedValue({
            config: { accounts: [{ qq: "10001" }] },
            source: "file",
        });
        await dispatchMainAction({});
        expect(mocks.loadCliConfigWithSource).toHaveBeenCalledWith({
            onInfo: expect.any(Function),
        });
        expect(mocks.runSingleAccount).not.toHaveBeenCalled();
        expect(mocks.runSupervisor).toHaveBeenCalledWith({});
    });

    it("dataDir / stubDir / qqPath 全量透传给 supervisor", async () => {
        mocks.loadCliConfigWithSource.mockResolvedValue({
            config: { accounts: [{ qq: "10001" }] },
            source: "inline",
        });
        await dispatchMainAction({ dataDir: "d", stubDir: "s", qqPath: "p" });
        expect(mocks.loadCliConfigWithSource).toHaveBeenCalledWith({
            dataDir: "d",
            onInfo: expect.any(Function),
        });
        expect(mocks.runSupervisor).toHaveBeenCalledWith({
            dataDir: "d",
            stubDir: "s",
            qqPath: "p",
        });
    });

    it("配置无账号（防御分支）→ 抛错提示编辑模板，不拉起", async () => {
        mocks.loadCliConfigWithSource.mockResolvedValue({
            config: { accounts: [] },
            source: "file",
        });
        await expect(dispatchMainAction({})).rejects.toThrow(/没有账号/);
        expect(mocks.runSupervisor).not.toHaveBeenCalled();
    });
});

describe("dispatchMainAction -q 入口校验", () => {
    it("路径穿越 / 哨兵值 → ConfigError，单账号与 supervisor 均不启动", async () => {
        for (const qq of ["../../escape", "all", "123456"]) {
            await expect(dispatchMainAction({ qq: [qq] })).rejects.toThrow(ConfigError);
        }
        expect(mocks.runSingleAccount).not.toHaveBeenCalled();
        expect(mocks.runSupervisor).not.toHaveBeenCalled();
        expect(mocks.loadCliConfigWithSource).not.toHaveBeenCalled();
    });

    it("重复 -q → ConfigError，不进入 supervisor（避免并发拉起同一账号）", async () => {
        await expect(dispatchMainAction({ qq: ["10001", "10001"] })).rejects.toThrow(ConfigError);
        await expect(dispatchMainAction({ qq: ["10001", "10001"] })).rejects.toThrow(/重复/);
        expect(mocks.runSupervisor).not.toHaveBeenCalled();
    });
});

describe("dispatchMainAction 单 -q 分支", () => {
    it("单账号启动：qq + 可选参数全量透传 runSingleAccount", async () => {
        await dispatchMainAction({ qq: ["10001"], dataDir: "d", qqPath: "p", stubDir: "s" });
        expect(mocks.runSingleAccount).toHaveBeenCalledWith({
            qq: "10001",
            dataDir: "d",
            qqPath: "p",
            stubDir: "s",
        });
        expect(mocks.runSupervisor).not.toHaveBeenCalled();
        // 单账号分支不读主配置
        expect(mocks.loadCliConfigWithSource).not.toHaveBeenCalled();
    });

    it("可选参数缺省 → 仅透传 qq（不带 undefined 键）", async () => {
        await dispatchMainAction({ qq: ["10002"] });
        expect(mocks.runSingleAccount).toHaveBeenCalledWith({ qq: "10002" });
    });
});

describe("dispatchMainAction 多 -q 分支", () => {
    it("多账号 → supervisor 以 qqs 列表拉起（含 qqPath 透传）", async () => {
        await dispatchMainAction({
            qq: ["10001", "10002"],
            dataDir: "d",
            stubDir: "s",
            qqPath: "p",
        });
        expect(mocks.runSupervisor).toHaveBeenCalledWith({
            qqs: ["10001", "10002"],
            dataDir: "d",
            stubDir: "s",
            qqPath: "p",
        });
        expect(mocks.runSingleAccount).not.toHaveBeenCalled();
    });
});

describe("runSupervisorCommand", () => {
    it("透传 dataDir / qqPath；缺省时不带对应键", async () => {
        await runSupervisorCommand({ dataDir: "d", qqPath: "p" });
        expect(mocks.runSupervisor).toHaveBeenCalledWith({ dataDir: "d", qqPath: "p" });
        await runSupervisorCommand({});
        expect(mocks.runSupervisor).toHaveBeenLastCalledWith({});
    });
});
