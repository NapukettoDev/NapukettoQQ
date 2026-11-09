/**
 * locate-qq-flow.test.ts：QQ 文件定位流程单测（locate-qq.ts 下载/解包链路与分支）。
 *
 * 纯定位（wslMappedPath/resolveQqInstall 切分语义）在 locate-qq.test.ts；本文件
 * 覆盖流程分支：注册表探测、常见路径、L0/L1/L2 来源优先级、autoDownload、
 * ensureQqFiles 完整下载流（mock downloadFile/extractInstaller/extractWrapperFiles，
 * 不触网不 spawn）与失败清理。
 *
 * node:fs 部分替身：existsSync 对「常见路径候选」恒 false（隐藏开发机真实 QQ，
 * 保证跨机器确定性），其余透传；node:child_process 按 exe 分发（reg → 注册表、
 * tar → 解压）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqInstallInfo } from "./locate-qq.js";
import {
    ensureLinuxSevenZip,
    ensureQqFiles,
    locateQqPath,
    QQ_FILES_DIR_NAME,
    resolveQqFiles,
} from "./locate-qq.js";
import { latestRelease, loadQqReleases } from "./qq-releases.js";

/** mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** existsSync 恒 false 的路径集合（隐藏常见路径候选，跨机器确定性）。 */
        hidden: new Set<string>(),
        /** execFileSync 调用记录。 */
        execCalls: [] as Array<{ exe: string; args: string[] }>,
        /** reg query 输出（null = 抛错走常见路径）。 */
        regOutput: null as null | string,
        /** tar 解压回调（成功时建 7zz）。 */
        tarCreatesExe: false,
        tarError: false,
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
    execFileSync: vi.fn((exe: string, args: string[]) => {
        h.execCalls.push({ exe, args });
        return execFileSyncFake(exe, args);
    }),
}));

/** reg query 假实现（null 输出 = 抛错走常见路径）。 */
function execFileSyncFake(exe: string, args: string[]): string {
    if (exe === "reg") {
        return regQueryFake();
    }
    if (exe === "tar") {
        return tarExtractFake(args);
    }
    throw new Error(`意外进程调用: ${exe}`);
}

/** reg query 假实现。 */
function regQueryFake(): string {
    if (h.regOutput === null) {
        throw new Error("reg 不可用");
    }
    return h.regOutput;
}

/** tar 解压假实现（成功时在 cacheDir 建 7zz 占位）。 */
function tarExtractFake(args: string[]): string {
    if (h.tarError) {
        throw new Error("xz 缺失");
    }
    if (h.tarCreatesExe) {
        // args: ["-xJf", archive, "-C", cacheDir]
        const cacheDir = String(args[3] ?? "");
        if (cacheDir !== "") {
            writeFileSync(join(cacheDir, "7zz"), "exe");
        }
    }
    return "";
}

vi.mock("./qq-download.js", () => ({
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

vi.mock("./qq-extract.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./qq-extract.js")>();
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
        writeFileSync(join(appDir, "wrapper.node"), "wrapper");
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

let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-locate-flow-"));
    // 隐藏常见路径候选（开发机可能装了 QQ，跨机器确定性）
    h.hidden.clear();
    h.hidden.add("c:/program files/tencent/qqnt/qq.exe");
    h.hidden.add("c:/program files (x86)/tencent/qqnt/qq.exe");
    h.execCalls.length = 0;
    h.regOutput = null;
    h.tarCreatesExe = false;
    h.tarError = false;
    h.downloads.length = 0;
    h.downloadError = null;
    h.downloadCreatesFile = true;
    h.extracts.length = 0;
    h.extractCreatesDir = true;
    h.debExtracts.length = 0;
    h.wrapperExtracts.length = 0;
    h.wrapperExtractError = null;
    for (const key of [
        "NAPUTO_QQ_PATH",
        "NAPUTO_QQ_FILES",
        "NAPUTO_QQ_URL",
        "LOCALAPPDATA",
        "NAPUTO_7Z_PATH",
        "NAPUTO_7Z_URL",
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
    const root = mkdtempSync(join(tmpdir(), "napuketto-qq-install-"));
    const appDir = join(root, "versions", version, "resources", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "wrapper.node"), "");
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
    writeFileSync(join(appDir, "wrapper.node"), "");
    return appDir;
}

describe("locateQqPath", () => {
    it.skipIf(process.platform !== "win32")(
        "注册表命中：UninstallString 切出安装目录（QQ.exe 存在校验）",
        () => {
            const root = makeInstall();
            // 反斜杠路径进输出（真实 reg 输出形态）；切分逻辑自行处理引号
            h.regOutput = `HKEY...QQ\r\n    UninstallString    REG_SZ    "${join(root, "uninst.exe")}" /C\r\n`;
            const qq = locateQqPath();
            expect(qq).toBe(join(root, "QQ.exe"));
            expect(h.execCalls[0]?.exe).toBe("reg");
        },
    );

    it.skipIf(process.platform !== "win32")(
        "注册表指向的 QQ.exe 不存在 → 回退（全部缺失时抛可读错误）",
        () => {
            h.regOutput = 'UninstallString    REG_SZ    "C:\\nowhere\\uninst.exe"';
            vi.stubEnv("LOCALAPPDATA", tmpRoot);
            expect(() => locateQqPath()).toThrow("未找到 QQ.exe");
        },
    );
});

describe("resolveQqFiles 来源优先级", () => {
    it("L0：qqFilesDir 参数显式文件根 → cached", async () => {
        const root = makeInstall();
        const info = await resolveQqFiles({ qqFilesDir: root, autoDownload: false });
        expect(info.source).toBe("cached");
        expect(info.installDir).toBe(root);
    });

    it("L0：NAPUTO_QQ_FILES 环境变量兜底（相对路径 resolve）", async () => {
        const root = makeInstall();
        vi.stubEnv("NAPUTO_QQ_FILES", root);
        const info = await resolveQqFiles({ autoDownload: false });
        expect(info.source).toBe("cached");
    });

    it("L1：qqPath 参数 → local（installDir = dirname）", async () => {
        const root = makeInstall();
        const info = await resolveQqFiles({ qqPath: join(root, "QQ.exe"), autoDownload: false });
        expect(info.source).toBe("local");
        expect(info.version).toBe("9.9.33-51802");
    });

    it("L1：NAPUTO_QQ_PATH 环境变量兜底", async () => {
        const root = makeInstall();
        vi.stubEnv("NAPUTO_QQ_PATH", join(root, "QQ.exe"));
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

    it("ELF 守卫：NAPUTO_LINUX_NATIVE=1 且 wrapper 非 ELF → 可读错误（不交给 dlopen）", async () => {
        const root = makeInstall("3.2.35-54395");
        vi.stubEnv("NAPUTO_LINUX_NATIVE", "1");
        await withLinuxPlatform(async () => {
            await expect(resolveQqFiles({ qqFilesDir: root, autoDownload: false })).rejects.toThrow(
                /不是 ELF/,
            );
        });
    });

    it("ELF 守卫：wrapper 以 ELF 魔数开头 → 正常返回", async () => {
        const root = makeInstall("3.2.35-54395");
        const wrapperPath = join(
            root,
            "versions",
            "3.2.35-54395",
            "resources",
            "app",
            "wrapper.node",
        );
        writeFileSync(
            wrapperPath,
            Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("rest")]),
        );
        vi.stubEnv("NAPUTO_LINUX_NATIVE", "1");
        await withLinuxPlatform(async () => {
            const info = await resolveQqFiles({ qqFilesDir: root, autoDownload: false });
            expect(info.wrapperPath).toBe(wrapperPath);
        });
    });

    it("ELF 守卫：wrapper 不可读（目录）→ 读取失败按非 ELF 处理", async () => {
        const root = makeInstall("3.2.35-54395");
        const wrapperPath = join(
            root,
            "versions",
            "3.2.35-54395",
            "resources",
            "app",
            "wrapper.node",
        );
        rmSync(wrapperPath, { force: true });
        mkdirSync(wrapperPath);
        vi.stubEnv("NAPUTO_LINUX_NATIVE", "1");
        await withLinuxPlatform(async () => {
            await expect(resolveQqFiles({ qqFilesDir: root, autoDownload: false })).rejects.toThrow(
                /不是 ELF/,
            );
        });
    });

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
});

describe("ensureQqFiles 下载流", () => {
    // 清单最新版本（动态读取真实 qq-releases.json，避免清单更新导致测试过期）
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
        // 清单 URL 透传（NAPUTO_QQ_URL 未设 → release.url；归一化在 downloadFile 内部）
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

    it("NAPUTO_QQ_URL 覆盖下载地址（resolveDownloadUrl 兜底）", async () => {
        vi.stubEnv("NAPUTO_QQ_URL", "https://mirror.example.com/QQ.exe");
        await ensureQqFiles({ dataRoot: tmpRoot, sevenZipPath: join(tmpRoot, "7z.exe") });
        expect(h.downloads[0]?.url).toBe("https://mirror.example.com/QQ.exe");
    });
});

describe("ensureLinuxSevenZip", () => {
    /** 与源码推导一致的内置资产路径（src → 包根 assets/7zip/7zz）。 */
    const Bundled7zz = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "7zip", "7zz");

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
});

describe("resolveFromRoot 结构校验（经 resolveQqFiles 显式根触发）", () => {
    it("L0 文件根缺 versions 目录 → 抛 QQ 版本目录不存在", async () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-qq-root-"));
        await expect(resolveQqFiles({ qqFilesDir: root, autoDownload: false })).rejects.toThrow(
            "QQ 版本目录不存在",
        );
    });

    it("versions 目录为空 → 抛 QQ 版本目录为空", async () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-qq-root-"));
        mkdirSync(join(root, "versions"), { recursive: true });
        await expect(resolveQqFiles({ qqFilesDir: root, autoDownload: false })).rejects.toThrow(
            "QQ 版本目录为空",
        );
    });

    it("版本目录缺 wrapper.node → 抛未找到 wrapper.node", async () => {
        const root = mkdtempSync(join(tmpdir(), "napuketto-qq-root-"));
        mkdirSync(join(root, "versions", "9.9.33-51802", "resources", "app"), { recursive: true });
        await expect(resolveQqFiles({ qqFilesDir: root, autoDownload: false })).rejects.toThrow(
            "未找到 wrapper.node",
        );
    });
});
