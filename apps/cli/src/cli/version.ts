/**
 * CLI 自身版本号（`--version` 输出）：运行时读自身 `package.json`，发版只改那一处。
 * 候选路径先命中先用且校验 `name`，避免读到别家的 package.json（被裁剪的异常部署才会命中兜底）。
 */
import { readFileSync } from "node:fs";
import { isRecord } from "@napuketto/kernel";

/** 读不到 package.json 时的兜底版本号。 */
export const VERSION_FALLBACK = "0.0.0-unknown";

/** 自身包名，用于校验候选 package.json 确实是本包。 */
const SELF_NAME = "@napuketto/cli";

/**
 * 候选 package.json 相对路径（按命中概率排序）：`../` 是 tsdown 单文件 `dist/index.mjs` 的生产形态，
 * `../../` 是源码直跑（vitest / tsx）形态——本文件位于 `src/cli/`，往上两级才是包根。
 */
const CANDIDATES = ["../package.json", "../../package.json"] as const;

/**
 * 取 CLI 自身版本号。
 * @returns package.json 的 `version`；全部候选失败时为 {@link VERSION_FALLBACK}。
 */
export function cliVersion(): string {
    for (const rel of CANDIDATES) {
        try {
            const parsed: unknown = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
            if (
                isRecord(parsed) &&
                parsed["name"] === SELF_NAME &&
                typeof parsed["version"] === "string" &&
                parsed["version"].length > 0
            ) {
                return parsed["version"];
            }
        } catch {
            // 候选不存在 / 不是合法 JSON → 试下一个
        }
    }
    return VERSION_FALLBACK;
}
