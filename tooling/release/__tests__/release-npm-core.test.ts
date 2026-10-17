/**
 * release-npm-core.test.ts：发布链核心逻辑单测。
 *
 * 覆盖 discoverPackages（临时目录模拟工作区）、planPublish、topoSort，
 * 以及 workspace:* 依赖改写 rewriteWorkspaceProtocol（发布前修复）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    discoverPackages,
    planPublish,
    rewriteWorkspaceProtocol,
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

describe("rewriteWorkspaceProtocol", () => {
    const versions = new Map([
        ["@napuketto/kernel", "0.0.10"],
        ["@napuketto/cli", "0.0.20"],
    ]);

    it("把 dependencies 中的 workspace:* 改写为 caret 真实版本", () => {
        const raw = pkgJson({ "@napuketto/kernel": "workspace:*", commander: "^15.0.0" });
        const { text, changes } = rewriteWorkspaceProtocol(raw, versions);
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
        const { changes } = rewriteWorkspaceProtocol(raw, allVersions);
        expect(changes.map((c) => c.dep).sort()).toEqual([
            "@napuketto/cli",
            "@napuketto/kernel",
            "opt-pkg",
            "peer-pkg",
        ]);
        // 各字段均改写为 caret 真实版本
        const parsed = JSON.parse(rewriteWorkspaceProtocol(raw, allVersions).text) as Record<
            string,
            Record<string, string>
        >;
        expect(parsed["dependencies"]?.["@napuketto/cli"]).toBe("^0.0.20");
        expect(parsed["devDependencies"]?.["@napuketto/kernel"]).toBe("^0.0.10");
        expect(parsed["optionalDependencies"]?.["opt-pkg"]).toBe("^0.1.0");
        expect(parsed["peerDependencies"]?.["peer-pkg"]).toBe("^0.2.0");
    });

    it("无 workspace:* 时原样返回（幂等，不重排）", () => {
        const raw = pkgJson({ commander: "^15.0.0" });
        const { text, changes } = rewriteWorkspaceProtocol(raw, versions);
        expect(changes).toEqual([]);
        expect(text).toBe(raw);
    });

    it("工作区找不到的 workspace:* 依赖抛错（发布链中断）", () => {
        const raw = pkgJson({ "@napuketto/unknown": "workspace:*" });
        expect(() => rewriteWorkspaceProtocol(raw, versions)).toThrow(/工作区内找不到该包版本/);
    });
});
