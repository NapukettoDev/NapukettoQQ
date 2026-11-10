/**
 * CLI 自身版本号（`--version` 输出）。
 *
 * 2026-11-10 修复：此前 `program.version("0.0.1")` 是硬编码字面量，导致 npm 上
 * 无论发到哪个版本，`napuketto --version` 都自报 `0.0.1`（补发 0.5.14 后冒烟发现）。
 * 改为运行时读自身 `package.json`，发版由 changesets 改那一处即可自动跟随。
 *
 * 候选路径（先命中先用，且要求 `name` 对得上，避免读到别家的 package.json）：
 *   - `../package.json`：生产形态。tsdown 打成单文件 `dist/index.mjs`，
 *     相对 dist 上一级即包根。
 *   - `../../package.json`：源码直跑形态（vitest / tsx），
 *     本文件位于 `src/cli/`，往上两级即包根。
 *
 * 都读不到（被裁剪的异常部署）兜底 `0.0.0-unknown`，不抛错——版本号拿不到
 * 不该让整个 CLI 起不来。
 */
import { readFileSync } from "node:fs";

/** 读不到 package.json 时的兜底版本号。 */
export const VERSION_FALLBACK = "0.0.0-unknown";

/** 自身包名，用于校验候选 package.json 确实是本包。 */
const SELF_NAME = "@napuketto/cli";

/** 候选 package.json 相对路径（按命中概率排序）。 */
const CANDIDATES = ["../package.json", "../../package.json"] as const;

/**
 * 取 CLI 自身版本号。
 * @returns package.json 的 `version`；全部候选失败时为 {@link VERSION_FALLBACK}。
 */
export function cliVersion(): string {
    for (const rel of CANDIDATES) {
        try {
            const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (
                pkg.name === SELF_NAME &&
                typeof pkg.version === "string" &&
                pkg.version.length > 0
            ) {
                return pkg.version;
            }
        } catch {
            // 候选不存在 / 不是合法 JSON → 试下一个
        }
    }
    return VERSION_FALLBACK;
}
