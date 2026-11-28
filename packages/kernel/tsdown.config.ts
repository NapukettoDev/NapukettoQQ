/**
 * tsdown.config.ts：@napuketto/kernel 构建（2026-11-03 起 Pure ESM）。
 *
 * 产物：dist/index.mjs（ESM）+ dist/index.d.mts。
 *
 * 为什么不再出 .cjs（2026-11-03 依赖审计整改）：
 *   - 运行时底线已是 Node >=24.11，
 *     `require(esm)` 默认开启，无顶层 await 的 ESM 可被 CJS 同步 require；
 *   - 双包会让 kernel 的模块状态（原生交互层缓存等）在 CJS / ESM 图里各实例化
 *     一份（Dual-Package Hazard）；
 *   - CommonJS 消费方的 `require("@napuketto/kernel")` 经 exports 的 default 条件命中
 *     dist/index.mjs，由 Node 原生 require(esm) 加载。
 *
 * 依赖（pino / smol-toml）保持 external；三种控制台日志格式（pretty / single-line /
 * json）由 kernel 自身渲染，不再需要 pino-pretty 之类的 optional peer。
 */
import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    clean: true,
    dts: true,
});
