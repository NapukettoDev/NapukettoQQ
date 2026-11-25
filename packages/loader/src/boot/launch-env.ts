/**
 * launch-env.ts：自建宿主子进程环境构造（唯一入口）。
 *
 * 历史（H-06）：launcher 曾直接 `{ ...process.env }` 展开父进程环境，把无关凭据、
 * 加载器注入变量（`NODE_OPTIONS` / `LD_PRELOAD` / `LD_LIBRARY_PATH`）与任意部署私有
 * 值带进承载 QQ 原生模块的子进程。本模块改为显式白名单：
 *
 *  1. 平台基础变量（系统路径 / 临时目录 / 区域设置）
 *  2. 明确透传的部署策略（代理、私有 CA、主配置、调试沙箱）
 *  3. 子进程日志覆盖（可选公开契约，值不写日志）
 *  4. 用户控制标记（仅规范前缀 `NAPUKETTO_*` 透传，不识别旧拼写）
 *  5. `extraEnv`（调用方显式逃生口）
 *  6. 强类型 `LaunchOptions` 字段（最终生效，`false` 删除继承标记）
 *
 * 平台差异：Windows 环境变量名大小写不敏感，写入 `PATH` 等键前先删同名异体，避免
 * `Path` / `PATH` 双份；Linux 的 `LD_PRELOAD` 由 launcher 独占写入，父进程的预加载
 * 变量不进入白名单。
 *
 * 2026-11-25 P1 拆分：键表与跨平台读写原语下沉 `env-keys.ts`，本文件只留环境**策略**。
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
    baseEnvKeys,
    baseNetworkEnvKeys,
    certEnvKeys,
    configEnvKeys,
    controlEnvKeys,
    copyKeys,
    ENV,
    type EnvSource,
    logEnvKeys,
    nativeContractEnvKeys,
    posixNetworkEnvKeys,
    readEnv,
    setEnv,
    unsetEnv,
} from "./env-keys.js";

/** 子进程日志级别（与 kernel LogLevel 同字面量；loader 不编译期依赖 kernel）。 */
export type LaunchLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
/** 子进程控制台格式。 */
export type LaunchLogFormat = "pretty" | "single-line" | "json";

/**
 * 子进程日志配置（可选公开契约）。
 *
 * 映射到 kernel `parseLogConfig` 已支持的 `NAPUKETTO_LOG_*` 覆盖；调用方无需把整份
 * 环境变量塞进 `extraEnv`。日志值本身不会被打印。
 */
export interface LaunchLogOptions {
    /** 控制台与缺省文件级别。 */
    level?: LaunchLogLevel;
    /** 显式输出格式（缺省按 TTY 自动）。 */
    format?: LaunchLogFormat;
    /** true = 关闭启动 banner。 */
    noBanner?: boolean;
    /** 控制台颜色（子进程 stdout 恒 pipe，由父进程按最终控制台形态决定）。 */
    colorize?: boolean;
}

/** 环境构造输入（`LaunchOptions` 的字段子集；路径均已由调用方解析）。 */
export interface LaunchEnvInput {
    qq: {
        qqPath: string;
        version: string;
        wrapperPath: string;
    };
    kernelEntry: string;
    cfgDir: string;
    configPath?: string;
    adapterEntry?: string;
    networkEntry?: string;
    selfHost?: boolean;
    quickUin?: string;
    qrOnly?: boolean;
    ipc?: boolean;
    nativeMediaPatch?: boolean;
    /** 显式启用 IPC 诊断动作（默认关闭）。 */
    diagnostics?: boolean;
    /** 调用方追加环境变量（在强类型字段之前合并；同键以强类型字段为准）。 */
    extraEnv?: Record<string, string>;
    /** 子进程日志配置（可选公开契约）。 */
    log?: LaunchLogOptions;
}

/** 日志级别 / 格式合法值（与 kernel parseLogConfig 对齐）。 */
const LOG_LEVEL_VALUES: ReadonlySet<string> = new Set([
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
    "silent",
]);
const LOG_FORMAT_VALUES: ReadonlySet<string> = new Set(["pretty", "single-line", "json"]);

/** 校验并写入枚举型日志配置（非法值显式拒绝，避免静默降级）。 */
function setLogEnumEnv(
    target: Record<string, string>,
    key: string,
    value: string | undefined,
    allowed: ReadonlySet<string>,
    field: string,
    platform: NodeJS.Platform,
): void {
    if (value === undefined) {
        return;
    }
    if (!allowed.has(value)) {
        throw new Error(`LaunchOptions.log.${field} 非法: ${value}`);
    }
    setEnv(target, key, value, platform);
}

/** 应用强类型日志配置。 */
function applyLogOptions(
    target: Record<string, string>,
    log: LaunchLogOptions | undefined,
    platform: NodeJS.Platform,
): void {
    if (log === undefined) {
        return;
    }
    setLogEnumEnv(target, "NAPUKETTO_LOG_LEVEL", log.level, LOG_LEVEL_VALUES, "level", platform);
    setLogEnumEnv(
        target,
        "NAPUKETTO_LOG_FORMAT",
        log.format,
        LOG_FORMAT_VALUES,
        "format",
        platform,
    );
    if (log.noBanner !== undefined) {
        setEnv(target, "NAPUKETTO_NO_BANNER", log.noBanner ? "1" : "0", platform);
    }
    if (log.colorize !== undefined) {
        setEnv(target, "NAPUKETTO_LOG_COLORIZE", log.colorize ? "1" : "0", platform);
    }
}

/** 强类型启动字段（最终覆盖继承与 extraEnv；false 显式删除）。 */
function applyLaunchFlags(
    target: Record<string, string>,
    options: LaunchEnvInput,
    platform: NodeJS.Platform,
): void {
    // 必填契约（路径统一绝对化：子进程 cwd 是数据根，相对路径会解析到错误位置）
    setEnv(target, ENV.QQ_PATH, options.qq.qqPath, platform);
    setEnv(target, ENV.KERNEL_ENTRY, resolve(options.kernelEntry), platform);
    setEnv(target, ENV.CFG_DIR, resolve(options.cfgDir), platform);
    setEnv(target, ENV.QQ_VERSION, options.qq.version, platform);
    setEnv(target, ENV.WRAPPER_PATH, options.qq.wrapperPath, platform);

    applyOptionalPath(target, ENV.ADAPTER_ENTRY, options.adapterEntry, platform);
    applyOptionalPath(target, ENV.NETWORK_ENTRY, options.networkEntry, platform);
    applyOptionalPath(target, ENV.CONFIG_PATH, options.configPath, platform);

    applyBooleanFlag(target, ENV.SELF_HOST, options.selfHost, platform);
    applyBooleanFlag(target, ENV.IPC, options.ipc, platform);
    applyBooleanFlag(target, ENV.DIAG, options.diagnostics, platform);
    applyBooleanFlag(target, ENV.QR_ONLY, options.qrOnly, platform);

    if (options.quickUin !== undefined) {
        setEnv(target, ENV.QUICK_UIN, options.quickUin, platform);
    }

    setEnv(
        target,
        ENV.MEDIA_PATCH_STATUS,
        mediaPatchStatusPath(options.cfgDir, platform),
        platform,
    );
    if (options.nativeMediaPatch === true) {
        // 显式 true：清除继承 / extraEnv 的 killswitch（显式配置优先）
        unsetEnv(target, ENV.MEDIA_PATCH_DISABLE, platform);
    } else if (options.nativeMediaPatch === false) {
        setEnv(target, ENV.MEDIA_PATCH_DISABLE, "1", platform);
    }
}

/** 可选路径写入（未提供不覆盖继承值）。 */
function applyOptionalPath(
    target: Record<string, string>,
    key: string,
    value: string | undefined,
    platform: NodeJS.Platform,
): void {
    if (value !== undefined && value !== "") {
        setEnv(target, key, resolve(value), platform);
    }
}

/**
 * 布尔启动标记：true 写入 `1`，false 删除该规范键的继承值，undefined 保留继承值。
 * 只处理传入的键本身（不再清理任何旧拼写）。
 */
function applyBooleanFlag(
    target: Record<string, string>,
    key: string,
    value: boolean | undefined,
    platform: NodeJS.Platform,
): void {
    if (value === true) {
        setEnv(target, key, "1", platform);
        return;
    }
    if (value !== false) {
        return;
    }
    unsetEnv(target, key, platform);
}

/** 补丁状态文件路径（与账号数据目录同层，保持既有可观测面）。 */
function mediaPatchStatusPath(cfgDir: string, platform: NodeJS.Platform): string {
    return joinForPlatform(cfgDir, platform, "media-patch-status.json");
}

/**
 * 构造自建宿主子进程环境。
 *
 * 纯函数（不读文件 / 不建目录），便于两平台单元测试；目录创建由 launcher 负责。
 */
export function buildLaunchEnv(
    options: LaunchEnvInput,
    platform: NodeJS.Platform = process.platform,
    parentEnv: EnvSource = process.env,
): Record<string, string> {
    const env: Record<string, string> = {};
    copyKeys(env, parentEnv, baseEnvKeys(platform), platform);
    copyKeys(env, parentEnv, baseNetworkEnvKeys(), platform);
    if (platform !== "win32") {
        copyKeys(env, parentEnv, posixNetworkEnvKeys(), platform);
    }
    copyKeys(env, parentEnv, certEnvKeys(), platform);
    copyKeys(env, parentEnv, configEnvKeys(), platform);
    copyKeys(env, parentEnv, logEnvKeys(), platform);
    copyKeys(env, parentEnv, controlEnvKeys(), platform);
    copyKeys(env, parentEnv, nativeContractEnvKeys(), platform);

    // 调用方显式逃生口（未类型化的值）；随后由强类型字段覆盖。
    if (options.extraEnv !== undefined) {
        for (const [key, value] of Object.entries(options.extraEnv)) {
            setEnv(env, key, value, platform);
        }
    }
    applyLogOptions(env, options.log, platform);
    applyLaunchFlags(env, options, platform);
    return env;
}

/** PATH 前置（stub 目录 + wrapper.node 目录）；Windows 走 `;`、POSIX 走 `:`。 */
export function applyPathEnv(
    env: Record<string, string>,
    opts: { stub: string; wrapperPath: string },
    platform: NodeJS.Platform = process.platform,
): void {
    const separator = platform === "win32" ? ";" : ":";
    const current = readEnv(env, "PATH", platform) ?? "";
    const entries = [opts.stub, dirnameForPlatform(opts.wrapperPath), current].filter(
        (entry) => entry !== "",
    );
    setEnv(env, "PATH", entries.join(separator), platform);
    setEnv(env, ENV.STUB_DIR, opts.stub, platform);
}

/** dirname 的跨平台等价（同时识别 `/` 与 `\`，测试可在非宿主平台构造路径）。 */
function dirnameForPlatform(path: string): string {
    const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (index <= 0) {
        return index === 0 ? path.slice(0, 1) : ".";
    }
    return path.slice(0, index);
}

/** join 的跨平台等价（沙箱 profile / 状态文件路径构造用）。 */
function joinForPlatform(root: string, platform: NodeJS.Platform, ...segments: string[]): string {
    const separator = platform === "win32" ? "\\" : "/";
    return [stripTrailingSeparators(root), ...segments].join(separator);
}

/** 去掉路径尾部分隔符（手写扫描，避免把用户路径交给正则）。 */
function stripTrailingSeparators(path: string): string {
    let end = path.length;
    while (end > 0 && (path[end - 1] === "\\" || path[end - 1] === "/")) {
        end--;
    }
    return path.slice(0, end);
}

/**
 * Windows 调试沙箱 profile（仅 `NAPUKETTO_SANDBOX_ROOT` 存在时启用）。
 * 目录创建是唯一副作用；文件日志与协议缓存仍由 kernel/loader 的边界检查约束。
 */
export function windowsSandboxProfile(
    parentEnv: EnvSource = process.env,
    platform: NodeJS.Platform = process.platform,
): Record<string, string> {
    const root = readEnv(parentEnv, "NAPUKETTO_SANDBOX_ROOT", platform);
    if (root === undefined || root === "") {
        return {};
    }
    const profile = joinForPlatform(root, platform, "home");
    const roaming = joinForPlatform(profile, platform, "AppData", "Roaming");
    const local = joinForPlatform(profile, platform, "AppData", "Local");
    mkdirSync(roaming, { recursive: true });
    mkdirSync(local, { recursive: true });
    return {
        HOME: profile,
        USERPROFILE: profile,
        APPDATA: roaming,
        LOCALAPPDATA: local,
    };
}
