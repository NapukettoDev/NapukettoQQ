/**
 * locate-qq.test.ts：QQ 安装定位纯函数单测。
 *
 * 只测纯逻辑：wslMappedPath（WSL 盘符挂载映射）与 resolveQqInstall 的
 * installDir 切分（dirname 跨平台，2026-08-13 修复：lastIndexOf("\\")
 * 在 Linux 正斜杠路径下返回 -1，slice(0,-1) 切错字符）。
 * 不依赖真实 QQ 安装（resolveQqInstall 需 existsSync 真实文件系统，
 * 这里只测切分语义——通过临时目录构造最小 versions 结构）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    ensureQqFiles,
    linuxSevenZipUrl,
    QQ_FILES_DIR_NAME,
    resolveQqFiles,
    resolveQqInstall,
    wslMappedPath,
} from "../locate-qq.js";

/** 临时安装目录（每个测试独立，测后清理）。 */
const tmpDirs: string[] = [];

/** ELF 魔数开头的假 wrapper（Linux 平台守卫用；Windows 平台不校验）。 */
const ELF_HEAD = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** 构造最小 QQ 安装结构：<root>/QQ.exe + <root>/versions/<v>/resources/app/wrapper.node。 */
function makeFakeInstall(): { root: string; version: string } {
    const root = mkdtempSync(join(tmpdir(), "napuketto-qq-"));
    tmpDirs.push(root);
    const version = "9.9.33-51802";
    const wrapperDir = join(root, "versions", version, "resources", "app");
    mkdirSync(wrapperDir, { recursive: true });
    // wrapper 写 ELF 魔数：Linux 平台下 resolveFromRoot 会校验（真实 wrapper 是 PE 或 ELF）
    writeFileSync(join(wrapperDir, "wrapper.node"), ELF_HEAD);
    writeFileSync(join(root, "QQ.exe"), "");
    return { root, version };
}

/** 构造数据根下 QQ 文件缓存（L2 命中用）：<dataRoot>/qq-files/<v>/versions/<v>/resources/app/wrapper.node。 */
function makeFakeCache(dataRoot: string): string {
    const version = "9.9.33-51802";
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
    writeFileSync(join(appDir, "wrapper.node"), ELF_HEAD);
    return version;
}

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        // 测试临时目录，直接递归删除（仅限 os.tmpdir 下自建目录）
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        void import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
    }
});

describe("linuxSevenZipUrl", () => {
    it("缺省：7-Zip 官方 linux 版 tar.xz", () => {
        const url = linuxSevenZipUrl();
        expect(url).toMatch(/^https:\/\/www\.7-zip\.org\/a\/7z\d+-linux-x64\.tar\.xz$/);
    });

    it("NAPUTO_7Z_URL 覆盖下载地址", () => {
        const saved = process.env["NAPUTO_7Z_URL"];
        process.env["NAPUTO_7Z_URL"] = "https://mirror.example/7zz.tar.xz";
        try {
            expect(linuxSevenZipUrl()).toBe("https://mirror.example/7zz.tar.xz");
        } finally {
            if (saved === undefined) {
                delete process.env["NAPUTO_7Z_URL"];
            } else {
                process.env["NAPUTO_7Z_URL"] = saved;
            }
        }
    });
});

describe("wslMappedPath", () => {
    it("linux：C:/ 映射 /mnt/c/（正斜杠）", () => {
        expect(wslMappedPath("C:/Program Files/Tencent/QQNT/QQ.exe", "linux")).toBe(
            "/mnt/c/Program Files/Tencent/QQNT/QQ.exe",
        );
    });

    it("linux：C:\\ 映射 /mnt/c/（反斜杠）", () => {
        expect(wslMappedPath("C:\\Dev\\QQBot-Dev\\QQNT\\QQ.exe", "linux")).toBe(
            "/mnt/c/Dev/QQBot-Dev/QQNT/QQ.exe",
        );
    });

    it("linux：盘符转小写", () => {
        expect(wslMappedPath("D:/x/QQ.exe", "linux")).toBe("/mnt/d/x/QQ.exe");
    });

    it("linux：非盘符路径原样（Linux 本地路径）", () => {
        expect(wslMappedPath("/home/user/QQ.exe", "linux")).toBe("/home/user/QQ.exe");
    });

    it("win32：原样（不做映射）", () => {
        expect(wslMappedPath("C:/Program Files/Tencent/QQNT/QQ.exe", "win32")).toBe(
            "C:/Program Files/Tencent/QQNT/QQ.exe",
        );
    });
});

describe("linuxSevenZipUrl", () => {
    it("缺省：7-Zip 官方 linux 版 tar.xz", () => {
        const url = linuxSevenZipUrl();
        expect(url).toMatch(/^https:\/\/www\.7-zip\.org\/a\/7z\d+-linux-x64\.tar\.xz$/);
    });

    it("NAPUTO_7Z_URL 覆盖下载地址", () => {
        const saved = process.env["NAPUTO_7Z_URL"];
        process.env["NAPUTO_7Z_URL"] = "https://mirror.example/7zz.tar.xz";
        try {
            expect(linuxSevenZipUrl()).toBe("https://mirror.example/7zz.tar.xz");
        } finally {
            if (saved === undefined) {
                delete process.env["NAPUTO_7Z_URL"];
            } else {
                process.env["NAPUTO_7Z_URL"] = saved;
            }
        }
    });
});

describe("resolveQqInstall", () => {
    it("installDir = dirname(qqPath)（正斜杠 Windows 路径）", () => {
        const { root, version } = makeFakeInstall();
        const info = resolveQqInstall(`${root}/QQ.exe`);
        expect(info.installDir).toBe(root);
        expect(info.version).toBe(version);
        expect(info.wrapperPath).toBe(
            join(root, "versions", version, "resources", "app", "wrapper.node"),
        );
        expect(info.source).toBe("local");
    });

    it("installDir = dirname(qqPath)（反斜杠 Windows 路径）", () => {
        const { root, version } = makeFakeInstall();
        const info = resolveQqInstall(`${root}\\QQ.exe`);
        expect(info.installDir).toBe(root);
        expect(info.version).toBe(version);
    });
});

describe("resolveQqFiles", () => {
    it("L0：qqFilesDir 显式文件根 → cached", async () => {
        const { root, version } = makeFakeInstall();
        const info = await resolveQqFiles({ qqFilesDir: root });
        expect(info.source).toBe("cached");
        expect(info.version).toBe(version);
        expect(info.wrapperPath).toBe(
            join(root, "versions", version, "resources", "app", "wrapper.node"),
        );
    });

    it("L1：qqPath 显式安装 → local", async () => {
        const { root, version } = makeFakeInstall();
        const info = await resolveQqFiles({ qqPath: join(root, "QQ.exe") });
        expect(info.source).toBe("local");
        expect(info.version).toBe(version);
        expect(info.wrapperPath).toBe(
            join(root, "versions", version, "resources", "app", "wrapper.node"),
        );
    });
});

describe("ensureQqFiles", () => {
    it("L2 缓存命中：已有完整版本 → cached 且不触发下载", async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), "napuketto-data-"));
        tmpDirs.push(dataRoot);
        const version = makeFakeCache(dataRoot);
        const info = await ensureQqFiles({ dataRoot });
        expect(info.source).toBe("cached");
        expect(info.version).toBe(version);
        expect(info.wrapperPath).toBe(
            join(
                dataRoot,
                QQ_FILES_DIR_NAME,
                version,
                "versions",
                version,
                "resources",
                "app",
                "wrapper.node",
            ),
        );
    });
});
