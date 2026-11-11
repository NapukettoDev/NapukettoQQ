/**
 * launcher.test.ts：win32 非 node 宿主解析链单测（isNodeExecutable /
 * resolveWinHostNode，2026-09-05 Bun 宿主 dlopen 1114 修复）。
 * 探测/下载均注入假实现，不依赖真实 node 环境（探测全注入，不触真实二进制）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNodeExecutable, resolveWinHostNode } from "../launcher.js";

const tmpDirs: string[] = [];

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** 造一个临时「node.exe」占位文件（existsSync 校验用，无需真可执行）。 */
function fakeNodeExe(name = "node.exe"): string {
    const dir = mkdtempSync(join(tmpdir(), "napuketto-launcher-"));
    tmpDirs.push(dir);
    const exe = join(dir, name);
    writeFileSync(exe, "");
    return exe;
}

describe("isNodeExecutable", () => {
    it("node.exe / node 判定为 node 宿主", () => {
        expect(isNodeExecutable("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
        expect(isNodeExecutable("C:\\Program Files\\nodejs\\node.EXE")).toBe(true);
        expect(isNodeExecutable("/usr/local/bin/node")).toBe(true);
    });

    it("bun.exe / 其他可执行判定为非 node 宿主", () => {
        expect(isNodeExecutable("C:\\Users\\x\\.bun\\bin\\bun.exe")).toBe(false);
        expect(isNodeExecutable("/usr/bin/electron")).toBe(false);
        expect(isNodeExecutable("D:\\node_modules\\")).toBe(false);
    });
});

describe("resolveWinHostNode", () => {
    it("显式路径命中：直接使用，不做系统探测", async () => {
        const exe = fakeNodeExe();
        let probed = false;
        const path = await resolveWinHostNode(
            { explicitPath: exe },
            {
                findSystemNode: () => {
                    probed = true;
                    return undefined;
                },
            },
        );
        expect(path).toBe(exe);
        expect(probed).toBe(false);
    });

    it("显式路径不存在：跳过，走系统 node", async () => {
        const path = await resolveWinHostNode(
            { explicitPath: "D:\\不存在\\node.exe" },
            {
                findSystemNode: () => ({
                    exePath: "C:\\Program Files\\nodejs\\node.exe",
                    version: "v24.16.0",
                }),
            },
        );
        expect(path).toBe("C:\\Program Files\\nodejs\\node.exe");
    });

    it("NAPUTO_WIN_NODE_PATH 环境变量作为显式覆盖（未传参数时）", async () => {
        const exe = fakeNodeExe();
        const prev = process.env["NAPUTO_WIN_NODE_PATH"];
        process.env["NAPUTO_WIN_NODE_PATH"] = exe;
        try {
            const path = await resolveWinHostNode({}, { findSystemNode: () => undefined });
            expect(path).toBe(exe);
            if (path === undefined) throw new Error("应解析出显式路径");
            expect(existsSync(path)).toBe(true);
        } finally {
            if (prev === undefined) {
                delete process.env["NAPUTO_WIN_NODE_PATH"];
            } else {
                process.env["NAPUTO_WIN_NODE_PATH"] = prev;
            }
        }
    });

    it("系统 node 缺失：兜底 ensureWinNode 下载", async () => {
        let ensured = false;
        const path = await resolveWinHostNode(
            { dataRoot: "D:\\data" },
            {
                findSystemNode: () => undefined,
                ensureWinNode: async (opts) => {
                    ensured = true;
                    expect(opts).toEqual({ dataRoot: "D:\\data" });
                    return {
                        exePath: "D:\\data\\runtime\\win-node\\v24.16.0\\node.exe",
                        version: "v24.16.0",
                    };
                },
            },
        );
        expect(ensured).toBe(true);
        expect(path).toBe("D:\\data\\runtime\\win-node\\v24.16.0\\node.exe");
    });

    it("onStage 播报宿主切换与解析结果", async () => {
        const exe = fakeNodeExe();
        const stages: string[] = [];
        await resolveWinHostNode({ explicitPath: exe, onStage: (m) => stages.push(m) });
        expect(stages.some((m) => m.includes("显式指定 node"))).toBe(true);

        stages.length = 0;
        await resolveWinHostNode(
            { onStage: (m) => stages.push(m) },
            {
                findSystemNode: () => ({ exePath: "C:\\node.exe", version: "v24.16.0" }),
            },
        );
        expect(stages.some((m) => m.includes("非 node"))).toBe(true);
        expect(stages.some((m) => m.includes("系统 node v24.16.0"))).toBe(true);
    });
});
