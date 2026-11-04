import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearCacheVersion,
    extractInstaller,
    extractWrapperFiles,
    findSevenZip,
} from "./qq-extract.js";

/** execFile mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        calls: [] as Array<{ exe: string; args: string[] }>,
        /** 下一次 execFile 的行为（null = 成功）。 */
        nextError: null as null | { code?: string | number; stderr?: string },
    };
});

vi.mock("node:child_process", () => ({
    execFile: vi.fn(
        (
            exe: string,
            args: string[],
            _opts: unknown,
            cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
        ) => {
            h.calls.push({ exe, args });
            const err = h.nextError;
            if (err !== null) {
                const e = Object.assign(new Error("spawn 失败"), {
                    code: err.code,
                }) as NodeJS.ErrnoException;
                process.nextTick(() => {
                    cb(e, "", err.stderr ?? "");
                });
                return;
            }
            process.nextTick(() => {
                cb(null, "", "");
            });
        },
    ),
}));

/** 内置 7z 资产路径（与源码推导一致；存在性决定「系统 PATH」分支可达性）。 */
const BUNDLED_7Z = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
    "7zip",
    process.platform === "win32" ? "7z.exe" : "7zz",
);

let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-extract-test-"));
    h.calls.length = 0;
    h.nextError = null;
    delete process.env["NAPUTO_7Z_PATH"];
});

afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

describe("findSevenZip", () => {
    it("NAPUTO_7Z_PATH 指向存在的文件 → 环境变量来源", () => {
        const exe = join(tmpRoot, "my-7z.exe");
        writeFileSync(exe, "");
        vi.stubEnv("NAPUTO_7Z_PATH", exe);
        const result = findSevenZip();
        expect(result.exe).toBe(exe);
        expect(result.source).toContain("NAPUTO_7Z_PATH");
    });

    it("NAPUTO_7Z_PATH 指向不存在路径 → 回退（不使用坏路径）", () => {
        vi.stubEnv("NAPUTO_7Z_PATH", join(tmpRoot, "missing-7z.exe"));
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

describe("extractInstaller", () => {
    it("spawn 7z x：参数 x / 安装包路径 / -o<目录> / -y", async () => {
        const dest = join(tmpRoot, "extracted");
        await extractInstaller("C:/pkg/QQ.exe", dest, "C:/tools/7z.exe");
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]?.exe).toBe("C:/tools/7z.exe");
        expect(h.calls[0]?.args).toEqual(["x", "C:/pkg/QQ.exe", `-o${dest}`, "-y"]);
        expect(existsSync(dest)).toBe(true); // mkdir recursive 提前建目录
    });

    it("未显式传 7z → 用 findSevenZip 探测结果", async () => {
        const exe = join(tmpRoot, "probed.exe");
        writeFileSync(exe, "");
        vi.stubEnv("NAPUTO_7Z_PATH", exe);
        await extractInstaller("C:/pkg/QQ.exe", join(tmpRoot, "out"));
        expect(h.calls[0]?.exe).toBe(exe);
    });

    it("7z 失败（非 ENOENT）→ 错误含 stderr 与 NSIS 提示", async () => {
        h.nextError = { code: 2, stderr: "ERROR: Cannot open file" };
        await expect(extractInstaller("C:/pkg/QQ.exe", join(tmpRoot, "out"), "7z")).rejects.toThrow(
            /7z 解包失败[\s\S]*ERROR: Cannot open file[\s\S]*NSIS 格式/,
        );
    });

    it("7z 缺失（ENOENT）→ 错误含可执行路径与安装指引", async () => {
        h.nextError = { code: "ENOENT" };
        await expect(
            extractInstaller("C:/pkg/QQ.exe", join(tmpRoot, "out"), "C:/missing/7z.exe"),
        ).rejects.toThrow(/未找到 7z 可执行文件: C:[/\\]missing[/\\]7z\.exe/);
    });
});

describe("extractWrapperFiles", () => {
    const Version = "9.9.33-51802";

    /** 构造解包产物：<extracted>/Files/versions/<v>/resources/app/。 */
    function makeExtracted(): string {
        const appDir = join(tmpRoot, "extracted", "Files", "versions", Version, "resources", "app");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "wrapper.node"), "wrapper");
        writeFileSync(join(appDir, "extra.node"), "node2");
        writeFileSync(join(appDir, "dependency.dll"), "dll");
        writeFileSync(join(appDir, "README.txt"), "skip");
        writeFileSync(join(appDir, "WRAPPED.DLL"), "upper");
        mkdirSync(join(appDir, "wmpfsdk"), { recursive: true });
        writeFileSync(join(appDir, "wmpfsdk", "inner.dll"), "skip-dir");
        return join(tmpRoot, "extracted");
    }

    it("提取顶层 .node/.dll（保持同目录结构），跳过子目录与其他扩展", async () => {
        const extracted = makeExtracted();
        const cacheRoot = join(tmpRoot, "cache");
        const info = await extractWrapperFiles(extracted, Version, cacheRoot);
        expect(info.source).toBe("cached");
        expect(info.version).toBe(Version);
        const destApp = join(cacheRoot, Version, "versions", Version, "resources", "app");
        const names = readdirSync(destApp).sort();
        expect(names).toEqual(["WRAPPED.DLL", "dependency.dll", "extra.node", "wrapper.node"]);
        expect(info.wrapperPath).toBe(join(destApp, "wrapper.node"));
    });

    it("解包产物缺 wrapper.node → 报错（产物结构异常）", async () => {
        const appDir = join(tmpRoot, "bad", "Files", "versions", Version, "resources", "app");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "other.node"), "");
        await expect(
            extractWrapperFiles(join(tmpRoot, "bad"), Version, join(tmpRoot, "cache")),
        ).rejects.toThrow("解包产物缺少 wrapper.node");
    });

    it("幂等：目标 wrapper.node 已存在 → 跳过复制直接返回", async () => {
        const extracted = makeExtracted();
        const cacheRoot = join(tmpRoot, "cache");
        const first = await extractWrapperFiles(extracted, Version, cacheRoot);
        // 篡改缓存内容：幂等命中则不会被重新复制覆盖
        const destWrapper = join(
            cacheRoot,
            Version,
            "versions",
            Version,
            "resources",
            "app",
            "wrapper.node",
        );
        writeFileSync(destWrapper, "cached-content");
        const second = await extractWrapperFiles(extracted, Version, cacheRoot);
        expect(second.wrapperPath).toBe(first.wrapperPath);
        expect(readFileSync(destWrapper, "utf8")).toBe("cached-content");
    });

    it("复制循环跑完后目标仍缺 wrapper.node → 报错（提取失败兜底）", async () => {
        // wrapper.node 以「目录」形态存在：初始 existsSync 校验通过（目录也真），
        // 但 isFile() 过滤跳过复制 → 循环后目标缺失 → 兜底报错
        const appDir = join(tmpRoot, "ghost", "Files", "versions", Version, "resources", "app");
        mkdirSync(join(appDir, "wrapper.node"), { recursive: true });
        await expect(
            extractWrapperFiles(join(tmpRoot, "ghost"), Version, join(tmpRoot, "cache2")),
        ).rejects.toThrow("提取失败：wrapper.node 未复制到");
    });
});

describe("clearCacheVersion", () => {
    it("删除缓存版本目录；不存在时幂等", async () => {
        const cacheRoot = join(tmpRoot, "cache");
        const versionDir = join(cacheRoot, "9.9.33-51802");
        mkdirSync(join(versionDir, "versions"), { recursive: true });
        writeFileSync(join(versionDir, "versions", "x"), "");
        await clearCacheVersion(cacheRoot, "9.9.33-51802");
        expect(existsSync(versionDir)).toBe(false);
        // 幂等：再删一次不抛
        await expect(clearCacheVersion(cacheRoot, "9.9.33-51802")).resolves.toBeUndefined();
    });
});
