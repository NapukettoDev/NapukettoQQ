/**
 * package-root.ts：从当前模块位置向上定位本包根目录。
 *
 * 为什么不用固定层数：源码按分组放在 `src/<group>/`，构建产物是单文件 bundle
 * （`dist/index.mjs`）或子进程 bundle（`dist/host/self-host.cjs`），三者到包根的
 * 层级不同；单测又直接跑源码。向上找最近的 `package.json` 对三者都成立
 * （2026-11-11 分组重构：此前 `dirname(x2)` 的写法在 `src/<group>/` 下会指向
 * `src/`，导致清单/资产路径全错）。
 *
 * 结果按进程缓存——同一次运行内包根不变。
 */
import { existsSync } from "node:fs";
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
