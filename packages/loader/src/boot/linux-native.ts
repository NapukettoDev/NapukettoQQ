/**
 * linux-native.ts：Linux 原生 ELF 自建宿主（ADR-027 起 Linux 唯一路径）。
 *
 * 与 Windows 分支的区别：
 *  - 宿主是 Linux 原生 `node`（不是 Wine 里的 Windows node.exe——Wine 已退役）
 *  - `wrapper.node` 是 ELF，宿主符号由官方 node 直接导出；只 preload 最小 stub
 *  - stub 是 `libnapuketto_stub.so`（native/prebuilt/linux-x64/），不再是 QQNT.dll 目录
 *  - `libbugly` 的 gnutls 是无 DT_NEEDED 的隐藏依赖，必须与 stub 一起 preload
 *  - `HOME`/`XDG_*` 收敛到数据根（Stage 3c）：Bugly 的 NativeCrashHandler 不受
 *    `desktopGlobalPath` 控制，总是写 `$HOME/.config/QQ/crash_files/`
 *
 * 平台判定一律用 `process.platform === "linux"`；旧的 `NAPUTO_LINUX_NATIVE` 开关已退役
 * （ADR-027），设成 0 只在 launcher 里播报一句、不再改变行为。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { packageRoot } from "../internal/package-root.js";

/** 行拆分（ldconfig -p / which 输出兼容）。 */
const LINE_SPLIT = /\r?\n/;

/** 数据根下受管 HOME 的目录名（Linux 原生宿主专用）。 */
export const LINUX_HOME_DIRNAME = "home";

/**
 * loader 包内 Linux stub 路径（native/prebuilt/linux-x64/libnapuketto_stub.so）。
 * 只入库 x64（经真机验证）；arm64 等其他架构用 `NAPUTO_LINUX_STUB` 显式指定。
 */
export function defaultLinuxStubPath(): string {
    return join(packageRoot(), "native", "prebuilt", "linux-x64", "libnapuketto_stub.so");
}

/** 按架构给 gnutls 候选路径（Ubuntu/Debian 多架构目录）。 */
export function gnutlsCandidates(arch: string = process.arch): string[] {
    if (arch === "arm64") {
        return ["/usr/lib/aarch64-linux-gnu/libgnutls.so.30"];
    }
    return ["/usr/lib/x86_64-linux-gnu/libgnutls.so.30"];
}

/** 解析系统 libgnutls.so.30（候选路径 > ldconfig -p）。找不到返回 null。 */
export function resolveGnutls(arch: string = process.arch): string | null {
    for (const candidate of gnutlsCandidates(arch)) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    const probe = spawnSync("ldconfig", ["-p"], { encoding: "utf8" });
    if (probe.status !== 0 || probe.stdout === null) {
        return null;
    }
    for (const line of probe.stdout.split(LINE_SPLIT)) {
        if (!line.includes("libgnutls.so.30")) {
            continue;
        }
        const path = line.split("=>")[1]?.trim();
        if (path !== undefined && path !== "" && existsSync(path)) {
            return path;
        }
    }
    return null;
}

/** LD_PRELOAD 值：stub 必须在前，gnutls 紧随（顺序无关但保持稳定）。 */
export function linuxPreload(stubPath: string, gnutlsPath: string): string {
    return `${stubPath}:${gnutlsPath}`;
}

/** 解析 Linux 原生 node：当前进程就是 node 直接用，否则 `which node`。 */
export function resolveLinuxNode(): string | null {
    const name = basename(process.execPath).toLowerCase();
    if (name === "node") {
        return process.execPath;
    }
    const probe = spawnSync("which", ["node"], { encoding: "utf8" });
    if (probe.status !== 0 || probe.stdout === null) {
        return null;
    }
    const first = probe.stdout.split(LINE_SPLIT)[0]?.trim();
    return first !== undefined && first !== "" && existsSync(first) ? first : null;
}

/**
 * Linux 原生宿主的受管 HOME 目录（Stage 3c：把原生层对 `$HOME` 的写入收进数据根）。
 *
 * 优先级：显式覆盖（`NAPUTO_LINUX_HOME`）> `<数据根>/home` > `<账号目录>/home`。
 * 数据根缺省时退到账号目录而非继承用户 `$HOME`——宁可路径不一致，也不污染用户目录。
 */
export function resolveLinuxHome(options: {
    dataRoot?: string | undefined;
    cfgDir: string;
    explicit?: string | undefined;
}): string {
    const explicit = options.explicit;
    if (explicit !== undefined && explicit !== "") {
        return resolve(explicit);
    }
    const dataRoot = options.dataRoot;
    if (dataRoot !== undefined && dataRoot !== "") {
        return join(resolve(dataRoot), LINUX_HOME_DIRNAME);
    }
    return join(resolve(options.cfgDir), LINUX_HOME_DIRNAME);
}

/**
 * 受管 HOME 对应的环境变量集合。
 *
 * 关键变量是 `HOME`：`libbugly` 的崩溃处理器直接拼 `$HOME/.config/QQ/crash_files/`
 * （strace 实测，2026-11-09），不认 `XDG_CONFIG_HOME`；XDG_* 一并收敛是给其他 C 库
 * （libvips / fontconfig 等）的缓存兜底。`XDG_RUNTIME_DIR` 不接管——那是会话级
 * 目录（dbus / 0700），语义与数据根不同。
 */
export function linuxHomeEnv(home: string): Record<string, string> {
    return {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local", "state"),
    };
}
