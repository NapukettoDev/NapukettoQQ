/**
 * sync-adapter-deps.test.ts：CLI 层单测（mock fetch + 临时文件）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDistTags, fetchLatestVersions, main, parseArgs } from "../sync-adapter-deps.ts";

/** 临时目录（每个用例独立，测后清理）。 */
let tmpDir: string;

beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "napuketto-sync-test-"));
});

afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
});

/** 写入一个测试用插件 package.json，返回路径。 */
async function writePkg(deps: Record<string, string>): Promise<string> {
    const pkgPath = join(tmpDir, "package.json");
    await writeFile(
        pkgPath,
        JSON.stringify({ name: "koishi-plugin-adapter-napuketto", dependencies: deps }, null, 4),
        "utf8",
    );
    return pkgPath;
}

/** mock fetch：按 URL 返回 dist-tags。 */
function stubFetch(latestByPkg: Record<string, string>, fail?: () => Error): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
            if (fail !== undefined) {
                throw fail();
            }
            const url = String(input);
            for (const [pkg, latest] of Object.entries(latestByPkg)) {
                if (url.includes(pkg.replace(/\//g, "%2F"))) {
                    return {
                        ok: true,
                        status: 200,
                        statusText: "OK",
                        json: async () => ({ "dist-tags": { latest } }),
                    } as Response;
                }
            }
            return {
                ok: false,
                status: 404,
                statusText: "Not Found",
                json: async () => ({}),
            } as Response;
        }),
    );
}

describe("parseArgs", () => {
    it("默认 dry-run=false、pkg 为默认路径", () => {
        const args = parseArgs([]);
        expect(args.dryRun).toBe(false);
        // Windows 下路径反斜杠，用路径尾断言（跨平台健壮）
        expect(args.pkgPath.endsWith("package.json")).toBe(true);
        expect(args.pkgPath.includes("koishi-plugin-adapter")).toBe(true);
    });

    it("--dry-run 生效", () => {
        expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    });

    it("--pkg= 覆盖路径", () => {
        // Windows 下 resolve 输出反斜杠，用 endsWith 断言路径尾（跨平台健壮）
        expect(parseArgs(["--pkg=C:/x/pkg.json"]).pkgPath.endsWith("pkg.json")).toBe(true);
    });
});

describe("fetchDistTags", () => {
    it("正常返回 dist-tags", async () => {
        stubFetch({ "@napuketto/kernel": "0.0.3" });
        const tags = await fetchDistTags("@napuketto/kernel");
        expect(tags["latest"]).toBe("0.0.3");
    });

    it("HTTP 404 → 抛错", async () => {
        stubFetch({});
        await expect(fetchDistTags("@napuketto/kernel")).rejects.toThrow(/HTTP 404/);
    });

    it("响应缺 dist-tags → 抛错", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    statusText: "OK",
                    json: async () => ({}),
                } as Response),
            ),
        );
        await expect(fetchDistTags("@napuketto/kernel")).rejects.toThrow(/缺 dist-tags/);
    });
});

describe("fetchLatestVersions", () => {
    it("串行查询多个包", async () => {
        stubFetch({ "@napuketto/kernel": "0.0.3", "@napuketto/loader": "0.0.6" });
        const result = await fetchLatestVersions(["@napuketto/kernel", "@napuketto/loader"]);
        expect(result).toEqual({ "@napuketto/kernel": "0.0.3", "@napuketto/loader": "0.0.6" });
    });
});

describe("main", () => {
    /** 全量 registry latest（追踪 5 包，任一缺失 → fetch 404 → main 抛错）。 */
    const fullLatest = {
        "@napuketto/kernel": "0.0.3",
        "@napuketto/loader": "0.0.6",
        "@napuketto/adapter": "0.0.19",
        "@napuketto/network": "0.0.1",
        "@napuketto/media": "0.0.4",
    };

    it("依赖已最新 → 不改写文件，退出码 0", async () => {
        const pkgPath = await writePkg({
            "@napuketto/kernel": "~0.0.3",
            "@napuketto/loader": "~0.0.6",
            "@napuketto/adapter": "~0.0.19",
            "@napuketto/network": "~0.0.1",
            "@napuketto/media": "~0.0.4",
        });
        stubFetch(fullLatest);
        const code = await main([`--pkg=${pkgPath}`]);
        expect(code).toBe(0);
        const after = JSON.parse(await readFile(pkgPath, "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(after.dependencies["@napuketto/kernel"]).toBe("~0.0.3");
    });

    it("caret → 改写为 tilde 并写盘", async () => {
        const pkgPath = await writePkg({
            "@napuketto/kernel": "^0.0.2",
            "@napuketto/loader": "~0.0.6",
            "@napuketto/adapter": "~0.0.19",
            "@napuketto/network": "~0.0.1",
            "@napuketto/media": "~0.0.2",
        });
        stubFetch(fullLatest);
        const code = await main([`--pkg=${pkgPath}`]);
        expect(code).toBe(0);
        const after = JSON.parse(await readFile(pkgPath, "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(after.dependencies["@napuketto/kernel"]).toBe("~0.0.3");
        expect(after.dependencies["@napuketto/loader"]).toBe("~0.0.6");
    });

    it("--dry-run 不改写文件", async () => {
        const pkgPath = await writePkg({ "@napuketto/kernel": "^0.0.2" });
        stubFetch(fullLatest);
        const code = await main([`--pkg=${pkgPath}`, "--dry-run"]);
        expect(code).toBe(0);
        const after = JSON.parse(await readFile(pkgPath, "utf8")) as {
            dependencies: Record<string, string>;
        };
        expect(after.dependencies["@napuketto/kernel"]).toBe("^0.0.2");
    });

    it("registry 不可达 → 抛错（发布链中断）", async () => {
        const pkgPath = await writePkg({ "@napuketto/kernel": "^0.0.2" });
        stubFetch({}, () => new Error("ECONNREFUSED"));
        await expect(main([`--pkg=${pkgPath}`])).rejects.toThrow(/ECONNREFUSED/);
    });

    it("package.json 不存在 → 抛错", async () => {
        stubFetch(fullLatest);
        await expect(main([`--pkg=${join(tmpDir, "nope.json")}`])).rejects.toThrow(/无法读取/);
    });
});
