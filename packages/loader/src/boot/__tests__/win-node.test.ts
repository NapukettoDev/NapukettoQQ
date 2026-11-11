/**
 * win-node.test.ts：Windows 版 node.exe 获取单测（win-node.ts）。
 *
 * downloadFile / extractInstaller 经 vi.mock 拦截（不触网、不 spawn）；
 * 缓存与文件操作走真实临时目录。覆盖：
 *  - nodeZipUrl：nodejs.org dist 命名
 *  - 显式路径（参数 / NAPUTO_WIN_NODE_PATH）→ version "explicit"，不走下载
 *  - 缓存命中（<dataRoot>/runtime/win-node/<v>/node.exe 已存在）→ 不下载
 *  - 下载流：zip 下载 → 7z 解压（zip 内 node-<v>-win-x64/ 取 node.exe）→ 缓存 → zip 清理
 *  - zip 顶层无 node- 前缀目录 → 取 _zip/node.exe 直存形态
 *  - 解压后缺 node.exe → 报错；版本解析优先级（参数 > env > 缺省 v24）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWinNode, nodeZipUrl, WIN_NODE_DIR_NAME } from "../win-node.js";

/** mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** downloadFile 收到的参数。 */
        downloads: [] as Array<{ dest: string; url: string }>,
        /** downloadFile 抛错注入（null = 成功）。 */
        downloadError: null as null | Error,
        /** extractInstaller 收到的 (zipPath, tmpDir)。 */
        extracts: [] as Array<{ zipPath: string; tmpDir: string }>,
        /** 解压行为：none（空目录）/ root（_zip/node.exe）/ nested（node-<v>-win-x64/node.exe）。 */
        unzipLayout: "nested" as "none" | "root" | "nested",
        /** 解压布局目录名里的版本号（unzipNode mock 用）。 */
        version: "v24.16.0" as string,
    };
});

vi.mock("../../qq/qq-download.js", () => ({
    downloadFile: vi.fn(async (options: { dest: string; url: string }) => {
        h.downloads.push({ dest: options.dest, url: options.url });
        if (h.downloadError !== null) {
            throw h.downloadError;
        }
        // 生成空 zip 占位（后续 rm 清理验证用）
        writeFileSync(options.dest, "zip");
        return { sha256: "a".repeat(64), verified: true };
    }),
}));

vi.mock("../../qq/qq-extract.js", () => ({
    extractInstaller: vi.fn(async (zipPath: string, tmpDir: string) => {
        h.extracts.push({ zipPath, tmpDir });
        mkdirSync(tmpDir, { recursive: true });
        if (h.unzipLayout === "root") {
            writeFileSync(join(tmpDir, "node.exe"), "exe");
            return;
        }
        if (h.unzipLayout === "nested") {
            mkdirSync(join(tmpDir, `node-${h.version}-win-x64`), { recursive: true });
            writeFileSync(join(tmpDir, `node-${h.version}-win-x64`, "node.exe"), "exe");
            return;
        }
        // none：解出空目录
    }),
}));

/** unzipNode 用的版本号（mock 布局目录名同步）。 */
const VERSION = "v24.16.0";
Object.assign(h, { version: VERSION });

let tmpRoot = "";
let dataRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-winnode-test-"));
    dataRoot = tmpRoot;
    h.downloads.length = 0;
    h.extracts.length = 0;
    h.downloadError = null;
    h.unzipLayout = "nested";
    delete process.env["NAPUTO_WIN_NODE_PATH"];
    delete process.env["NAPUTO_WIN_NODE_VERSION"];
    delete process.env["NAPUTO_WIN_NODE_URL"];
});

afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

describe("nodeZipUrl", () => {
    it("nodejs.org dist 命名（与官方目录一致）", () => {
        expect(nodeZipUrl("v24.16.0")).toBe(
            "https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip",
        );
    });
});

describe("ensureWinNode 显式路径与缓存", () => {
    it("exePath 参数命中 → version=explicit，不下载", async () => {
        const exe = join(tmpRoot, "node.exe");
        writeFileSync(exe, "");
        const info = await ensureWinNode({ exePath: exe });
        expect(info.exePath).toBe(exe);
        expect(info.version).toBe("explicit");
        expect(h.downloads).toHaveLength(0);
    });

    it("NAPUTO_WIN_NODE_PATH 环境变量命中（解析为绝对路径）", async () => {
        const exe = join(tmpRoot, "sys-node.exe");
        writeFileSync(exe, "");
        vi.stubEnv("NAPUTO_WIN_NODE_PATH", exe);
        const info = await ensureWinNode({ dataRoot });
        expect(info.version).toBe("explicit");
        expect(info.exePath).toBe(exe);
    });

    it("显式路径不存在 → 跳过（与 ensureWinNode 下载路径一致）", async () => {
        vi.stubEnv("NAPUTO_WIN_NODE_PATH", join(tmpRoot, "missing.exe"));
        const info = await ensureWinNode({ dataRoot });
        expect(info.version).toBe(VERSION);
        expect(h.downloads).toHaveLength(1);
    });

    it("缓存命中：<dataRoot>/runtime/win-node/<v>/node.exe 已存在 → 直接返回", async () => {
        const cacheExe = join(dataRoot, "runtime", WIN_NODE_DIR_NAME, VERSION, "node.exe");
        mkdirSync(join(cacheExe, ".."), { recursive: true });
        writeFileSync(cacheExe, "exe");
        const info = await ensureWinNode({ dataRoot });
        expect(info.exePath).toBe(cacheExe);
        expect(info.version).toBe(VERSION);
        expect(h.downloads).toHaveLength(0);
        expect(h.extracts).toHaveLength(0);
    });
});

describe("ensureWinNode 下载流", () => {
    it("下载 + 解压（nested 布局）→ node.exe 落缓存，zip 清理", async () => {
        const info = await ensureWinNode({ dataRoot, version: VERSION });
        const zipPath = join(
            dataRoot,
            "runtime",
            WIN_NODE_DIR_NAME,
            VERSION,
            `node-${VERSION}-win-x64.zip`,
        );
        expect(h.downloads).toHaveLength(1);
        expect(h.downloads[0]?.url).toBe(nodeZipUrl(VERSION));
        expect(h.downloads[0]?.dest).toBe(zipPath);
        const cacheExe = join(dataRoot, "runtime", WIN_NODE_DIR_NAME, VERSION, "node.exe");
        expect(info.exePath).toBe(cacheExe);
        expect(info.version).toBe(VERSION);
        expect(existsSync(cacheExe)).toBe(true);
        // zip 与 _zip 临时目录清理
        expect(existsSync(zipPath)).toBe(false);
        expect(existsSync(join(dataRoot, "runtime", WIN_NODE_DIR_NAME, VERSION, "_zip"))).toBe(
            false,
        );
    });

    it("NAPUTO_WIN_NODE_URL 覆盖下载地址", async () => {
        vi.stubEnv("NAPUTO_WIN_NODE_URL", "https://mirror.example.com/node.zip");
        await ensureWinNode({ dataRoot });
        expect(h.downloads[0]?.url).toBe("https://mirror.example.com/node.zip");
    });

    it("zip 顶层无 node- 前缀目录 → 取 _zip/node.exe 直存形态", async () => {
        h.unzipLayout = "root";
        const info = await ensureWinNode({ dataRoot });
        expect(existsSync(info.exePath)).toBe(true);
    });

    it("解压后缺 node.exe → 报错（zip 内无 node- 目录也无根 exe）", async () => {
        h.unzipLayout = "none";
        await expect(ensureWinNode({ dataRoot })).rejects.toThrow("解压后未找到 node.exe");
    });

    it("下载失败 → zip 清理后错误上抛", async () => {
        h.downloadError = new Error("网络不可达");
        await expect(ensureWinNode({ dataRoot })).rejects.toThrow("网络不可达");
        const zipPath = join(
            dataRoot,
            "runtime",
            WIN_NODE_DIR_NAME,
            VERSION,
            `node-${VERSION}-win-x64.zip`,
        );
        expect(existsSync(zipPath)).toBe(false);
    });

    it("版本优先级：参数 > NAPUTO_WIN_NODE_VERSION > 缺省 v24.16.0", async () => {
        vi.stubEnv("NAPUTO_WIN_NODE_VERSION", "v22.0.0");
        const viaEnv = await ensureWinNode({ dataRoot });
        expect(viaEnv.version).toBe("v22.0.0");
        const viaParam = await ensureWinNode({ dataRoot, version: "v20.0.0" });
        expect(viaParam.version).toBe("v20.0.0");
        vi.unstubAllEnvs();
        const viaDefault = await ensureWinNode({ dataRoot });
        expect(viaDefault.version).toBe("v24.16.0");
    });
});
