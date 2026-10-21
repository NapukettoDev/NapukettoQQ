/**
 * package-exports.test.ts：发布包 `exports` 形状守卫。
 *
 * 背景（2026-10-21）：有用户反馈 `@napuketto/kernel` 在 `moduleResolution:
 * nodenext` 下读不到类型，建议把 `"types"` 直接挂到 `exports["."]` 顶层。
 * 双格式包（dist 同时产出 .mjs / .cjs）若把这行放在 `import` 之前，CJS
 * 消费者会被解析到 ESM 声明文件（attw 报 Masquerading as ESM），所以正确
 * 形状是：import / require 各自声明匹配格式的 types，顶层再补一个 types
 * 兜底——且 MUST 排在 import / require 之后，否则条件匹配会先命中它。
 *
 * 断言依赖构建产物（dist 里的 .d.mts / .d.cts）；CI 与本地 prepare 都先 build。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 同时发布 ESM / CJS 的包（构建产物有 index.mjs + index.cjs）。 */
const DUAL_FORMAT_PACKAGES = ["packages/kernel", "packages/media", "packages/loader"] as const;

type ExportTarget = string | { types?: string; default?: string };

interface PackageJson {
    name: string;
    exports?: Record<string, Record<string, ExportTarget> | undefined>;
}

/** 取 `exports["."]` 的条件对象；形状不对直接炸，避免守卫静默失效。 */
function rootCondition(pkg: PackageJson): Record<string, ExportTarget> {
    const entry = pkg.exports?.["."];
    if (typeof entry !== "object" || entry === null) {
        throw new Error(`${pkg.name} 的 exports["."] 不是条件对象`);
    }
    return entry;
}

for (const dir of DUAL_FORMAT_PACKAGES) {
    const pkgDir = join(repoRoot, dir);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;

    describe(`${pkg.name} exports["."]`, () => {
        const branches = rootCondition(pkg);

        it("import / require 分支各自声明匹配格式的 types", () => {
            expect(branches["import"]).toEqual({
                types: "./dist/index.d.mts",
                default: "./dist/index.mjs",
            });
            expect(branches["require"]).toEqual({
                types: "./dist/index.d.cts",
                default: "./dist/index.cjs",
            });
        });

        it("顶层 types 兜底给只读顶层 condition 的解析器", () => {
            expect(branches["types"]).toBe("./dist/index.d.mts");
        });

        it("顶层 types 排在 import / require 之后", () => {
            expect(Object.keys(branches)).toEqual(["import", "require", "types"]);
        });

        it("引用的声明文件存在于构建产物", () => {
            for (const file of ["./dist/index.d.mts", "./dist/index.d.cts"]) {
                expect(existsSync(join(pkgDir, file)), `${pkg.name} 缺少 ${file}`).toBe(true);
            }
        });
    });
}
