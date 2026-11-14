/**
 * release-npm-core.test.ts：发布链核心逻辑单测。
 *
 * 覆盖 discoverPackages（临时目录模拟工作区）、planPublish、topoSort，
 * 以及依赖协议改写 rewriteDependencyProtocols（workspace:* / catalog:，发布前修复）
 * 与 parseCatalogSpecs / assertNoProtocolLeftovers。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    assertNoProtocolLeftovers,
    compareSemver,
    discoverPackages,
    latestPublishedVersion,
    parseCatalogSpecs,
    planPublish,
    rewriteDependencyProtocols,
    topoSort,
    type WorkspacePkg,
} from "../release-npm-core.ts";

let tmpRoot: string;

beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "napuketto-release-test-"));
});

afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
});

/** 在临时根目录下写入一个包，返回其 WorkspacePkg。 */
async function writePkg(
    relDir: string,
    name: string,
    deps: Record<string, string> = {},
    options: { isPrivate?: boolean } = {},
): Promise<WorkspacePkg> {
    const dir = join(tmpRoot, relDir);
    await mkdir(dir, { recursive: true });
    const pkg = {
        name,
        version: "0.0.1",
        ...(options.isPrivate === true ? { private: true } : {}),
        dependencies: deps,
    };
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 4), "utf8");
    return { name, dir, version: "0.0.1", dependencies: deps };
}

describe("discoverPackages", () => {
    it("发现 packages/* 与 apps/* 下的包", async () => {
        await writePkg("packages/kernel", "@napuketto/kernel");
        await writePkg("packages/media", "@napuketto/media");
        await writePkg("apps/cli", "@napuketto/cli");
        const pkgs = await discoverPackages(tmpRoot);
        const names = pkgs.map((p) => p.name).sort();
        expect(names).toEqual(["@napuketto/cli", "@napuketto/kernel", "@napuketto/media"]);
    });

    it("排除 private 包与无 package.json 的目录", async () => {
        await writePkg("packages/kernel", "@napuketto/kernel");
        await writePkg("packages/secret", "secret", {}, { isPrivate: true });
        await mkdir(join(tmpRoot, "packages", "empty"), { recursive: true });
        const pkgs = await discoverPackages(tmpRoot);
        expect(pkgs.map((p) => p.name)).toEqual(["@napuketto/kernel"]);
    });
});

describe("topoSort", () => {
    it("依赖链：被依赖者在前", () => {
        const kernel: WorkspacePkg = {
            name: "@napuketto/kernel",
            dir: "packages/kernel",
            version: "0.0.1",
            dependencies: {},
        };
        const media: WorkspacePkg = {
            name: "@napuketto/media",
            dir: "packages/media",
            version: "0.0.1",
            dependencies: {},
        };
        const adapter: WorkspacePkg = {
            name: "@napuketto/adapter",
            dir: "packages/adapter",
            version: "0.0.1",
            dependencies: {
                "@napuketto/kernel": "workspace:*",
                "@napuketto/media": "workspace:*",
            },
        };
        const cli: WorkspacePkg = {
            name: "@napuketto/cli",
            dir: "apps/cli",
            version: "0.0.1",
            dependencies: {
                "@napuketto/kernel": "workspace:*",
                "@napuketto/adapter": "workspace:*",
            },
        };
        const ordered = topoSort([cli, adapter, kernel, media]).map((p) => p.name);
        const pos = (name: string) => ordered.indexOf(name);
        expect(pos("@napuketto/kernel")).toBeLessThan(pos("@napuketto/adapter"));
        expect(pos("@napuketto/media")).toBeLessThan(pos("@napuketto/adapter"));
        expect(pos("@napuketto/adapter")).toBeLessThan(pos("@napuketto/cli"));
    });

    it("外部依赖不影响顺序", () => {
        const a: WorkspacePkg = {
            name: "a",
            dir: "a",
            version: "0.0.1",
            dependencies: { lodash: "^4.0.0" },
        };
        const b: WorkspacePkg = {
            name: "b",
            dir: "b",
            version: "0.0.1",
            dependencies: { react: "^18.0.0" },
        };
        expect(topoSort([a, b]).map((p) => p.name)).toEqual(["a", "b"]);
    });

    it("koishi 适配器的 tilde 范围同样命中内部依赖", () => {
        const kernel: WorkspacePkg = {
            name: "@napuketto/kernel",
            dir: "packages/kernel",
            version: "0.0.1",
            dependencies: {},
        };
        const koishi: WorkspacePkg = {
            name: "koishi-plugin-adapter-napuketto",
            dir: "apps/koishi-plugin-adapter",
            version: "0.0.1",
            dependencies: { "@napuketto/kernel": "~0.0.6" },
        };
        const ordered = topoSort([koishi, kernel]).map((p) => p.name);
        expect(ordered).toEqual(["@napuketto/kernel", "koishi-plugin-adapter-napuketto"]);
    });

    it("存在环 → 抛错", () => {
        const a: WorkspacePkg = {
            name: "a",
            dir: "a",
            version: "0.0.1",
            dependencies: { b: "workspace:*" },
        };
        const b: WorkspacePkg = {
            name: "b",
            dir: "b",
            version: "0.0.1",
            dependencies: { a: "workspace:*" },
        };
        expect(() => topoSort([a, b])).toThrow(/环/);
    });
});

describe("planPublish", () => {
    const mk = (name: string, version: string): WorkspacePkg => ({
        name,
        dir: name,
        version,
        dependencies: {},
    });

    it("版本已存在于 registry → 跳过；新版本 → 发布", () => {
        const pkgs = [mk("@napuketto/media", "0.0.1"), mk("@napuketto/adapter", "0.0.8")];
        const published = new Map([
            ["@napuketto/media", new Set(["0.0.1"])],
            ["@napuketto/adapter", new Set(["0.0.7"])],
        ]);
        const { toPublish, skipped } = planPublish(pkgs, published);
        expect(toPublish.map((p) => p.name)).toEqual(["@napuketto/adapter"]);
        expect(skipped.map((s) => s.pkg.name)).toEqual(["@napuketto/media"]);
        expect(skipped[0]?.reason).toContain("已在 registry");
    });

    it("registry 为空集（包从未发布）→ 全部发布", () => {
        const pkgs = [mk("@napuketto/brand-new", "0.0.1")];
        const { toPublish, skipped } = planPublish(
            pkgs,
            new Map([["@napuketto/brand-new", new Set()]]),
        );
        expect(toPublish.map((p) => p.name)).toEqual(["@napuketto/brand-new"]);
        expect(skipped).toEqual([]);
    });

    it("缺少 registry 版本信息 → 抛错（发布前必须查询）", () => {
        const pkgs = [mk("a", "0.0.1")];
        expect(() => planPublish(pkgs, new Map())).toThrow(/registry 版本信息/);
    });

    it("待发版本低于 registry 最高版本 → 跳过（npm 拒 latest 降级，2026-11-14 cli@0.6.1 事故）", () => {
        const pkgs = [mk("@napuketto/cli", "0.6.1")];
        const { toPublish, skipped } = planPublish(
            pkgs,
            new Map([["@napuketto/cli", new Set(["0.6.0", "0.6.2"])]]),
        );
        expect(toPublish).toEqual([]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.reason).toContain("0.6.2");
        expect(skipped[0]?.reason).toContain("取代");
    });

    it("待发版本高于 registry 最高版本 → 照常发布", () => {
        const pkgs = [mk("@napuketto/cli", "0.6.3")];
        const { toPublish, skipped } = planPublish(
            pkgs,
            new Map([["@napuketto/cli", new Set(["0.6.0", "0.6.2"])]]),
        );
        expect(toPublish.map((p) => p.name)).toEqual(["@napuketto/cli"]);
        expect(skipped).toEqual([]);
    });

    it("prerelease 比较生效：0.7.0-next.1 低于已发的 0.7.0-next.2 → 跳过", () => {
        const pkgs = [mk("@napuketto/cli", "0.7.0-next.1")];
        const { toPublish, skipped } = planPublish(
            pkgs,
            new Map([["@napuketto/cli", new Set(["0.7.0-next.2"])]]),
        );
        expect(toPublish).toEqual([]);
        expect(skipped).toHaveLength(1);
    });
});

describe("compareSemver", () => {
    it("相等 → 0；主 / 次 / 补丁位逐段比较", () => {
        expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
        expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
        expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
        expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    });

    it("正式版高于同号 prerelease；prerelease 数值标识按数值比较", () => {
        expect(compareSemver("0.6.2", "0.6.2-rc.0")).toBe(1);
        expect(compareSemver("0.7.0-next.2", "0.7.0-next.10")).toBe(-1);
        expect(compareSemver("0.7.0-next.2", "0.7.0-next.2")).toBe(0);
    });

    it("数值标识低于字母数字标识；前缀相同时标识多者高", () => {
        expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
        expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
        expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
        expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    });

    it("build metadata（+…）不参与比较", () => {
        expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
        expect(compareSemver("1.0.0-rc.1+build.5", "1.0.0-rc.1")).toBe(0);
    });

    it("非 semver 版本号 → 抛错（registry 数据异常不该静默放行）", () => {
        expect(() => compareSemver("abc", "1.0.0")).toThrow(/semver/);
        expect(() => compareSemver("1.2", "1.0.0")).toThrow(/semver/);
        expect(() => compareSemver("1.2.x", "1.0.0")).toThrow(/semver/);
    });
});

describe("latestPublishedVersion", () => {
    it("空集 → undefined", () => {
        expect(latestPublishedVersion(new Set())).toBeUndefined();
    });

    it("乱序集合取 semver 最高；prerelease 低于正式版", () => {
        expect(latestPublishedVersion(new Set(["0.5.9", "0.6.0", "0.5.10"]))).toBe("0.6.0");
        expect(latestPublishedVersion(new Set(["0.6.2-rc.1", "0.6.1"]))).toBe("0.6.2-rc.1");
        expect(latestPublishedVersion(new Set(["0.6.2-rc.1", "0.6.1", "0.6.2"]))).toBe("0.6.2");
    });
});

/** 构造带依赖的 package.json 文本（4 空格缩进，与仓库一致）。 */
function pkgJson(deps: Record<string, string>): string {
    return `{
    "name": "test-pkg",
    "version": "0.0.1",
    "dependencies": ${JSON.stringify(deps, null, 4)}
}
`;
}

describe("rewriteDependencyProtocols", () => {
    const versions = new Map([
        ["@napuketto/kernel", "0.0.10"],
        ["@napuketto/cli", "0.0.20"],
    ]);
    const catalog = new Map([
        ["zod", "^4.6.7"],
        ["@hono/node-server", "^2.1.6"],
    ]);

    it("把 dependencies 中的 workspace:* 改写为 caret 真实版本", () => {
        const raw = pkgJson({ "@napuketto/kernel": "workspace:*", commander: "^15.0.0" });
        const { text, changes } = rewriteDependencyProtocols(raw, versions);
        expect(changes).toEqual([
            { field: "dependencies", dep: "@napuketto/kernel", range: "^0.0.10" },
        ]);
        const parsed = JSON.parse(text) as { dependencies: Record<string, string> };
        expect(parsed.dependencies["@napuketto/kernel"]).toBe("^0.0.10");
        // 非 workspace:* 依赖原样保留
        expect(parsed.dependencies["commander"]).toBe("^15.0.0");
    });

    it("覆盖全部依赖字段（dev/optional/peer）", () => {
        const raw = JSON.stringify(
            {
                name: "test",
                version: "0.0.1",
                dependencies: { "@napuketto/cli": "workspace:*" },
                devDependencies: { "@napuketto/kernel": "workspace:*" },
                optionalDependencies: { "opt-pkg": "workspace:*" },
                peerDependencies: { "peer-pkg": "workspace:*" },
            },
            null,
            4,
        );
        const allVersions = new Map([...versions, ["opt-pkg", "0.1.0"], ["peer-pkg", "0.2.0"]]);
        const { changes } = rewriteDependencyProtocols(raw, allVersions);
        expect(changes.map((c) => c.dep).sort()).toEqual([
            "@napuketto/cli",
            "@napuketto/kernel",
            "opt-pkg",
            "peer-pkg",
        ]);
        // 各字段均改写为 caret 真实版本
        const parsed = JSON.parse(rewriteDependencyProtocols(raw, allVersions).text) as Record<
            string,
            Record<string, string>
        >;
        expect(parsed["dependencies"]?.["@napuketto/cli"]).toBe("^0.0.20");
        expect(parsed["devDependencies"]?.["@napuketto/kernel"]).toBe("^0.0.10");
        expect(parsed["optionalDependencies"]?.["opt-pkg"]).toBe("^0.1.0");
        expect(parsed["peerDependencies"]?.["peer-pkg"]).toBe("^0.2.0");
    });

    it("无协议依赖时原样返回（幂等，不重排）", () => {
        const raw = pkgJson({ commander: "^15.0.0" });
        const { text, changes, catalogChanges } = rewriteDependencyProtocols(
            raw,
            versions,
            catalog,
        );
        expect(changes).toEqual([]);
        expect(catalogChanges).toEqual([]);
        expect(text).toBe(raw);
    });

    it("工作区找不到的 workspace:* 依赖抛错（发布链中断）", () => {
        const raw = pkgJson({ "@napuketto/unknown": "workspace:*" });
        expect(() => rewriteDependencyProtocols(raw, versions)).toThrow(/工作区内找不到该包版本/);
    });

    it("把 catalog: 改写为 pnpm-workspace.yaml 的版本范围（2026-11-10 发布包泄漏修复）", () => {
        const raw = pkgJson({ zod: "catalog:", "@hono/node-server": "catalog:" });
        const { text, changes, catalogChanges } = rewriteDependencyProtocols(
            raw,
            versions,
            catalog,
        );
        expect(changes).toEqual([]);
        expect(catalogChanges).toEqual([
            { field: "dependencies", dep: "zod", range: "^4.6.7" },
            { field: "dependencies", dep: "@hono/node-server", range: "^2.1.6" },
        ]);
        const parsed = JSON.parse(text) as { dependencies: Record<string, string> };
        expect(parsed.dependencies["zod"]).toBe("^4.6.7");
        expect(parsed.dependencies["@hono/node-server"]).toBe("^2.1.6");
    });

    it("catalog 段缺条目 → 抛错（不静默发不可安装的包）", () => {
        const raw = pkgJson({ "unknown-pkg": "catalog:" });
        expect(() => rewriteDependencyProtocols(raw, versions, catalog)).toThrow(
            /catalog 段没有该条目/,
        );
    });

    it("未传 catalog 表时遇到 catalog: 同样抛错", () => {
        const raw = pkgJson({ zod: "catalog:" });
        expect(() => rewriteDependencyProtocols(raw, versions)).toThrow(/catalog 段没有该条目/);
    });

    it("命名 catalog（catalog:foo）与 workspace:^ 等未支持协议 → 抛错", () => {
        expect(() =>
            rewriteDependencyProtocols(pkgJson({ zod: "catalog:legacy" }), versions),
        ).toThrow(/命名 catalog/);
        expect(() =>
            rewriteDependencyProtocols(pkgJson({ "@napuketto/kernel": "workspace:^" }), versions),
        ).toThrow(/workspace 协议 "workspace:\^" 不受支持/);
    });
});

describe("parseCatalogSpecs", () => {
    it("解析默认 catalog 段：引号键值、行尾注释、CRLF、段外排除", () => {
        const yaml = [
            "packages:",
            '  - "packages/*"',
            "",
            "# 依赖审计整改",
            "catalog:",
            "  zod: ^4.6.7 # 行尾注释",
            '  "@hono/node-server": ^2.1.6',
            "  'ws': ^8.22.1",
            "",
            "overrides:",
            "  launch-editor: ^2.14.2",
        ].join("\r\n");
        expect([...parseCatalogSpecs(yaml)]).toEqual([
            ["zod", "^4.6.7"],
            ["@hono/node-server", "^2.1.6"],
            ["ws", "^8.22.1"],
        ]);
    });

    it("无 catalog 段 / 命名 catalogs 段 → 空表", () => {
        expect([...parseCatalogSpecs("packages:\n  - 'packages/*'\n")]).toEqual([]);
        expect([
            ...parseCatalogSpecs("catalogs:\n  legacy:\n    zod: ^3.0.0\ncatalog:\n  zod: ^4.6.7"),
        ]).toEqual([["zod", "^4.6.7"]]);
    });

    it("段内缺值 / 非键值行 → 跳过", () => {
        expect([...parseCatalogSpecs("catalog:\n  broken:\n  zod: ^4.6.7\n  : oops\n")]).toEqual([
            ["zod", "^4.6.7"],
        ]);
    });
});

describe("assertNoProtocolLeftovers", () => {
    it("残留 workspace:/catalog: → 抛错并列出（发布前最后一道闸）", () => {
        const raw = pkgJson({ zod: "catalog:", "@napuketto/kernel": "workspace:*" });
        expect(() => assertNoProtocolLeftovers(raw)).toThrow(
            /dependencies\.zod=catalog:, dependencies\.@napuketto\/kernel=workspace:\*/,
        );
    });

    it("真实版本范围 / 无 dependencies → 通过", () => {
        expect(() => assertNoProtocolLeftovers(pkgJson({ zod: "^4.6.7" }))).not.toThrow();
        expect(() => assertNoProtocolLeftovers(JSON.stringify({ name: "bare" }))).not.toThrow();
    });
});

describe("loadPackage 形状兜底（补充）", () => {
    it("缺 version → 0.0.0；缺 dependencies → 空表", async () => {
        const dir = join(tmpRoot, "packages", "bare");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "bare" }), "utf8");
        const pkgs = await discoverPackages(tmpRoot);
        expect(pkgs).toHaveLength(1);
        expect(pkgs[0]?.name).toBe("bare");
        expect(pkgs[0]?.version).toBe("0.0.0");
        expect(pkgs[0]?.dependencies).toEqual({});
    });

    it("无 name 的 package.json → 跳过（不可发布）", async () => {
        const dir = join(tmpRoot, "packages", "noname");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
        const pkgs = await discoverPackages(tmpRoot);
        expect(pkgs).toEqual([]);
    });

    it("apps 目录不存在 → 空数组不抛错（工作区可能只有 packages）", async () => {
        const dir = join(tmpRoot, "packages", "only");
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, "package.json"),
            JSON.stringify({ name: "only", version: "0.0.1" }),
            "utf8",
        );
        const pkgs = await discoverPackages(tmpRoot);
        expect(pkgs.map((p) => p.name)).toEqual(["only"]);
    });
});

describe("topoSort 传递依赖链（补充）", () => {
    it("三级链：无依赖者先出队，后继依次归零入度", () => {
        const a: WorkspacePkg = { name: "a", dir: "a", version: "0.0.1", dependencies: {} };
        const b: WorkspacePkg = {
            name: "b",
            dir: "b",
            version: "0.0.1",
            dependencies: { a: "workspace:*" },
        };
        const c: WorkspacePkg = {
            name: "c",
            dir: "c",
            version: "0.0.1",
            dependencies: { b: "workspace:*" },
        };
        expect(topoSort([c, b, a]).map((p) => p.name)).toEqual(["a", "b", "c"]);
        // 单包工作区：无依赖者直接返回
        expect(topoSort([a]).map((p) => p.name)).toEqual(["a"]);
    });
});
