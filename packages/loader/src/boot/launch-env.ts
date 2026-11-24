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
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

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

/** 跨平台基础变量（系统解析 / 临时目录 / 区域设置）。 */
const COMMON_BASE_ENV_KEYS = [
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
] as const;

/** Windows 系统解析所需变量（DLL 搜索、用户目录、进程创建）。 */
const WINDOWS_BASE_ENV_KEYS = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "APPDATA",
    "LOCALAPPDATA",
    "OS",
] as const;

/** Linux 会话级变量（不接管 `XDG_RUNTIME_DIR`，仅按原值透传）。 */
const POSIX_BASE_ENV_KEYS = ["XDG_RUNTIME_DIR", "USER", "LOGNAME", "SHELL"] as const;

/**
 * 部署网络策略：代理与私有 CA 是管理员显式配置，子进程媒体下载 / QQ 网络需要。
 * `NODE_USE_ENV_PROXY` 让 Node 内置 fetch 走环境代理（Node 24+）。
 */
const NETWORK_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_USE_ENV_PROXY",
] as const;

/**
 * POSIX 环境变量大小写敏感，代理变量常用小写拼写；Windows 大小写不敏感，
 * 只写一份大写规范名（避免 `HTTPS_PROXY` / `https_proxy` 互相覆盖）。
 */
const POSIX_NETWORK_ENV_KEYS = ["http_proxy", "https_proxy", "no_proxy", "all_proxy"] as const;

/** 证书策略：显式透传，不转发 `NODE_TLS_REJECT_UNAUTHORIZED` 等降级开关。 */
const CERT_ENV_KEYS = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

/** 主配置 / 数据根 / 调试沙箱：子进程装配链与路径边界需要。 */
const CONFIG_ENV_KEYS = [
    "NAPUKETTO_CONFIG_JSON",
    "NAPUKETTO_CONFIG",
    "NAPUKETTO_DATA",
    "NAPUKETTO_SANDBOX_ROOT",
] as const;

/** 子进程日志覆盖（kernel parseLogConfig 支持）。 */
const LOG_ENV_KEYS = [
    "NAPUKETTO_LOG_LEVEL",
    "NAPUKETTO_LOG_FORMAT",
    "NAPUKETTO_NO_BANNER",
    "NAPUKETTO_LOG_COLORIZE",
] as const;

/** 用户控制标记（唯一规范拼写，逐键白名单透传，不做别名翻译）。 */
const CONTROL_ENV_KEYS = [
    "NAPUKETTO_QUICK_UIN",
    "NAPUKETTO_QR_ONLY",
    "NAPUKETTO_SMOKE",
    "NAPUKETTO_SMOKE_PEER",
    "NAPUKETTO_PROBE",
    "NAPUKETTO_LISTENER_RECORD",
    "NAPUKETTO_DIAG",
] as const;

/**
 * 闭源 stub 硬编码读取的原生契约键（禁止改名）：只透传，不翻译。
 * 仅在调用方未用强类型 `nativeMediaPatch` 覆盖时保留父进程值。
 */
const NATIVE_CONTRACT_ENV_KEYS = ["NAPUTO_DISABLE_MEDIA_PATCH"] as const;

/** 子进程环境变量名（self-host.cjs 与 kernel 引导读取）。前缀统一 `NAPUKETTO_*`。 */
export const ENV = {
    QQ_PATH: "NAPUKETTO_QQ_PATH",
    KERNEL_ENTRY: "NAPUKETTO_KERNEL_ENTRY",
    CFG_DIR: "NAPUKETTO_CFG_DIR",
    QQ_VERSION: "NAPUKETTO_QQ_VERSION",
    WRAPPER_PATH: "NAPUKETTO_WRAPPER_PATH",
    /** 自建宿主：标准 node + stub QQNT.dll 引导（self-host.cjs 分支）。 */
    SELF_HOST: "NAPUKETTO_SELF_HOST",
    /** stub QQNT.dll 目录（launchSelfHost 注入，self-host.cjs 诊断用）。 */
    STUB_DIR: "NAPUKETTO_STUB_DIR",
    /** adapter 包入口（协议装配用）。 */
    ADAPTER_ENTRY: "NAPUKETTO_ADAPTER_ENTRY",
    /** network 包入口（协议装配用）。 */
    NETWORK_ENTRY: "NAPUKETTO_NETWORK_ENTRY",
    /** 全局配置文件路径（项目根 napuketto.toml，boot-protocols 读取）。 */
    CONFIG_PATH: "NAPUKETTO_CONFIG",
    /** 强制指定快速登录账号（cli `-q <uin>` 透传，bootstrap 登录用）。 */
    QUICK_UIN: "NAPUKETTO_QUICK_UIN",
    /** 强制扫码登录（跳过快速登录直接 QR；koishi 面板「扫码登录」重启路径用，一次性）。 */
    QR_ONLY: "NAPUKETTO_QR_ONLY",
    /** IPC 子进程模式（koishi 插件驱动：stdout JSON 行 + stdin action/control）。 */
    IPC: "NAPUKETTO_IPC",
    /** 显式诊断动作开关（默认关闭；仅本地调试，动作表按 allowlist 收窄）。 */
    DIAG: "NAPUKETTO_DIAG",
    /** 数据根（cli 注入：停止哨兵目录解析用，self-host 不再从 CFG_DIR 反推）。 */
    DATA_ROOT: "NAPUKETTO_DATA_ROOT",
    /**
     * 入站图片自动下载补丁 killswitch（=1 时 stub 跳过全部内存操作）。
     * ⚠️ 原生契约：闭源 stub 硬编码读取 `NAPUTO_DISABLE_MEDIA_PATCH`，禁止改名。
     */
    MEDIA_PATCH_DISABLE: "NAPUTO_DISABLE_MEDIA_PATCH",
    /**
     * 入站图片自动下载补丁状态文件路径（stub 后台线程写 JSON，self-host 读后记日志）。
     * ⚠️ 原生契约：闭源 stub 硬编码读取 `NAPUTO_MEDIA_PATCH_STATUS`，禁止改名。
     */
    MEDIA_PATCH_STATUS: "NAPUTO_MEDIA_PATCH_STATUS",
} as const;

/** 平台分支的基础变量键（顺序无关；写入时统一按平台规范化）。 */
function baseEnvKeys(platform: NodeJS.Platform): string[] {
    const platformKeys = platform === "win32" ? WINDOWS_BASE_ENV_KEYS : POSIX_BASE_ENV_KEYS;
    return [...COMMON_BASE_ENV_KEYS, ...platformKeys];
}

/** 大小写不敏感读取（Windows 的 `Path` / `PATH` 是同一个变量）。 */
function readEnv(
    source: NodeJS.ProcessEnv | Record<string, string | undefined>,
    key: string,
    platform: NodeJS.Platform,
): string | undefined {
    const direct = source[key];
    if (direct !== undefined) {
        return direct;
    }
    if (platform !== "win32") {
        return undefined;
    }
    const lower = key.toLowerCase();
    for (const [candidate, value] of Object.entries(source)) {
        if (value !== undefined && candidate.toLowerCase() === lower) {
            return value;
        }
    }
    return undefined;
}

/** 删除同名异体键（Windows 专用；POSIX 无此语义）。 */
function deleteEnv(target: Record<string, string>, key: string, platform: NodeJS.Platform): void {
    if (platform === "win32") {
        const lower = key.toLowerCase();
        for (const candidate of Object.keys(target)) {
            if (candidate.toLowerCase() === lower) {
                delete target[candidate];
            }
        }
        return;
    }
    delete target[key];
}

/** 写入（Windows 先删同名异体，确保只有一个键）。 */
function setEnv(
    target: Record<string, string>,
    key: string,
    value: string,
    platform: NodeJS.Platform = process.platform,
): void {
    deleteEnv(target, key, platform);
    target[key] = value;
}

/** 删除（Windows 大小写不敏感）。 */
function unsetEnv(
    target: Record<string, string>,
    key: string,
    platform: NodeJS.Platform = process.platform,
): void {
    deleteEnv(target, key, platform);
}

/** 复制白名单键（Windows 大小写不敏感读取，统一写规范化键名）。 */
function copyKeys(
    target: Record<string, string>,
    source: NodeJS.ProcessEnv | Record<string, string | undefined>,
    keys: readonly string[],
    platform: NodeJS.Platform,
): void {
    for (const key of keys) {
        const value = readEnv(source, key, platform);
        if (value !== undefined) {
            setEnv(target, key, value, platform);
        }
    }
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
    parentEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
    const env: Record<string, string> = {};
    copyKeys(env, parentEnv, baseEnvKeys(platform), platform);
    copyKeys(env, parentEnv, NETWORK_ENV_KEYS, platform);
    if (platform !== "win32") {
        copyKeys(env, parentEnv, POSIX_NETWORK_ENV_KEYS, platform);
    }
    copyKeys(env, parentEnv, CERT_ENV_KEYS, platform);
    copyKeys(env, parentEnv, CONFIG_ENV_KEYS, platform);
    copyKeys(env, parentEnv, LOG_ENV_KEYS, platform);
    copyKeys(env, parentEnv, CONTROL_ENV_KEYS, platform);
    copyKeys(env, parentEnv, NATIVE_CONTRACT_ENV_KEYS, platform);

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
    parentEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
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
