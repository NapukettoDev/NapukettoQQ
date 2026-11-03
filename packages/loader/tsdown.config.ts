/**
 * tsdown.config.ts：@napuketto/loader 双构建（2026-08-07 阶段 2；2026-11-03 对外 API 转 Pure ESM）。
 *
 * 配置 1 —— 对外 API（index）：**仅 ESM** + d.mts（2026-11-03）。
 *   运行时底线 Node >=22.12（require(esm) 原生可用），koishi 适配器已独立成仓，
 *   CJS 产物不再有消费方；`require("@napuketto/loader")` 经 exports 的 default
 *   条件命中 dist/index.mjs，由 Node 原生 require(esm) 加载。
 * 配置 2 —— 自建宿主引导运行时（host/self-host）：CJS 单文件 bundle，
 *   rolldown 将 src/host/ 依赖树（bootstrap/login/session/protocols/smoke/util/
 *   types/env）全部内联进 dist/host/self-host.cjs，node 内置模块保持 external。
 *   产物被 launcher.launchSelfHost() spawn 直接执行（node dist/host/self-host.cjs），
 *   .cjs 扩展名自声明 CommonJS（包根 "type": "module"），无需再复制 runtime 目录。
 *   ⚠️ 这是内部被 spawn 的进程入口，不是对外 API，与配置 1 的 ESM-only 不冲突。
 */
import { defineConfig } from "tsdown";

export default defineConfig([
    {
        // 对外 API（apps/cli、koishi 适配器消费）：仅 ESM
        entry: { index: "src/index.ts" },
        format: ["esm"],
        platform: "node",
        clean: true,
    },
    {
        // 自建宿主引导运行时：CJS 单文件（launcher spawn 入口）
        entry: { "host/self-host": "src/host/core/self-host.ts" },
        format: ["cjs"],
        platform: "node",
        // 避免第二个构建清掉 index 产物（第一个配置已 clean）
        clean: false,
        // host 是内部入口，不需要对外类型声明
        dts: false,
    },
]);
