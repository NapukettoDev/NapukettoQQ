/**
 * Vitest 配置（2026-08-08 fallow 重构引入）
 *
 * fallow 的 refactoring targets 标注「untested risk · add tests before
 * modifying」——先建测试设施写基线，再在测试保护下重构。
 *
 * 测试文件统一放各包根 `tests/`（镜像 `src/` 子目录结构，由 biome + 根 tsc
 * 纳入检查），只测包内纯函数（相对路径导入，不依赖跨包构建产物）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "packages/*/tests/**/*.test.ts",
            "apps/*/tests/**/*.test.ts",
            // 发布工具链（koishi 适配器依赖同步等）与产物契约测试（package-exports /
            // embedded-dx）也纳入单测。后者只走裸 specifier 并断言 dist 产物，前置
            // `pnpm -r build`（CI 已保证）；放进 packages/ 会让「包内测试不依赖构建产物」
            // 这条约束失真。
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
            // 测试支撑不是发布产物，不该进入分子/分母。整个测试目录排除即可
            // （各包根 `tests/`，2026-11-25 loader 已迁入；tooling 仍保留
            // `tooling/release/__tests__/`）：助手文件一律放测试目录内。同日把
            // 2026-11 补测时错放在 src 根的 4 个 test-support.ts（apps/cli 与
            // kernel 的 apis/bridge/wrapper）迁回各自测试目录，与其余包一致。
            exclude: [
                "coverage/**",
                "**/node_modules/**",
                "**/dist/**",
                "packages/*/test?(s)/**",
                "apps/*/tests/**",
                // tooling/release/__tests__/ 仍使用该目录名（packages/apps 已统一 tests/）。
                "**/__tests__/**",
                "**/*.test.ts",
                "**/*.test-d.ts",
                "**/*.d.ts",
                // 纯门面 / 纯类型 / 反射探针 / CLI 顶层入口没有可回归的业务逻辑：
                // 删掉凑数单测后不应再拉低分母（也不触发 Fallow CRAP 告警）。
                // 门面重导出由 tsc 与 tooling/package-exports.test.ts 守卫。
                "**/index.ts",
                "**/types.ts",
                "**/types/**",
                "packages/kernel/src/native/probe/**",
                "packages/kernel/src/native/wrapper/wrapper-adapters.ts",
                "apps/cli/src/cli/program.ts",
                "apps/cli/src/cli/version.ts",
            ],
            // 工程水位：覆盖真实分支即可，不设 90%+ 逼人写「只测调用次数」的假单测。
            thresholds: {
                lines: 70,
                functions: 70,
                branches: 65,
                statements: 70,
            },
        },
    },
});
