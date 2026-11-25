/**
 * install-probe.test.ts：本机 QQ 安装位置探测单测（install-probe.ts）。
 *
 * 覆盖：注册表 UninstallString 解析、常见路径回退、WSL 盘符映射、resolveQqInstall
 * 的 installDir 切分、Linux deb 扁平布局（resolveLinuxQqInstall /
 * tryResolveLinuxLocalQq）、resolveFromRoot 的 ELF 守卫与结构校验。
 *
 * node:fs 部分替身：existsSync 对「常见路径候选」恒 false（隐藏开发机真实 QQ，
 * 保证跨机器确定性），其余透传；node:child_process 只替身 execFileSync("reg")
 * （h.regOutput 为 null = 注册表不可用，走常见路径回退）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    LINUX_QQ_INSTALL_DIR,
    locateQqPath,
    resolveFromRoot,
    resolveLinuxQqInstall,
    resolveQqInstall,
    tryResolveLinuxLocalQq,
    wslMappedPath,
} from "../install-probe.js";

/** mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** existsSync 恒 false 的路径集合（隐藏常见路径候选，跨机器确定性）。 */
        hidden: new Set<string>(),
        /** execFileSync 调用记录。 */
        execCalls: [] as Array<{ exe: string; args: string[] }>,
        /** reg query 输出（null = 抛错走常见路径）。 */
        regOutput: null as null | string,
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
        if (exe !== "reg") {
            throw new Error(`意外进程调用: ${exe}`);
        }
        if (h.regOutput === null) {
            throw new Error("reg 不可用");
        }
        return h.regOutput;
    }),
}));

/** 每个测试独立临时根（测后整体清理）。 */
let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-install-probe-"));
    // 隐藏常见路径候选（开发机可能装了 QQ，跨机器确定性）
    h.hidden.clear();
    h.hidden.add("c:/program files/tencent/qqnt/qq.exe");
    h.hidden.add("c:/program files (x86)/tencent/qqnt/qq.exe");
    h.execCalls.length = 0;
    h.regOutput = null;
    for (const key of [
        "LOCALAPPDATA",
        "NAPUKETTO_QQ_PATH",
        "NAPUKETTO_QQ_DIR",
        "NAPUKETTO_QQ_FILES",
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

/**
 * 构造 Linux deb 扁平安装：<root>/qq + <root>/resources/app/{wrapper.node,package.json}。
 * `variant` 注入异常形态：非 ELF wrapper / 缺 package.json / 缺 version 字段。
 */
function makeLinuxInstall(
    version = "3.2.35-54395",
    variant: "ok" | "pe" | "no-package" | "no-version" | "null-json" = "ok",
): string {
    const root = mkdtempSync(join(tmpRoot, "linux-qq-"));
    const appDir = join(root, "resources", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "wrapper.node"), variant === "pe" ? "MZ" : elfBytes());
    if (variant === "null-json") {
        // JSON.parse("null") → null：合法 JSON 但不是对象（非对象分支）
        writeFileSync(join(appDir, "package.json"), "null");
    } else if (variant !== "no-package") {
        const pkg = variant === "no-version" ? { name: "QQ" } : { name: "QQ", version };
        writeFileSync(join(appDir, "package.json"), JSON.stringify(pkg));
    }
    writeFileSync(join(root, "qq"), "");
    return root;
}

/** ELF 魔数开头的假 wrapper（Linux 原生守卫用）。 */
function elfBytes(): Buffer {
    return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("rest")]);
}

/** 临时把 process.platform 切成指定平台（用后恢复，CI 在 Windows/Ubuntu 都覆盖该分支）。 */
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
        fn();
    } finally {
        if (original !== undefined) {
            Object.defineProperty(process, "platform", original);
        }
    }
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

describe("resolveQqInstall", () => {
    it("installDir = dirname(qqPath)（正斜杠 Windows 路径）", () => {
        const root = makeInstall();
        const info = resolveQqInstall(`${root}/QQ.exe`);
        expect(info.installDir).toBe(root);
        expect(info.version).toBe("9.9.33-51802");
        expect(info.wrapperPath).toBe(
            join(root, "versions", "9.9.33-51802", "resources", "app", "wrapper.node"),
        );
        expect(info.source).toBe("local");
    });

    it("installDir = dirname(qqPath)（反斜杠 Windows 路径）", () => {
        const root = makeInstall();
        const info = resolveQqInstall(`${root}\\QQ.exe`);
        expect(info.installDir).toBe(root);
        expect(info.version).toBe("9.9.33-51802");
    });
});

describe("resolveLinuxQqInstall（扁平布局纯定位）", () => {
    it("完整扁平布局 → local + 版本取自 resources/app/package.json", () => {
        const root = makeLinuxInstall();
        const info = resolveLinuxQqInstall(root);
        expect(info).not.toBeNull();
        expect(info?.source).toBe("local");
        expect(info?.installDir).toBe(root);
        expect(info?.version).toBe("3.2.35-54395");
        expect(info?.qqPath).toBe(join(root, "qq"));
    });

    it("wrapper 非 ELF（PE/WSL 误指）→ null", () => {
        expect(resolveLinuxQqInstall(makeLinuxInstall("3.2.35-54395", "pe"))).toBeNull();
    });

    it("缺 package.json / 缺 version 字段 / 非对象 JSON → null（版本号参与登录，不能瞎填）", () => {
        expect(resolveLinuxQqInstall(makeLinuxInstall("3.2.35-54395", "no-package"))).toBeNull();
        expect(resolveLinuxQqInstall(makeLinuxInstall("3.2.35-54395", "no-version"))).toBeNull();
        expect(resolveLinuxQqInstall(makeLinuxInstall("3.2.35-54395", "null-json"))).toBeNull();
    });

    it("目录不存在 → null（不抛错）", () => {
        expect(resolveLinuxQqInstall(join(tmpRoot, "nope"))).toBeNull();
    });
});

describe("tryResolveLinuxLocalQq（平台注入）", () => {
    it("linux → 解析扁平安装", () => {
        const root = makeLinuxInstall();
        const info = tryResolveLinuxLocalQq({ installDir: root, platform: "linux" });
        expect(info?.version).toBe("3.2.35-54395");
    });

    it("非 linux 平台 → null（Windows 走注册表/常见路径）", () => {
        const root = makeLinuxInstall();
        expect(tryResolveLinuxLocalQq({ installDir: root, platform: "win32" })).toBeNull();
    });

    it("缺省安装根是 /opt/QQ", () => {
        const saved = process.env["NAPUKETTO_QQ_DIR"];
        delete process.env["NAPUKETTO_QQ_DIR"];
        try {
            // 开发机通常没有 /opt/QQ → null；关键是走默认路径而非 env
            expect(tryResolveLinuxLocalQq({ platform: "linux" })).toBeNull();
            expect(LINUX_QQ_INSTALL_DIR).toBe("/opt/QQ");
        } finally {
            if (saved !== undefined) {
                process.env["NAPUKETTO_QQ_DIR"] = saved;
            }
        }
    });
});

describe("resolveFromRoot ELF 守卫（Linux 宿主）", () => {
    it("Linux 平台下 wrapper 非 ELF → 可读错误（不交给 dlopen）", () => {
        const root = makeInstall("3.2.35-54395");
        // 覆盖成 PE（MZ）：Linux 宿主不接受，resolveFromRoot 必须提前报错
        writeFileSync(
            join(root, "versions", "3.2.35-54395", "resources", "app", "wrapper.node"),
            "MZ",
        );
        withPlatform("linux", () => {
            expect(() => resolveFromRoot(root, "cached")).toThrow(/不是 ELF/);
        });
    });

    it("Linux 平台下 wrapper 以 ELF 魔数开头 → 正常返回", () => {
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
        withPlatform("linux", () => {
            const info = resolveFromRoot(root, "cached");
            expect(info.wrapperPath).toBe(wrapperPath);
        });
    });

    it("Linux 平台下 wrapper 不可读（目录）→ 读取失败按非 ELF 处理", () => {
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
        withPlatform("linux", () => {
            expect(() => resolveFromRoot(root, "cached")).toThrow(/不是 ELF/);
        });
    });
});

describe("resolveFromRoot 结构校验", () => {
    it("文件根缺 versions 目录 → 抛 QQ 版本目录不存在", () => {
        const root = mkdtempSync(join(tmpRoot, "root-"));
        expect(() => resolveFromRoot(root, "cached")).toThrow("QQ 版本目录不存在");
    });

    it("versions 目录为空 → 抛 QQ 版本目录为空", () => {
        const root = mkdtempSync(join(tmpRoot, "root-"));
        mkdirSync(join(root, "versions"), { recursive: true });
        expect(() => resolveFromRoot(root, "cached")).toThrow("QQ 版本目录为空");
    });

    it("版本目录缺 wrapper.node → 抛未找到 wrapper.node", () => {
        const root = mkdtempSync(join(tmpRoot, "root-"));
        mkdirSync(join(root, "versions", "9.9.33-51802", "resources", "app"), { recursive: true });
        expect(() => resolveFromRoot(root, "cached")).toThrow("未找到 wrapper.node");
    });
});
