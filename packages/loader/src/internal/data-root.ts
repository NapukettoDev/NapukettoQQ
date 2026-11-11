/**
 * data-root.ts：轻量数据根解析（loader 侧，避免新增 kernel 依赖）。
 *
 * 从 locate-qq.ts / win-node.ts 抽出的同构逻辑（2026-08 消重：两处
 * 22 行重复 resolveDataRoot + findProjectRoot）。
 *
 * 优先级：显式参数 > NAPKETTO_DATA > 项目根/.napuketto > cwd 兜底。
 * P2 若需完整语义（同 kernel resolveDataRoot）再切换。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

/** 解析数据根（NAPKETTO_DATA 显式 > 项目根/.napuketto > cwd 兜底）。 */
export function resolveDataRoot(dataRoot?: string): string {
    const explicit = dataRoot ?? process.env["NAPKETTO_DATA"];
    if (explicit !== undefined && explicit !== "") {
        return resolve(explicit);
    }
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    return join(projectRoot, ".napuketto");
}

/** 向上探测项目根（含 pnpm-workspace.yaml 或 package.json 的目录）。 */
function findProjectRoot(start: string): string | null {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, "package.json"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}
