/**
 * seven-zip.test.ts：7-Zip 定位 / 获取 / 执行单测（seven-zip.ts）。
 *
 * 覆盖：bundledSevenZipSupported 平台判定、findSystemSevenZip 的 PATH 扫描、
 * findSevenZip 探测优先级（NAPUKETTO_7Z_PATH > 内置资产 > 系统 PATH）、
 * linuxSevenZipUrl（官方 tar.xz 或 HTTPS 镜像）、ensureLinuxSevenZip
 * （内置 7zz > 数据根缓存 > 固定摘要下载 + 原子发布 + 并发暂存）。
 *
 * node:fs 部分替身：existsSync 可按测试隐藏内置 7zz（模拟发布包缺失，走下载分支）；
 * node:child_process 只替身 execFileSync("tar")（在暂存目录写出 h.tarExe，不真解压）；
 * node:fs/promises 的 rename 可注入「另一实例已发布」竞态；downloadFile 整体替身（不触网）。
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    bundledSevenZipSupported,
    ensureLinuxSevenZip,
    findSevenZip,
    findSystemSevenZip,
    linuxSevenZipUrl,
} from "../../src/artifacts/seven-zip.js";
import { packageRoot } from "../../src/shared/package.js";

/** mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** existsSync 恒 false 的路径集合（隐藏内置资产，跨机器确定性）。 */
        hidden: new Set<string>(),
        /** execFileSync 调用记录。 */
        execCalls: [] as Array<{ exe: string; args: string[] }>,
        /** tar 解压产出的 7zz 内容。 */
        tarExe: null as Buffer | string | null,
        /** 模拟并发发布竞态：目标已存在时 rename 抛错。 */
        rejectConcurrentRename: false,
        /** downloadFile 记录与行为。 */
        downloads: [] as Array<{ dest: string; url: string; expectedSha256?: string }>,
        downloadError: null as null | Error,
    };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: (path: Parameters<typeof actual.existsSync>[0], ...rest: unknown[]) => {
            const p = String(path).replaceAll("\\", "/").toLowerCase();
            for (const hidden of h.hidden) {
                if (p === hidden) {
                    return false;
                }
            }
            return actual.existsSync(path, ...(rest as []));
        },
    };
});

vi.mock("node:child_process", () => ({
    execFileSync: vi.fn((exe: string, args: string[]) => {
        h.execCalls.push({ exe, args });
        if (exe !== "tar") {
            throw new Error(`意外进程调用: ${exe}`);
        }
        return tarExtractFake(args);
    }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
            if (h.rejectConcurrentRename) {
                if (existsSync(args[1])) {
                    throw new Error("另一个实例已发布该文件");
                }
                renameSync(...args);
                return;
            }
            await actual.rename(...args);
        },
    };
});

vi.mock("../../src/artifacts/download.js", () => ({
    downloadFile: vi.fn(async (options: { dest: string; url: string; expectedSha256?: string }) => {
        h.downloads.push({
            dest: options.dest,
            url: options.url,
            ...(options.expectedSha256 !== undefined
                ? { expectedSha256: options.expectedSha256 }
                : {}),
        });
        if (h.downloadError !== null) {
            throw h.downloadError;
        }
        writeFileSync(options.dest, "fake 7z archive");
        return { sha256: "b".repeat(64), verified: true };
    }),
}));

/** 与源码推导一致的内置 7zz 资产路径（src → 包根 assets/7zip/7zz）。 */
const Bundled7zz = join(packageRoot(), "assets", "7zip", "7zz");

/** findSevenZip 默认平台下的内置资产路径（Windows 7z.exe / Linux 7zz）。 */
const BUNDLED_7Z = join(
    packageRoot(),
    "assets",
    "7zip",
    process.platform === "win32" ? "7z.exe" : "7zz",
);

/** 每个测试独立临时根（测后整体清理）。 */
let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-seven-zip-"));
    h.hidden.clear();
    h.execCalls.length = 0;
    h.tarExe = null;
    h.rejectConcurrentRename = false;
    h.downloads.length = 0;
    h.downloadError = null;
    delete process.env["NAPUKETTO_7Z_PATH"];
    delete process.env["NAPUKETTO_7Z_URL"];
});

afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** 让 existsSync 认为内置 7zz 不存在（走缓存 / 下载分支）。 */
function hideBundledSevenZip(): void {
    h.hidden.add(Bundled7zz.replaceAll("\\", "/").toLowerCase());
}

/** tar 解压假实现（在 -C 指定的目录中写出 7zz）。 */
function tarExtractFake(args: string[]): string {
    const extractionDir = args[3];
    if (h.tarExe !== null && extractionDir !== undefined) {
        writeFileSync(join(extractionDir, "7zz"), h.tarExe);
    }
    return "";
}

describe("findSevenZip", () => {
    it("NAPUKETTO_7Z_PATH 指向存在的文件 → 环境变量来源", () => {
        const exe = join(tmpRoot, "my-7z.exe");
        writeFileSync(exe, "");
        vi.stubEnv("NAPUKETTO_7Z_PATH", exe);
        const result = findSevenZip();
        expect(result.exe).toBe(exe);
        expect(result.source).toContain("NAPUKETTO_7Z_PATH");
    });

    it("NAPUKETTO_7Z_PATH 指向不存在路径 → 回退（不使用坏路径）", () => {
        vi.stubEnv("NAPUKETTO_7Z_PATH", join(tmpRoot, "missing-7z.exe"));
        const result = findSevenZip();
        expect(result.exe).not.toBe(join(tmpRoot, "missing-7z.exe"));
    });

    it.skipIf(!existsSync(BUNDLED_7Z))(
        "未设置环境变量 → 内置资产（仓库 assets/7zip 存在时）",
        () => {
            const result = findSevenZip();
            expect(result.exe).toBe(BUNDLED_7Z);
            expect(result.source).toContain("内置资产");
        },
    );
});

describe("bundledSevenZipSupported / findSystemSevenZip", () => {
    it("Linux 只有 x64 能用内置 7zz（arm64 上是 x86-64 二进制）", () => {
        expect(bundledSevenZipSupported("linux", "arm64")).toBe(false);
        expect(bundledSevenZipSupported("linux", "x64")).toBe(true);
        // 非 Linux（Windows 资产是 x64 PE）不在此处限制
        expect(bundledSevenZipSupported("win32", "arm64")).toBe(true);
    });

    it.skipIf(process.platform === "win32")(
        "PATH 扫描（POSIX 冒号分隔）：7zz 优先于 7z，空项跳过",
        () => {
            const dirA = join(tmpRoot, "bin-a");
            const dirB = join(tmpRoot, "bin-b");
            mkdirSync(dirA, { recursive: true });
            mkdirSync(dirB, { recursive: true });
            writeFileSync(join(dirB, "7z"), "");

            // 只有 7z → 命中 dirB
            expect(findSystemSevenZip(`${dirA}:${dirB}`, "linux")).toBe(join(dirB, "7z"));
            // 出现 7zz → 优先 7zz
            writeFileSync(join(dirA, "7zz"), "");
            expect(findSystemSevenZip(`:${dirA}:${dirB}`, "linux")).toBe(join(dirA, "7zz"));
        },
    );

    it("找不到任何 7-Zip → null（跨平台）", () => {
        expect(findSystemSevenZip(join(tmpRoot, "nope"), "linux")).toBeNull();
        expect(findSystemSevenZip("", "linux")).toBeNull();
    });

    it.skipIf(process.platform === "win32")(
        "findSevenZip：非 x64 Linux 跳过内置，命中系统 7z / 退化为字面量 7z",
        () => {
            const dir = join(tmpRoot, "sys-bin");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "7z"), "");
            vi.stubEnv("PATH", dir);
            expect(findSevenZip("linux", "arm64").exe).toBe(join(dir, "7z"));
            expect(findSevenZip("linux", "arm64").source).toContain("系统 PATH");
            expect(findSevenZip("linux", "arm64").exe).not.toBe(BUNDLED_7Z);
            // 系统里也没有 → 返回字面量（执行时才会 ENOENT，错误由解包层提示）
            vi.stubEnv("PATH", join(tmpRoot, "empty"));
            expect(findSevenZip("linux", "arm64").exe).toBe("7z");
        },
    );

    it("Windows 只找 7z.exe（分号分隔）", () => {
        const dir = join(tmpRoot, "win-bin");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "7z.exe"), "");
        expect(findSystemSevenZip(dir, "win32")).toBe(join(dir, "7z.exe"));
        expect(findSystemSevenZip(dir, "linux")).toBeNull();
    });
});

describe("linuxSevenZipUrl", () => {
    it("缺省：7-Zip 官方 linux 版 tar.xz", () => {
        const url = linuxSevenZipUrl();
        expect(url).toMatch(
            /^https:\/\/github\.com\/ip7z\/7zip\/releases\/download\/\d+\.\d+\/7z\d+-linux-x64\.tar\.xz$/,
        );
    });

    it("NAPUKETTO_7Z_URL 覆盖下载地址", () => {
        vi.stubEnv("NAPUKETTO_7Z_URL", "https://mirror.example/7zz.tar.xz");
        expect(linuxSevenZipUrl()).toBe("https://mirror.example/7zz.tar.xz");
    });
});

describe("ensureLinuxSevenZip", () => {
    it.each([
        [undefined, "https://github.com/ip7z/7zip/releases/download/25.01/7z2501-linux-x64.tar.xz"],
        ["https://mirror.example/7zz.tar.xz", "https://mirror.example/7zz.tar.xz"],
    ])("用固定摘要下载并替换不可信的旧缓存（URL 覆盖 %s）", async (override, url) => {
        hideBundledSevenZip();
        if (override !== undefined) {
            vi.stubEnv("NAPUKETTO_7Z_URL", override);
        }
        h.tarExe = readFileSync(Bundled7zz);
        const cacheDir = join(tmpRoot, "runtime", "7zip");
        const exe = join(cacheDir, "7zz");
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(exe, "unverified legacy binary");

        expect((await ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "x64" })).exe).toBe(exe);
        expect(h.downloads).toEqual([
            expect.objectContaining({
                url,
                expectedSha256: "4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4",
            }),
        ]);
        expect(readFileSync(exe).equals(h.tarExe)).toBe(true);
        expect(readdirSync(cacheDir)).toEqual(["7zz"]);
        expect((await ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "x64" })).source).toContain(
            "数据根缓存",
        );
        expect(h.downloads).toHaveLength(1);
    });

    it("下载器拒绝镜像摘要时不解包，也不发布缓存", async () => {
        hideBundledSevenZip();
        vi.stubEnv("NAPUKETTO_7Z_URL", "https://mirror.example/7zz.tar.xz");
        h.downloadError = new Error("sha256 校验失败");

        await expect(ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "x64" })).rejects.toThrow(
            "sha256 校验失败",
        );
        expect(h.execCalls).toEqual([]);
        expect(readdirSync(join(tmpRoot, "runtime", "7zip"))).toEqual([]);
    });

    it("并发下载使用独立的暂存路径，只发布通过校验的 7zz", async () => {
        hideBundledSevenZip();
        h.tarExe = readFileSync(Bundled7zz);
        h.rejectConcurrentRename = true;
        const options = { dataRoot: tmpRoot, arch: "x64" };

        const [first, second] = await Promise.all([
            ensureLinuxSevenZip(options),
            ensureLinuxSevenZip(options),
        ]);
        expect(first.exe).toBe(second.exe);
        expect(h.downloads).toHaveLength(2);
        expect(new Set(h.downloads.map(({ dest }) => dest)).size).toBe(2);
        expect(readdirSync(join(tmpRoot, "runtime", "7zip"))).toEqual(["7zz"]);
        expect(readFileSync(first.exe).equals(h.tarExe)).toBe(true);
    });

    it.each(["", "http://mirror.example/7zz.tar.xz"])("拒绝非 HTTPS 镜像地址 %s", async (url) => {
        hideBundledSevenZip();
        vi.stubEnv("NAPUKETTO_7Z_URL", url);

        await expect(ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "x64" })).rejects.toThrow(
            /NAPUKETTO_7Z_URL.*HTTPS/,
        );
        expect(h.downloads).toEqual([]);
        expect(h.execCalls).toEqual([]);
    });

    it("提取的 7zz 摘要不匹配时不发布文件并清理暂存", async () => {
        hideBundledSevenZip();
        h.tarExe = "corrupt extracted binary";

        await expect(ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "x64" })).rejects.toThrow(
            /SHA-256.*7zz/,
        );
        expect(readdirSync(join(tmpRoot, "runtime", "7zip"))).toEqual([]);
    });

    it.skipIf(!existsSync(Bundled7zz))(
        "内置资产命中（发布包静态二进制，7zz 已 755 → chmod 幂等）→ 直接返回",
        async () => {
            const info = await ensureLinuxSevenZip({ dataRoot: tmpRoot });
            expect(info.source).toContain("内置资产");
            expect(info.exe).toBe(Bundled7zz);
            // 数据根缓存分支未触达（资产优先）
            expect(existsSync(join(tmpRoot, "runtime", "7zip"))).toBe(false);
        },
    );

    it.skipIf(process.platform === "win32")(
        "arm64：跳过内置 7zz（x86-64 二进制），用系统 7z",
        async () => {
            const binDir = join(tmpRoot, "arm-bin");
            mkdirSync(binDir, { recursive: true });
            writeFileSync(join(binDir, "7z"), "");
            vi.stubEnv("PATH", binDir);
            const info = await ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "arm64" });
            expect(info.exe).toBe(join(binDir, "7z"));
            expect(info.source).toContain("系统 PATH");
        },
    );

    it("arm64：没有系统 7-Zip → 抛可读错误（提示装 7zip/p7zip-full）", async () => {
        vi.stubEnv("PATH", join(tmpRoot, "empty-bin"));
        await expect(ensureLinuxSevenZip({ dataRoot: tmpRoot, arch: "arm64" })).rejects.toThrow(
            /没有可用的 7-Zip[\s\S]*apt install 7zip/,
        );
    });
});
