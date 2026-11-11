/**
 * package-info.ts：运行时读取本包 package.json 元数据。
 *
 * ESM 下用 import.meta.url 定位包根（dist/ 与包根同层：dist/index.mjs → ../package.json）；
 * CJS 输出由 rolldown 将 import.meta.url 转为 pathToFileURL(__filename) 等价形式，
 * 定位行为不变（设计文档 §发布形态）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./package-root.js";

/**
 * 读取本包版本号；失败（发布产物缺 package.json / 解析异常）兜底 "0.0.0"。
 * 仅用于下载 User-Agent 等非关键元数据，失败不阻塞主流程。
 */
export function loaderVersion(): string {
    try {
        const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version !== "") {
            return parsed.version;
        }
    } catch {
        // 读取/解析失败——仅影响 UA 与日志标识，兜底即可
    }
    return "0.0.0";
}
