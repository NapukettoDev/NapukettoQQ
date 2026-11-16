/**
 * data-root.ts：轻量数据根解析（loader 侧，避免新增 kernel 依赖）。
 *
 * 从 locate-qq.ts / win-node.ts 抽出的同构逻辑（2026-08 消重：两处
 * 22 行重复 resolveDataRoot + findProjectRoot）。
 *
 * 语义与 kernel `resolveDataRoot`（packages/kernel/src/infra/paths.ts）对齐：
 * 显式参数 > `NAPUKETTO_DATA` ?? `NAPKETTO_DATA` > 项目根/.napuketto > 用户目录兜底；
 * 支持 `~` 前缀展开（跨平台配置文件写法 `dataDir = "~/.napuketto"`）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

/** 默认数据根目录名（与 kernel `DEFAULT_DATA_ROOT_NAME` 同值）。 */
const DEFAULT_DATA_ROOT_NAME = ".napuketto";

/** `~` 前缀展开为用户主目录（与 kernel `expandTilde` 同语义）。 */
function expandTilde(p: string): string {
    if (p === "~") {
        return homedir();
    }
    if (p.startsWith("~/") || p.startsWith("~\\")) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

/** 解析数据根（显式参数 > NAPUKETTO_DATA/NAPKETTO_DATA > 项目根/.napuketto > 用户目录兜底）。 */
export function resolveDataRoot(dataRoot?: string): string {
    const explicit = dataRoot ?? process.env["NAPUKETTO_DATA"] ?? process.env["NAPKETTO_DATA"];
    if (explicit !== undefined && explicit !== "") {
        return resolve(expandTilde(explicit));
    }
    const projectRoot = findProjectRoot(process.cwd());
    if (projectRoot !== null) {
        return join(projectRoot, DEFAULT_DATA_ROOT_NAME);
    }
    return join(homedir(), DEFAULT_DATA_ROOT_NAME);
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
