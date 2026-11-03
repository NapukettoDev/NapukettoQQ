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
 * （打包器可摇树）、`publishConfig.access: public`（scope 包默认 private）、
 * `publishConfig.provenance: true`（OIDC 发布带 SLSA 溯源）、`files` 白名单
 * （只发 dist，别把 tsconfig / 测试快照打进 tarball）。
 *
 * 2026-11-03 追加三条回退门禁：catalog 强制令（catalog 内的包只能写 `catalog:`）、
 * 内联体积熔断（media dist 不许把第三方库 bundle 回来）、发布字段齐备性。
 *
 * 断言依赖构建产物（dist 里的 .d.mts / .mjs）；CI 与本地 prepare 都先 build。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    private?: boolean;
    main?: string;
    exports?: Record<string, Record<string, string> | undefined>;
    engines?: { node?: string };
    sideEffects?: boolean;
    files?: string[];
    publishConfig?: { access?: string; provenance?: boolean };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

function readPackage(dir: string): { pkg: PackageJson; pkgDir: string } {
    const pkgDir = join(repoRoot, dir);
    return {
        pkg: JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson,
        pkgDir,
    };
}

/** 工作区全部包目录（根 + packages/* + apps/*，含 private 包）。 */
function workspacePackageDirs(): string[] {
    const dirs: string[] = ["."];
    for (const group of ["packages", "apps"]) {
        for (const entry of readdirSync(join(repoRoot, group), { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (existsSync(join(repoRoot, group, entry.name, "package.json"))) {
                dirs.push(`${group}/${entry.name}`);
            }
        }
    }
    return dirs;
}

/**
 * 读取 pnpm-workspace.yaml 默认 catalog 的包名。
 *
 * 只为一条守卫断言引入 YAML 解析器不划算（会多一个依赖），这里按缩进扫
 * `catalog:` 段：顶层键（无缩进）即段落结束，段内每行 `  包名: 版本`。
 */
function readCatalogNames(): string[] {
    const yaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const names: string[] = [];
    let inCatalog = false;
    for (const raw of yaml.split("\n")) {
        const line = raw.trimEnd();
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            continue;
        }
        if (line === "catalog:") {
            inCatalog = true;
            continue;
        }
        if (!inCatalog) {
            continue;
        }
        if (!/^\s{2}\S/.test(line)) {
            break; // 回到顶层键 → catalog 段结束
        }
        const match = /^\s{2}(?:"([^"]+)"|'([^']+)'|([^:\s]+)):\s*\S/.exec(line);
        const name = match?.[1] ?? match?.[2] ?? match?.[3];
        if (name !== undefined) {
            names.push(name);
        }
    }
    return names;
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

        it("publishConfig.provenance: true（OIDC 发布自动带 SLSA 溯源）", () => {
            expect(pkg.publishConfig?.provenance).toBe(true);
        });

        it("files 白名单包含 dist（不按 .gitignore 推导打包内容）", () => {
            expect(pkg.files).toContain("dist");
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

// 回退门禁 1（2026-11-03）：同名依赖进了 catalog 就必须写 "catalog:"，
// 否则同一包在子包间可以再次分叉出两个版本（vitest 4/5、@types/node 24/26 的老问题）。
describe("catalog 强制令", () => {
    const catalogNames = readCatalogNames();

    it("catalog 段可解析且非空", () => {
        expect(catalogNames.length).toBeGreaterThan(0);
    });

    for (const dir of workspacePackageDirs()) {
        const { pkg } = readPackage(dir);

        it(`${pkg.name} 的 catalog 依赖全部写 "catalog:"`, () => {
            const declared = {
                ...pkg.dependencies,
                ...pkg.devDependencies,
                ...pkg.peerDependencies,
                ...pkg.optionalDependencies,
            };
            for (const [name, spec] of Object.entries(declared)) {
                if (catalogNames.includes(name)) {
                    expect(spec, `${pkg.name} 的 ${name} 应写 catalog:，实际 ${spec}`).toBe(
                        "catalog:",
                    );
                }
            }
        });
    }
});

// 回退门禁 2（2026-11-03）：media 曾经把 execa / file-type 内联进产物（383 KB，
// 下游 audit 看不到、无法 override 热修）。dist 体积熔断：谁把 alwaysBundle 加
// 回来，这条断言当场红灯。
describe("发布产物不内联第三方依赖", () => {
    it("packages/media/dist/index.mjs 小于 50 KB", () => {
        const dist = join(repoRoot, "packages/media/dist/index.mjs");
        expect(existsSync(dist), "需先 pnpm -r build").toBe(true);
        expect(statSync(dist).size).toBeLessThan(50 * 1024);
    });
});
