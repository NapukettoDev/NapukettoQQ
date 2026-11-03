/**
 * package-exports.test.ts：发布包 `exports` / 元数据形状守卫（2026-11-03 重写）。
 *
 * 背景（2026-10-21）：有用户反馈 `@napuketto/kernel` 在 `moduleResolution:
 * nodenext` 下读不到类型，建议把 `"types"` 直接挂到 `exports["."]` 顶层。
 * 双格式包（dist 同时产出 .mjs / .cjs）若把这行放在 `import` 之前，CJS
 * 消费者会被解析到 ESM 声明文件（attw 报 Masquerading as ESM）。
 *
 * 2026-11-03 依赖审计整改后全仓转 **Pure ESM**（运行时底线 Node >=22.12，
 * `require(esm)` 原生可用）：不再产出 .cjs / .d.cts，`exports` 只保留
 * `types` + `default` 两个条件。CJS 消费方 `require()` 走 default 条件命中
 * `.mjs`，由 Node 的 require(esm) 同步加载；子路径（adapter 的 ./onebot11 等）
 * 过去只写 `import` 条件，CJS 解析会报 ERR_PACKAGE_PATH_NOT_EXPORTED，现在
 * 全部补上 `default`。
 *
 * 同时守护发布元数据：`engines.node`（安装期拦截旧 Node）、`sideEffects: false`
 * （打包器可摇树）、`publishConfig.access: public`（scope 包默认 private）。
 *
 * 断言依赖构建产物（dist 里的 .d.mts / .mjs）；CI 与本地 prepare 都先 build。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 全部发布包（7 个：5 个 packages + 2 个 apps）。 */
const PUBLISHED_PACKAGES = [
    "packages/kernel",
    "packages/media",
    "packages/network",
    "packages/adapter",
    "packages/loader",
    "apps/cli",
    "apps/napuketto-create",
] as const;

/** 库包：可被 import，必须声明 sideEffects: false 让打包器摇树。 */
const LIBRARY_PACKAGES = new Set<string>([
    "packages/kernel",
    "packages/media",
    "packages/network",
    "packages/adapter",
    "packages/loader",
]);

/**
 * 有 `exports` 的包（create-napukettoqq 只有 bin，不导出模块）。
 * ⚠️ apps/cli 与 create-napukettoqq 是 bin 包，**不**声明 sideEffects: false：
 * 它们的入口在顶层就执行 main()（import 即启动机器人/脚手架），声明无副作用
 * 属于虚假元数据。
 */
const EXPORTING_PACKAGES = PUBLISHED_PACKAGES.filter((dir) => dir !== "apps/napuketto-create");

/** Node 运行时底线：commander@15 / execa@10 硬要求，也是 require(esm) 的起点。 */
const MIN_NODE = ">=22.12.0";

interface PackageJson {
    name: string;
    main?: string;
    exports?: Record<string, Record<string, string> | undefined>;
    engines?: { node?: string };
    sideEffects?: boolean;
    publishConfig?: { access?: string };
}

function readPackage(dir: string): { pkg: PackageJson; pkgDir: string } {
    const pkgDir = join(repoRoot, dir);
    return {
        pkg: JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson,
        pkgDir,
    };
}

for (const dir of PUBLISHED_PACKAGES) {
    const { pkg } = readPackage(dir);

    describe(`${pkg.name} 发布元数据`, () => {
        it("engines.node 锁死运行底线", () => {
            expect(pkg.engines?.node).toBe(MIN_NODE);
        });

        it("sideEffects: false（仅库包：bin 包 import 即执行，不能这么声明）", () => {
            if (LIBRARY_PACKAGES.has(dir)) {
                expect(pkg.sideEffects).toBe(false);
            } else {
                expect(pkg.sideEffects).not.toBe(false);
            }
        });

        it("publishConfig.access: public（scope 包默认 private）", () => {
            expect(pkg.publishConfig?.access).toBe("public");
        });

        it("main 指向 .mjs（不再有 .cjs 入口）", () => {
            expect(pkg.main?.endsWith(".mjs")).toBe(true);
        });
    });
}

for (const dir of EXPORTING_PACKAGES) {
    const { pkg, pkgDir } = readPackage(dir);

    describe(`${pkg.name} exports`, () => {
        it("每个入口只有 types + default 两个条件", () => {
            const entries = Object.entries(pkg.exports ?? {});
            expect(entries.length).toBeGreaterThan(0);
            for (const [, branches] of entries) {
                expect(branches).toBeDefined();
                if (branches === undefined) {
                    continue;
                }
                // 条件顺序有意义：types 必须在前，default 兜底在后
                expect(Object.keys(branches)).toEqual(["types", "default"]);
                expect(branches["types"]?.endsWith(".d.mts")).toBe(true);
                expect(branches["default"]?.endsWith(".mjs")).toBe(true);
            }
        });

        it("引用的声明与产物文件都存在（需先 build）", () => {
            for (const branches of Object.values(pkg.exports ?? {})) {
                if (branches === undefined) {
                    continue;
                }
                for (const file of Object.values(branches)) {
                    expect(existsSync(join(pkgDir, file)), `${pkg.name} 缺少 ${file}`).toBe(true);
                }
            }
        });

        it("构建产物里没有 .cjs / .d.cts（Pure ESM）", () => {
            for (const branches of Object.values(pkg.exports ?? {})) {
                if (branches === undefined) {
                    continue;
                }
                for (const file of Object.values(branches)) {
                    expect(file.endsWith(".cjs") || file.endsWith(".d.cts")).toBe(false);
                }
            }
        });
    });
}

// 子路径必须带 default 条件：CJS `require("@napuketto/adapter/onebot11")` 过去
// 因只声明 import 条件直接 ERR_PACKAGE_PATH_NOT_EXPORTED（2026-11-03 修复）。
describe("@napuketto/adapter 子路径 CJS 可达性", () => {
    const { pkg } = readPackage("packages/adapter");

    it("每个子路径都有 default 条件", () => {
        const subpaths = Object.keys(pkg.exports ?? {}).filter((key) => key !== ".");
        expect(subpaths).toEqual(["./core", "./onebot11", "./satori", "./kurobot", "./milky"]);
        for (const key of subpaths) {
            expect(pkg.exports?.[key]?.["default"]).toBeDefined();
        }
    });
});
