/**
 * wrapper 原生装载与 QQ 数据目录定位：`dlopenWrapper`（自建宿主引导原语）、
 * `resolveQqUserDataRoot` / `electronProcessType`（QQ 数据根与进程类型探测）、
 * `defaultEngineConfig` / `resolveBootQqGlobalPath`（engine 装配所需的平台配置）。
 */
import { homedir, version as osVersion } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import {
    hasCallableProp,
    kernelError,
    resolveDataRoot,
    resolveSandboxWritePath,
} from "../../infra/index.js";
import type { EnginInitDesktopConfig, WrapperNodeApi } from "../../types/index.js";
import { PlatformType } from "../../types/index.js";
import { extractDataRoot, resolveQqGlobalPath } from "./qq-data-path.js";
import { buildQua, detectPlatformType, parseQuaFromMajor } from "./wrapper-config.js";
import { getElectronProcessType, isWrapperNodeApi } from "./wrapper-guards.js";

/** startNapuketto 的引导环境（由 loader launcher 注入环境变量，boot.cjs 透传）。 */
export interface BootEnv {
    /** QQ 版本（如 "9.9.31-49919"）。 */
    qqVersion?: string | undefined;
    /** 用户数据目录（cfgDir 的父级，用于 desktopPathConfig）。 */
    dataDir?: string | undefined;
    /** 数据根（Linux 和调试沙箱下 QQ 数据存放在 `<dataRoot>/nt_qq`）。 */
    dataRoot?: string | undefined;
    /** 账号 uin（可选，提供则一步 init+start）。 */
    selfUin?: string | undefined;
    /** 账号 uid（可选）。 */
    selfUid?: string | undefined;
    /**
     * wrapper.node 绝对路径（appid 自动解析用：同目录 major.node）。
     * 缺省回退 `NAPUKETTO_WRAPPER_PATH` 环境变量。
     */
    wrapperPath?: string | undefined;
}

/**
 * 默认 engine 配置（按平台探测）。
 *
 * 平台：`process.platform` → KLINUX/KMAC/KWINDOWS；qua 优先从 wrapper.node 同目录
 * major.node 扫描（`NAPUKETTO_WRAPPER_PATH` 由 loader 注入），找不到再按版本拼。
 * Linux 实测需要 `V1_LNX_NQ_3.2.35_54395_GW_B`；Windows 旧行为（qua 空）仅在
 * 拿不到版本/major.node 时保底。
 */
export function defaultEngineConfig(env: BootEnv, qqDataPath?: string): EnginInitDesktopConfig {
    const platform = detectPlatformType();
    const fullVersion = env.qqVersion ?? "";
    const wrapperPath = env.wrapperPath ?? process.env["NAPUKETTO_WRAPPER_PATH"] ?? "";
    const majorPath = wrapperPath !== "" ? join(dirname(wrapperPath), "major.node") : "";
    const scanned = majorPath !== "" ? parseQuaFromMajor(majorPath) : null;
    const qua = scanned ?? (fullVersion !== "" ? buildQua(fullVersion, platform) : "");
    return {
        base_path_prefix: env.dataDir ?? "",
        platform_type: platform,
        app_type: 4,
        app_version: fullVersion,
        os_version: osVersion() || process.platform,
        use_xlog: platform !== PlatformType.KWINDOWS,
        qua,
        global_path_config: {
            desktopGlobalPath: qqDataPath ?? env.dataDir ?? "",
        },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
    };
}

/**
 * Electron 进程类型（Node 的 process 类型无此字段）。
 * - "browser"：QQ 主进程（V1 模式）
 * - "utility"：utilityProcess Worker
 */
export function electronProcessType(): string | undefined {
    return getElectronProcessType(process);
}

/** `resolveQqUserDataRoot` 选项（平台覆盖供测试/联调，缺省按 `process.platform` 探测）。 */
export interface QqDataRootOptions {
    /** 数据根（`NAPUKETTO_DATA` / `--data-dir` 解析结果）。Linux 和调试沙箱在此存放 QQ 数据。 */
    dataRoot?: string | undefined;
    /** 平台覆盖（缺省 `detectPlatformType()`）。 */
    platform?: PlatformType | undefined;
}

/**
 * 解析 QQ 用户数据根（登录数据目录，如 `C:\Users\<user>\Documents\Tencent Files`）。
 * 优先 NodeQQNTWrapperUtil.getNTUserDataInfoConfig()（QQ 官方 API），回退默认位置。
 *
 * ⚠️ worker（utilityProcess）模式下 loginService 是 `new NodeIKernelLoginService()` 新建的，
 * 其 initConfig 的 commonPath 必须指向 QQ 真实数据路径才能读到历史账号——cli 的
 * `.napuketto\default` 数据目录读不到（getLoginList 返回空 → 只能 QR 登录）；V1 主进程模式
 * QQ 自己 initConfig 过正确路径，无需此解析。
 *
 * 平台分流：Linux（KLINUX）自建宿主持有 QQ 数据，直接用数据根（`<数据根>/nt_qq`），
 * 不读 `$HOME`——否则换机器/换用户读不到历史账号，还会把 QQ 崩溃目录等写进用户主目录；
 * Windows 调试沙箱也使用传入的数据根，其余 Windows 场景走官方 API + 默认位置兜底。
 */
export function resolveQqUserDataRoot(
    exports: WrapperNodeApi,
    opts: QqDataRootOptions = {},
): string | null {
    if (process.env["NAPUKETTO_SANDBOX_ROOT"]) {
        const dataRoot = resolveDataRoot(opts.dataRoot || process.env["NAPUKETTO_DATA_ROOT"]);
        resolveSandboxWritePath(resolveQqGlobalPath(dataRoot), "QQ 数据目录");
        return dataRoot;
    }
    const platform = opts.platform ?? detectPlatformType();
    if (platform === PlatformType.KLINUX) {
        const dataRoot =
            opts.dataRoot ??
            process.env["NAPUKETTO_DATA_ROOT"] ??
            process.env["NAPUKETTO_DATA"] ??
            "";
        if (dataRoot !== "") {
            return dataRoot;
        }
    }
    return extractUserDataRoot(exports) ?? join(homedir(), "Documents", "Tencent Files");
}

/** 从 QQ 官方 API 提取数据根（不可用返回 null，调用方回退默认）。 */
function extractUserDataRoot(exports: WrapperNodeApi): string | null {
    try {
        const utilCtor = exports.NodeQQNTWrapperUtil;
        if (hasCallableProp(utilCtor, "get")) {
            const inst = utilCtor.get();
            if (hasCallableProp(inst, "getNTUserDataInfoConfig")) {
                const raw = inst.getNTUserDataInfoConfig();
                if (typeof raw === "string" && raw.trim() !== "") {
                    return extractDataRoot(raw.trim());
                }
            }
        }
    } catch {
        // 回退默认位置
    }
    return null;
}

/**
 * 解析 QQ 真实数据目录的 global 路径（desktopGlobalPath 三要素之三）。
 * worker（utilityProcess）模式 + 自建宿主（标准 node）下必须指向 QQ 真实数据目录
 * （数据根/nt_qq/global），否则登录数据读写错位、getLoginList 为空；QQ 主进程（V1）
 * QQ 自己已配置 engine，无需解析。
 *
 * `dataRoot` 在 Linux 和调试沙箱生效（`resolveQqUserDataRoot` 平台分流）：loader 由
 * `NAPUKETTO_DATA_ROOT` 注入，QQ 数据固定落 `<数据根>/nt_qq/global`。
 */
export function resolveBootQqGlobalPath(
    exports: WrapperNodeApi,
    dataRoot?: string,
): string | undefined {
    if (electronProcessType() === "browser") {
        return undefined;
    }
    const root = resolveQqUserDataRoot(
        exports,
        dataRoot !== undefined && dataRoot !== "" ? { dataRoot } : {},
    );
    if (root === null) {
        return undefined;
    }
    return resolveQqGlobalPath(root);
}

/**
 * 加载 wrapper.node 原生模块并校验核心导出（自建宿主引导原语：原生 `dlopen` 是
 * kernel 的唯一原生层职责，loader 只编排流程）。
 *
 * @param wrapperPath wrapper.node 绝对路径（QQ 安装目录 / 缓存文件根）
 * @returns NAPI exports（含 NodeIKernelLoginService 等构造器）
 * @throws KernelError exports 缺 NodeIKernelLoginService（stub 环境异常）或 dlopen 失败
 */
export function dlopenWrapper(wrapperPath: string): WrapperNodeApi {
    // { exports: {} } 是 process.dlopen 的最小载体（wrapper 向其中填充 NAPI exports）
    const m: { exports: Record<string, unknown> } = { exports: {} };
    process.dlopen(m, wrapperPath);
    if (!Object.keys(m.exports).includes("NodeIKernelLoginService")) {
        throw kernelError("exports 无 NodeIKernelLoginService（stub 环境异常？）", "INVALID_STATE");
    }
    if (!isWrapperNodeApi(m.exports)) {
        throw kernelError(
            `wrapper.node at ${wrapperPath} did not export expected QQNT symbols`,
            "INVALID_STATE",
        );
    }
    return m.exports;
}
