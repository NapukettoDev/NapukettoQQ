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
            "tooling/**/*.test.ts",
        ],
        environment: "node",
        coverage: {
            provider: "v8",
            // lcov（lcov.info）供 CI 上传 Codecov；json 供 fallow health 消费
            reporter: ["json", "lcov", "text-summary"],
            // fallow health --coverage 读 istanbul 格式 json（json 报告默认即此格式）
            // 只统计本仓生产代码（排除测试文件自身）。注意 exclude 是整体覆盖默认
            // 列表而非追加——2026-10-25 修正：此前只写测试文件模式，把 vitest
            // 默认排除（node_modules / dist 等）顶掉了，第三方依赖被计入分母，
            // 整体覆盖率被严重稀释（Codecov 同吃此数据）。
            //
            // 2026-11-05 修正：只排除 `*.test.ts` 漏掉了测试支撑文件
            // （mock 上下文 / fake 服务端的 `test-support.ts`，被 *.test.ts
            // import 后进 lcov）。Codecov 的 patch 视角把它当生产代码，报
            // 「patch coverage 57% · 6 lines missing」要求给测试助手补单测——
            // 测试支撑不是发布产物，不该进入分子/分母。两条模式互补：
            // `__tests__/**` 挡住测试目录里的任何助手（含 adapter 的
            // kurobot/milky/satori/onebot11 与 network/media/loader），
            // `test-support.ts` 挡住 2026-11 补测时放在 src 根的那几个
            // （apps/cli、kernel 的 apis/bridge/wrapper）。新增助手命名沿用
            // test-support.ts 或放 `__tests__/` 内即可自动豁免。
            exclude: [
                "coverage/**",
                "**/node_modules/**",
                "**/dist/**",
                "packages/*/test?(s)/**",
                "**/__tests__/**",
                "**/test-support.ts",
                "**/*.test.ts",
                "**/*.test-d.ts",
                "**/*.d.ts",
            ],
        },
    },
});
