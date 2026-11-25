/**
 * install-probe.ts：本机 QQ 安装位置探测（Windows 注册表 / 常见路径 / WSL 映射、
 * Linux deb 扁平布局）——2026-11-25 从 locate-qq.ts 拆出。
 *
 * 纯定位、不下载：只回答「这台机器上哪儿有 wrapper.node」。下载/解包/缓存管线留在
 * locate-qq.ts（它反向依赖本模块，单向）。
 */
import { execFileSync } from "node:child_process";
import {
    closeSync,
    existsSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { isRecord } from "../internal/type-guards.js";
import type { QqFileSource, QqInstallInfo } from "./qq-types.js";

/** 注册表 UninstallString 查询（QQ 官方安装路径）。 */
const REG_QUERY_RE = /"([^"]+)"/;

/** Windows 盘符路径正则（`C:/...` / `C:\...`，wslMappedPath 映射用，模块级常量）。 */
const DRIVE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

/** 注册表 UninstallString 查询（QQ 官方安装路径）。 */
function findQqViaRegistry(): string | null {
    try {
        const out = execFileSync("reg", [
            "query",
            "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ",
            "/v",
            "UninstallString",
        ]).toString();
        const m = out.match(REG_QUERY_RE);
        const exe = m?.[1];
        if (exe !== undefined) {
            // UninstallString 形如 "C:\...\uninst.exe" 或带参数
            const dir = exe.replaceAll('"', "").slice(0, exe.lastIndexOf("\\"));
            const qq = join(dir, "QQ.exe");
            if (existsSync(qq)) {
                return qq;
            }
        }
    } catch {
        // 注册表查询失败，走常见路径
    }
    return null;
}

/** 常见安装路径探测。 */
function findQqViaCommonPaths(): string | null {
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    const candidates = [
        "C:/Program Files/Tencent/QQNT/QQ.exe",
        "C:/Program Files (x86)/Tencent/QQNT/QQ.exe",
        join(localAppData, "Programs", "Tencent", "QQNT", "QQ.exe"),
    ];
    for (const p of candidates) {
        // WSL 场景：Windows 盘挂载在 /mnt/<盘符>/（如 C:\ → /mnt/c/），
        // 同一候选同时探测 Linux 侧映射路径（2026-08-13 koishi-app 实测报「未找到 QQ.exe」）。
        const wsl = wslMappedPath(p);
        if (existsSync(wsl)) {
            return wsl;
        }
        if (existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Windows 路径 → WSL 挂载路径（`C:/...` → `/mnt/c/...`；非 Linux 或非盘符路径原样）。
 * WSL 默认把 Windows 盘符挂载到 `/mnt/<小写盘符>/`，Linux 侧 `existsSync` 必须用映射路径。
 * platform 参数可注入（测试用；缺省 process.platform）。
 * 导出便于单测（install-probe.test.ts）。
 * ⚠️ 不用 join 拼 `/mnt/...`：测试在 Windows 跑，win32 join 会产生反斜杠；目标路径
 * 是 Linux 侧路径（WSL 挂载点），必须恒正斜杠。
 */
export function wslMappedPath(
    winPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform !== "linux") {
        return winPath;
    }
    const [, drive, rest] = DRIVE_PATH_RE.exec(winPath) ?? [];
    if (drive === undefined || rest === undefined) {
        return winPath;
    }
    return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

/** 找 QQ.exe 路径。 */
export function locateQqPath(): string {
    const viaReg = findQqViaRegistry();
    if (viaReg) {
        return viaReg;
    }
    const viaCommon = findQqViaCommonPaths();
    if (viaCommon) {
        return viaCommon;
    }
    throw new Error("未找到 QQ.exe（请先安装 QQ，或通过 NAPUKETTO_QQ_PATH 指定）");
}

/** ELF 魔数（Linux 原生 wrapper.node 校验，防误用 Windows PE 文件）。 */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** 读文件头判断是否 ELF（仅读 4 字节，失败返回 false）。 */
function isElfFile(path: string): boolean {
    let fd: number | null = null;
    try {
        fd = openSync(path, "r");
        const head = Buffer.alloc(ELF_MAGIC.length);
        const read = readSync(fd, head, 0, head.length, 0);
        return read === head.length && head.equals(ELF_MAGIC);
    } catch {
        return false;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

/** 从文件根定位最新版本 wrapper.node（local/cached 共用）。 */
export function resolveFromRoot(rootDir: string, source: QqFileSource): QqInstallInfo {
    const versionsDir = join(rootDir, "versions");
    if (!existsSync(versionsDir)) {
        throw new Error(`QQ 版本目录不存在: ${versionsDir}`);
    }
    const versions = readdirSync(versionsDir)
        .filter((v) => statSync(join(versionsDir, v)).isDirectory())
        .sort()
        .reverse();
    const [first] = versions;
    if (first === undefined) {
        throw new Error(`QQ 版本目录为空: ${versionsDir}`);
    }
    const wrapperPath = join(versionsDir, first, "resources", "app", "wrapper.node");
    if (!existsSync(wrapperPath)) {
        throw new Error(`未找到 wrapper.node: ${wrapperPath}`);
    }
    // Linux 只认 ELF（ADR-027 起 Wine 退役，PE wrapper 在 Linux 上没有任何加载路径）：
    // WSL 下容易误指向 /mnt/c 的 Windows 安装，原生 node dlopen 会报 invalid ELF
    // header，这里提前给出可读错误。
    if (process.platform === "linux" && !isElfFile(wrapperPath)) {
        throw new Error(
            `wrapper.node 不是 ELF（Linux 宿主不接受 Windows PE 安装）: ${wrapperPath}\n` +
                "请指向 Linux deb 解包产物（官方 deb 或 /opt/QQ），或改用 NAPUKETTO_QQ_DIR",
        );
    }
    return {
        qqPath: join(rootDir, "QQ.exe"),
        installDir: rootDir,
        version: first,
        wrapperPath,
        source,
    };
}

/** 从 QQ.exe 路径推导安装目录，并探测当前版本（L1：本机安装）。 */
export function resolveQqInstall(qqPath?: string): QqInstallInfo {
    const qq = qqPath ?? process.env["NAPUKETTO_QQ_PATH"] ?? locateQqPath();
    // Windows 安装结构：<installDir>/versions/<版本>/resources/app/wrapper.node
    // ⚠️ dirname 跨平台：Linux/WSL 路径用正斜杠（lastIndexOf("\\") 会切错，2026-08-13 实测）；
    // 反斜杠 Windows 路径在 posix dirname 下不切分（切错目录），非 win32 先归一化——
    // win32 不动原串，保持返回值分隔符与调用方输入一致（精确比对场景）
    const installDir = dirname(process.platform === "win32" ? qq : qq.replaceAll("\\", "/"));
    return resolveFromRoot(installDir, "local");
}

/** Linux 官方 deb 的默认安装根（扁平布局：`<根>/qq` + `<根>/resources/app/wrapper.node`）。 */
export const LINUX_QQ_INSTALL_DIR = "/opt/QQ";

/** 读 package.json 的 version（缺失 / 解析失败 / 非字符串 → null）。 */
function readPackageVersion(packageJsonPath: string): string | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (!isRecord(parsed)) {
            return null;
        }
        const version = parsed["version"];
        return typeof version === "string" && version !== "" ? version : null;
    } catch {
        return null;
    }
}

/**
 * 解析 Linux deb 安装的 QQ（扁平布局，与 Windows `versions/<版本>/` 结构不同）。
 *
 * 结构：`<installDir>/qq`（Electron 主程序）+ `<installDir>/resources/app/{wrapper.node,
 * package.json,...}`。校验 ELF 魔数（防止把 WSL 里的 Windows 安装当成 Linux 安装）、
 * 版本号取自 `resources/app/package.json`。任一不满足返回 null（调用方继续兜底）。
 */
export function resolveLinuxQqInstall(installDir: string): QqInstallInfo | null {
    const appDir = join(installDir, "resources", "app");
    const wrapperPath = join(appDir, "wrapper.node");
    if (!existsSync(wrapperPath) || !isElfFile(wrapperPath)) {
        return null;
    }
    const version = readPackageVersion(join(appDir, "package.json"));
    if (version === null) {
        return null;
    }
    return {
        qqPath: join(installDir, "qq"),
        installDir,
        version,
        wrapperPath,
        source: "local",
    };
}

/**
 * L1b：Linux 本地安装探测（`NAPUKETTO_QQ_DIR` > `/opt/QQ`）。
 *
 * 只在 Linux 生效（ADR-027 起 Linux 只有 ELF 宿主；Wine 分支已删除）。
 * `installDir` / `platform` 仅测试注入（缺省读 env 与当前平台）。
 */
export function tryResolveLinuxLocalQq(
    options: { installDir?: string | undefined; platform?: NodeJS.Platform | undefined } = {},
): QqInstallInfo | null {
    const platform = options.platform ?? process.platform;
    if (platform !== "linux") {
        return null;
    }
    const installDir =
        options.installDir ?? process.env["NAPUKETTO_QQ_DIR"] ?? LINUX_QQ_INSTALL_DIR;
    return resolveLinuxQqInstall(installDir);
}
