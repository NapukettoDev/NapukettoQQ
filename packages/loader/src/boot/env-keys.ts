/**
 * env-keys.ts：子进程环境变量键表与跨平台读写原语。
 * 键名是对外契约（闭源 stub 与 kernel 都读）；Windows 下 `Path` / `PATH` 是同一个变量，故读写均大小写不敏感。
 */
import process from "node:process";

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
 * 闭源 stub 硬编码读取的原生契约键（与规范前缀一致）：只透传，不翻译。
 * 改名必须与 stub 重编同批发布，否则已发布 DLL 会读不到。
 * 仅在调用方未用强类型 `nativeMediaPatch` 覆盖时保留父进程值。
 */
const NATIVE_CONTRACT_ENV_KEYS = ["NAPUKETTO_DISABLE_MEDIA_PATCH"] as const;

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
     * ⚠️ 原生契约：闭源 stub 硬编码读取 `NAPUKETTO_DISABLE_MEDIA_PATCH`，改名须与 stub 重编同批发布。
     */
    MEDIA_PATCH_DISABLE: "NAPUKETTO_DISABLE_MEDIA_PATCH",
    /**
     * 入站图片自动下载补丁状态文件路径（stub 后台线程写 JSON，self-host 读后记日志）。
     * ⚠️ 原生契约：闭源 stub 硬编码读取 `NAPUKETTO_MEDIA_PATCH_STATUS`，改名须与 stub 重编同批发布。
     */
    MEDIA_PATCH_STATUS: "NAPUKETTO_MEDIA_PATCH_STATUS",
} as const;

/** 环境快照类型（process.env 或其显式子集）。 */
export type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** 平台分支的基础变量键（顺序无关；写入时统一按平台规范化）。 */
export function baseEnvKeys(platform: NodeJS.Platform): string[] {
    const platformKeys = platform === "win32" ? WINDOWS_BASE_ENV_KEYS : POSIX_BASE_ENV_KEYS;
    return [...COMMON_BASE_ENV_KEYS, ...platformKeys];
}

/** 网络策略键（大写规范名；POSIX 另需小写拼写，见 `POSIX_NETWORK_ENV_KEYS`）。 */
export function baseNetworkEnvKeys(): readonly string[] {
    return NETWORK_ENV_KEYS;
}

/** POSIX 小写代理拼写键（Windows 不写：大小写不敏感会互相覆盖）。 */
export function posixNetworkEnvKeys(): readonly string[] {
    return POSIX_NETWORK_ENV_KEYS;
}

/** 证书策略键。 */
export function certEnvKeys(): readonly string[] {
    return CERT_ENV_KEYS;
}

/** 主配置 / 数据根 / 沙箱键。 */
export function configEnvKeys(): readonly string[] {
    return CONFIG_ENV_KEYS;
}

/** 子进程日志覆盖键。 */
export function logEnvKeys(): readonly string[] {
    return LOG_ENV_KEYS;
}

/** 用户控制标记键。 */
export function controlEnvKeys(): readonly string[] {
    return CONTROL_ENV_KEYS;
}

/** 闭源 stub 原生契约键（只透传）。 */
export function nativeContractEnvKeys(): readonly string[] {
    return NATIVE_CONTRACT_ENV_KEYS;
}

/** 大小写不敏感读取（Windows 的 `Path` / `PATH` 是同一个变量）。 */
export function readEnv(
    source: EnvSource,
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
export function setEnv(
    target: Record<string, string>,
    key: string,
    value: string,
    platform: NodeJS.Platform = process.platform,
): void {
    deleteEnv(target, key, platform);
    target[key] = value;
}

/** 删除（Windows 大小写不敏感）。 */
export function unsetEnv(
    target: Record<string, string>,
    key: string,
    platform: NodeJS.Platform = process.platform,
): void {
    deleteEnv(target, key, platform);
}

/** 复制白名单键（Windows 大小写不敏感读取，统一写规范化键名）。 */
export function copyKeys(
    target: Record<string, string>,
    source: EnvSource,
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
