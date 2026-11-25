/**
 * locate.test.ts：QQ 文件来源选择与下载解包链单测（locate.ts）。
 *
 * 覆盖：L0 显式文件根 / L1 qqPath 参数与环境变量 / L1b Linux 扁平安装 /
 * L2 数据根缓存扫描 / autoDownload 兜底 / ensureQqFiles 完整链路（失败清理、
 * 并发临时文件名、版本清单取用）。
 *
 * 安装位置探测（注册表/常见路径/WSL/ELF/deb 布局）在 install-probe.test.ts；
 * 7-Zip 获取在 seven-zip.test.ts。
 *
 * node:fs 部分替身：existsSync 隐藏常见路径候选；node:child_process 的注册表查询
 * 恒抛错（L1 不得命中开发机真实 QQ）；下载器与解包函数整体替身（不触网不 spawn）：
 * downloadFile 记录参数并落盘占位安装包，extractInstaller/extractDebInstaller 建
 * 解包目录，extractWrapperFiles/extractLinuxWrapperFiles 在缓存里落 wrapper.node。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqInstallInfo } from "../../src/artifacts/locate.js";
import { ensureQqFiles, QQ_FILES_DIR_NAME, resolveQqFiles } from "../../src/artifacts/locate.js";
import { latestRelease, loadQqReleases } from "../../src/artifacts/releases.js";

/** mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** existsSync 恒 false 的路径集合（隐藏常见路径候选，跨机器确定性）。 */
        hidden: new Set<string>(),
        /** downloadFile 记录与行为。 */
        downloads: [] as Array<{ dest: string; url: string; expectedSha256?: string }>,
        downloadError: null as null | Error,
        /** downloadFile 是否落盘安装包（false = 模拟产物缺失，测解包前丢失分支）。 */
        downloadCreatesFile: true,
        /** extractInstaller 记录；create = 是否创建解包目录。 */
        extracts: [] as Array<{ installerPath: string; destDir: string }>,
        extractCreatesDir: true,
        /** extractDebInstaller 记录（Linux 分支）。 */
        debExtracts: [] as Array<{ debPath: string; destDir: string }>,
        /** extractWrapperFiles 记录；error = 抛错注入。 */
        wrapperExtracts: [] as Array<{ extractedDir: string; version: string; cacheRoot: string }>,
        wrapperExtractError: null as null | Error,
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
    execFileSync: vi.fn(() => {
        // L1 探测不得读取开发机真实注册表：恒抛错，让流程落到常见路径 / L2 缓存。
        throw new Error("测试不查询真实注册表");
    }),
}));

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
        if (h.downloadCreatesFile) {
            writeFileSync(options.dest, "MZ-fake-installer");
        }
        return { sha256: "b".repeat(64), verified: true };
    }),
}));

vi.mock("../../src/artifacts/extract.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/artifacts/extract.js")>();
    /** 假提取：在缓存里落 wrapper.node，返回 cached QqInstallInfo。 */
    const fakeWrapperExtract = (
        extractedDir: string,
        version: string,
        cacheRoot: string,
    ): QqInstallInfo => {
        h.wrapperExtracts.push({ extractedDir, version, cacheRoot });
        if (h.wrapperExtractError !== null) {
            throw h.wrapperExtractError;
        }
        // 模拟成功提取：<cacheRoot>/<v>/versions/<v>/resources/app/wrapper.node
        const appDir = join(cacheRoot, version, "versions", version, "resources", "app");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "wrapper.node"), elfBytes());
        const versionDir = join(cacheRoot, version);
        return {
            qqPath: join(versionDir, "QQ.exe"),
            installDir: versionDir,
            version,
            wrapperPath: join(appDir, "wrapper.node"),
            source: "cached",
        };
    };
    return {
        ...actual,
        extractInstaller: vi.fn(async (installerPath: string, destDir: string) => {
            h.extracts.push({ installerPath, destDir });
            if (h.extractCreatesDir) {
                mkdirSync(destDir, { recursive: true });
            }
        }),
        extractDebInstaller: vi.fn(async (debPath: string, destDir: string) => {
            h.debExtracts.push({ debPath, destDir });
            if (h.extractCreatesDir) {
                mkdirSync(destDir, { recursive: true });
            }
        }),
        extractWrapperFiles: vi.fn(
            async (extractedDir: string, version: string, cacheRoot: string) =>
                fakeWrapperExtract(extractedDir, version, cacheRoot),
        ),
        extractLinuxWrapperFiles: vi.fn(
            async (extractedDir: string, version: string, cacheRoot: string) =>
                fakeWrapperExtract(extractedDir, version, cacheRoot),
        ),
    };
});

/** 每个测试独立临时根（测后整体清理）。 */
let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-locate-qq-"));
    // 隐藏常见路径候选（开发机可能装了 QQ，跨机器确定性）
    h.hidden.clear();
    h.hidden.add("c:/program files/tencent/qqnt/qq.exe");
    h.hidden.add("c:/program files (x86)/tencent/qqnt/qq.exe");
    h.downloads.length = 0;
    h.downloadError = null;
    h.downloadCreatesFile = true;
    h.extracts.length = 0;
    h.extractCreatesDir = true;
    h.debExtracts.length = 0;
    h.wrapperExtracts.length = 0;
    h.wrapperExtractError = null;
    for (const key of [
        "NAPUKETTO_QQ_PATH",
        "NAPUKETTO_QQ_FILES",
        "NAPUKETTO_QQ_URL",
        "NAPUKETTO_QQ_DIR",
        "LOCALAPPDATA",
        "NAPUKETTO_7Z_PATH",
        "NAPUKETTO_7Z_URL",
    ]) {
        delete process.env[key];
    }
});

afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** 构造完整安装结构：<root>/QQ.exe + <root>/versions/<v>/resources/app/wrapper.node。 */
function makeInstall(version = "9.9.33-51802"): string {
    const root = mkdtempSync(join(tmpRoot, "install-"));
    const appDir = join(root, "versions", version, "resources", "app");
    mkdirSync(appDir, { recursive: true });
    // wrapper 写 ELF 魔数：Linux 平台下 resolveFromRoot 会校验（真实 wrapper 是 PE 或 ELF，
    // 空文件在 Linux 上会被守卫拒绝，用例本身与平台无关）
    writeFileSync(join(appDir, "wrapper.node"), elfBytes());
    writeFileSync(join(root, "QQ.exe"), "");
    return root;
}

/** 构造数据根缓存：<dataRoot>/qq-files/<v>/versions/<v>/resources/app/wrapper.node。 */
function makeCache(dataRoot: string, version: string): string {
    const appDir = join(
        dataRoot,
        QQ_FILES_DIR_NAME,
        version,
        "versions",
        version,
        "resources",
        "app",
    );
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "wrapper.node"), elfBytes());
    return appDir;
}

/** ELF 魔数开头的假 wrapper（Linux 原生守卫用）。 */
function elfBytes(): Buffer {
    return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("rest")]);
}

/** 构造 Linux deb 扁平安装：<root>/qq + <root>/resources/app/{wrapper.node,package.json}。 */
function makeLinuxInstall(version = "3.2.35-54395", variant: "ok" | "pe" = "ok"): string {
    const root = mkdtempSync(join(tmpRoot, "linux-qq-"));
    const appDir = join(root, "resources", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "wrapper.node"), variant === "pe" ? "MZ" : elfBytes());
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "QQ", version }));
    writeFileSync(join(root, "qq"), "");
    return root;
}

/** 临时把 process.platform 切成指定平台（用后恢复，CI 在 Windows/Ubuntu 都覆盖该分支）。 */
async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
        await fn();
    } finally {
        if (original !== undefined) {
            Object.defineProperty(process, "platform", original);
        }
    }
}

/** 切成 linux（多数 Linux 分支测试用）。 */
function withLinuxPlatform(fn: () => Promise<void>): Promise<void> {
    return withPlatform("linux", fn);
}

describe("resolveQqFiles 来源优先级", () => {
    it("L0：qqFilesDir 参数显式文件根 → cached", async () => {
        const root = makeInstall();
        const info = await resolveQqFiles({ qqFilesDir: root, autoDownload: false });
        expect(info.source).toBe("cached");
        expect(info.installDir).toBe(root);
    });

    it("L0：NAPUKETTO_QQ_FILES 环境变量兜底（相对路径 resolve）", async () => {
        const root = makeInstall();
        vi.stubEnv("NAPUKETTO_QQ_FILES", root);
        const info = await resolveQqFiles({ autoDownload: false });
        expect(info.source).toBe("cached");
    });

    it("L1：qqPath 参数 → local（installDir = dirname）", async () => {
        const root = makeInstall();
        const info = await resolveQqFiles({ qqPath: join(root, "QQ.exe"), autoDownload: false });
        expect(info.source).toBe("local");
        expect(info.version).toBe("9.9.33-51802");
    });

    it("L1：NAPUKETTO_QQ_PATH 环境变量兜底", async () => {
        const root = makeInstall();
        vi.stubEnv("NAPUKETTO_QQ_PATH", join(root, "QQ.exe"));
        const info = await resolveQqFiles({ autoDownload: false });
        expect(info.source).toBe("local");
    });

    it("L2：数据根缓存命中（坏版本目录跳过，取最新完整版本）", async () => {
        // 两个缓存版本：旧版残缺（无 wrapper.node）、新版完整 → 取新版
        const broken = join(tmpRoot, "qq-files", "9.9.30-1");
        mkdirSync(join(broken, "versions", "9.9.30-1"), { recursive: true }); // 结构不完整
        const latest = "9.9.33-51802";
        makeCache(tmpRoot, latest);
        const info = await resolveQqFiles({ dataRoot: tmpRoot, autoDownload: false });
        expect(info.source).toBe("cached");
        expect(info.version).toBe(latest);
    });

    it("L2 缓存目录不存在 → 继续兜底（autoDownload=false 时抛可读错误）", async () => {
        await expect(resolveQqFiles({ dataRoot: tmpRoot, autoDownload: false })).rejects.toThrow(
            "未找到 QQ 原生文件",
        );
    });

    it("L0/L1/L2 全缺失 + autoDownload 默认 true → 自动下载并返回缓存产物", async () => {
        vi.stubEnv("LOCALAPPDATA", tmpRoot);
        const info = await resolveQqFiles({
            dataRoot: tmpRoot,
            sevenZipPath: join(tmpRoot, "7z.exe"),
        });
        expect(info.source).toBe("cached");
        expect(h.downloads).toHaveLength(1);
        expect(h.wrapperExtracts).toHaveLength(1);
    });
});

describe("Linux 原生模式（平台注入）", () => {
    it("ensureQqFiles：Linux 平台下载 deb 并走 extractDebInstaller / extractLinuxWrapperFiles", async () => {
        await withLinuxPlatform(async () => {
            const info = await ensureQqFiles({
                dataRoot: tmpRoot,
                sevenZipPath: join(tmpRoot, "7zz"),
            });
            expect(info.version).toBe("3.2.35-54395");
            expect(h.downloads[0]?.url).toMatch(/\.deb$/);
            expect(h.debExtracts).toHaveLength(1);
            expect(h.extracts).toHaveLength(0);
        });
    });

    it("ensureQqFiles：未显式 7z → Linux 分支用内置 7zz（不下载）", async () => {
        await withLinuxPlatform(async () => {
            const info = await ensureQqFiles({ dataRoot: tmpRoot });
            expect(info.version).toBe("3.2.35-54395");
            expect(h.debExtracts).toHaveLength(1);
        });
    });

    it("ensureQqFiles：非 Linux 平台未显式 7z → 交给 findSevenZip 探测", async () => {
        await withPlatform("win32", async () => {
            await ensureQqFiles({ dataRoot: tmpRoot });
            expect(h.extracts).toHaveLength(1);
            expect(h.debExtracts).toHaveLength(0);
        });
    });

    it("L1b：扁平安装（NAPUKETTO_QQ_DIR）→ local，且不触发 deb 下载", async () => {
        const root = makeLinuxInstall();
        vi.stubEnv("NAPUKETTO_QQ_DIR", root);
        await withLinuxPlatform(async () => {
            const info = await resolveQqFiles({ dataRoot: tmpRoot });
            expect(info.source).toBe("local");
            expect(info.version).toBe("3.2.35-54395");
            expect(info.installDir).toBe(root);
            expect(info.qqPath).toBe(join(root, "qq"));
            expect(info.wrapperPath).toBe(join(root, "resources", "app", "wrapper.node"));
            expect(h.downloads).toHaveLength(0);
            expect(h.debExtracts).toHaveLength(0);
        });
    });

    it("L1b：扁平安装 wrapper 非 ELF → 视为未命中", async () => {
        const root = makeLinuxInstall("3.2.35-54395", "pe");
        vi.stubEnv("NAPUKETTO_QQ_DIR", root);
        await withLinuxPlatform(async () => {
            await expect(
                resolveQqFiles({ dataRoot: tmpRoot, autoDownload: false }),
            ).rejects.toThrow("未找到 QQ 原生文件");
        });
    });

    it("L1 优先于 L1b：显式 NAPUKETTO_QQ_PATH（versions 结构）胜过 /opt/QQ", async () => {
        const canonical = makeInstall("9.9.33-51802");
        writeFileSync(
            join(canonical, "versions", "9.9.33-51802", "resources", "app", "wrapper.node"),
            elfBytes(),
        );
        const flat = makeLinuxInstall();
        vi.stubEnv("NAPUKETTO_QQ_PATH", join(canonical, "QQ.exe"));
        vi.stubEnv("NAPUKETTO_QQ_DIR", flat);
        await withLinuxPlatform(async () => {
            const info = await resolveQqFiles({ dataRoot: tmpRoot, autoDownload: false });
            // 平台切成 linux 后路径归一化为正斜杠（Windows 上跑用例时需同样归一化）
            expect(info.installDir).toBe(canonical.replaceAll("\\", "/"));
            expect(info.version).toBe("9.9.33-51802");
        });
    });
});

describe("ensureQqFiles 下载流", () => {
    // 清单最新版本（动态读取真实 releases.json，避免清单更新导致测试过期）
    const Version = latestRelease(loadQqReleases()).version;

    it("缓存命中 → 不下载，onStage 播报命中", async () => {
        makeCache(tmpRoot, Version);
        const stages: string[] = [];
        const info = await ensureQqFiles({ dataRoot: tmpRoot, onStage: (m) => stages.push(m) });
        expect(info.source).toBe("cached");
        expect(info.version).toBe(Version);
        expect(h.downloads).toHaveLength(0);
        expect(stages.some((m) => m.includes("缓存命中"))).toBe(true);
    });

    it("完整流：清单最新版 → 下载（sha256）→ 解包 → 提取 → 缓存 + onStage 全程播报", async () => {
        const stages: string[] = [];
        const info = await ensureQqFiles({
            dataRoot: tmpRoot,
            sevenZipPath: join(tmpRoot, "7z.exe"),
            onStage: (m) => stages.push(m),
        });
        expect(info.version).toBe(Version);
        // 清单 URL 透传（NAPUKETTO_QQ_URL 未设 → release.url；归一化在 downloadFile 内部）
        expect(h.downloads[0]?.url).toContain("QQ");
        expect(h.downloads[0]?.expectedSha256).toBeTypeOf("string");
        expect(h.wrapperExtracts[0]?.version).toBe(Version);
        // 安装包与解包临时目录清理
        expect(readdirSync(join(tmpRoot, "tmp"))).toHaveLength(0);
        expect(stages.some((m) => m.includes("下载 QQ 官方安装包"))).toBe(true);
        expect(stages.some((m) => m.includes("sha256 校验通过"))).toBe(true);
        expect(stages.some((m) => m.includes("7z 解包安装包"))).toBe(true);
        expect(stages.some((m) => m.includes("提取 wrapper.node"))).toBe(true);
        expect(stages.some((m) => m.includes("QQ 原生文件就绪"))).toBe(true);
    });

    it("下载产物在解包前丢失（并发清理竞态）→ 明确报错且不触发解包", async () => {
        h.downloadCreatesFile = false; // 模拟下载完成但文件被并发清理
        await expect(
            ensureQqFiles({ dataRoot: tmpRoot, sevenZipPath: join(tmpRoot, "7z.exe") }),
        ).rejects.toThrow("下载产物在解包前丢失");
        expect(h.extracts).toHaveLength(0);
    });

    it("提取失败 → 清理缓存残留与临时文件，错误上抛", async () => {
        h.wrapperExtractError = new Error("产物结构异常");
        await expect(
            ensureQqFiles({ dataRoot: tmpRoot, sevenZipPath: join(tmpRoot, "7z.exe") }),
        ).rejects.toThrow("产物结构异常");
        // 缓存版本目录被清理（extractWrapperFiles mock 建过）
        expect(existsSync(join(tmpRoot, QQ_FILES_DIR_NAME, Version))).toBe(false);
        expect(readdirSync(join(tmpRoot, "tmp"))).toHaveLength(0);
    });

    it("NAPUKETTO_QQ_URL 覆盖下载地址（resolveDownloadUrl 兜底）", async () => {
        vi.stubEnv("NAPUKETTO_QQ_URL", "https://mirror.example.com/QQ.exe");
        await ensureQqFiles({ dataRoot: tmpRoot, sevenZipPath: join(tmpRoot, "7z.exe") });
        expect(h.downloads[0]?.url).toBe("https://mirror.example.com/QQ.exe");
    });
});
