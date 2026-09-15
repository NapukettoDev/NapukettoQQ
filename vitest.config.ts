/**
 * Vitest 配置（2026-08-08 fallow 重构引入）
 *
 * fallow 的 refactoring targets 标注「untested risk · add tests before
 * modifying」——先建测试设施写基线，再在测试保护下重构。
 *
 * 测试文件放在各包 src/ 内（与源码相邻，biome + tsc 自动纳入检查），
 * 只测包内纯函数（相对路径导入，不依赖跨包构建产物）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "packages/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            // 发布工具链（koishi 适配器依赖同步等）也纳入单测
            "scripts/**/*.test.ts",
        ],
        environment: "node",
        coverage: {
            provider: "v8",
            // lcov（lcov.info）供 CI 上传 Codecov；json 供 fallow health 消费
            reporter: ["json", "lcov", "text-summary"],
            // fallow health --coverage 读 istanbul 格式 json（json 报告默认即此格式）
            // 只统计生产代码（排除测试文件自身）
            exclude: ["**/*.test.ts", "**/*.test-d.ts"],
        },
    },
});
