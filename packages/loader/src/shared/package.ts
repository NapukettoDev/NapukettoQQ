/**
 * package.ts：本包根目录定位与 package.json 元数据读取（向上找最近的 package.json）。
 * 源码在 src/<group>/、产物是单文件 bundle、单测直接跑源码，三者层级不同，固定 dirname 层数会指向错目录。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** 本包根目录（最近的含 package.json 的祖先目录）。 */
export function packageRoot(): string {
    if (cached !== undefined) {
        return cached;
    }
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(join(dir, "package.json"))) {
            cached = dir;
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error(`无法定位 @napuketto/loader 包根：从 ${dir} 向上未找到 package.json`);
        }
        dir = parent;
    }
}

/**
 * 读取本包版本号；失败（缺 package.json / 解析异常）兜底 "0.0.0"——仅用于 User-Agent 等非关键元数据。
 * ESM 与 CJS 产物都靠 import.meta.url 定位包根（CJS 下 rolldown 转成 pathToFileURL(__filename)）。
 */
export function loaderVersion(): string {
    try {
        const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
            const version: unknown = parsed.version;
            if (typeof version === "string" && version !== "") {
                return version;
            }
        }
    } catch {
        // 读取/解析失败——仅影响 UA 与日志标识，兜底即可
    }
    return "0.0.0";
}
