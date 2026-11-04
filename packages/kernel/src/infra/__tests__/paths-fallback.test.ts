/**
 * paths.ts 项目根探测兜底测试：
 * mock existsSync 恒 false，模拟「文件系统上找不到任何项目标志」的裸脚本场景——
 *  - resolveProjectRoot：入口模块向上找不到 pnpm-workspace.yaml → cwd 也找不到 → undefined
 *  - resolveDataRoot：兜底 `~/.napuketto`（用户主目录）
 *  - resolveConfigPath：兜底 dataRoot（显式传入 / resolveDataRoot 再兜底）
 *  - findProjectRoot：走到文件系统根（parent === dir）终止返回 undefined
 * 独立文件隔离 vi.mock（不影响 paths.test.ts 的真实文件系统用例）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, existsSync: () => false };
});

import {
    DEFAULT_DATA_ROOT_NAME,
    MAIN_CONFIG_FILE,
    resolveConfigPath,
    resolveDataRoot,
} from "../paths.js";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("项目根探测失败兜底", () => {
    it("resolveDataRoot：无项目根 → 用户主目录/.napuketto", () => {
        vi.stubEnv("NAPKETTO_DATA", "");
        const root = resolveDataRoot();
        expect(root).toBe(join(homedir(), DEFAULT_DATA_ROOT_NAME));
    });

    it("resolveConfigPath：无项目根且无 env → dataRoot 兜底（显式 dataRoot）", () => {
        vi.stubEnv("NAPKETTO_CONFIG", "");
        const p = resolveConfigPath({ dataRoot: "/tmp/nk-fallback" });
        // 平台无关断言：以 MAIN_CONFIG_FILE 结尾且包含传入 dataRoot
        expect(p.endsWith(join("tmp", "nk-fallback", MAIN_CONFIG_FILE))).toBe(true);
    });

    it("resolveConfigPath：无项目根且未传 dataRoot → resolveDataRoot 兜底（主目录）", () => {
        vi.stubEnv("NAPKETTO_CONFIG", "");
        vi.stubEnv("NAPKETTO_DATA", "");
        const p = resolveConfigPath();
        expect(p).toBe(join(homedir(), DEFAULT_DATA_ROOT_NAME, MAIN_CONFIG_FILE));
    });
});
