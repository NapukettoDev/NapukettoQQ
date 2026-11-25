/**
 * NapukettoCore 的装配辅助（从 `core.ts` 拆出）
 *
 * wrapperPath / appid / QQ 数据目录解析与登录选项映射。全部为纯函数，
 * 由 `core.ts` 的装配根调用；不持有状态。
 */
import { dirname, join } from "node:path";
import process from "node:process";
import { isRecord, kernelError } from "../infra/index.js";
import type { WrapperContext } from "../native/wrapper/lifecycle.js";
import { electronProcessType, resolveQqUserDataRoot } from "../native/wrapper/loader.js";
import { resolveQqGlobalPath } from "../native/wrapper/qq-data-path.js";
import { buildLoginConfig, resolveAppidQua } from "../native/wrapper/wrapper-config.js";
import type { CoreContext } from "./context.js";
import type { QuickLoginOptions } from "./login/index.js";

/** wrapperPath 环境变量键（唯一规范拼写）。 */
const WRAPPER_PATH_ENV_KEY = "NAPUKETTO_WRAPPER_PATH";

/** 解析 wrapperPath：wrapper 上下文优先，其次环境变量。 */
export function resolveWrapperPath(wrapper: WrapperContext): string | undefined {
    if (wrapper.wrapperPath !== undefined && wrapper.wrapperPath !== "") {
        return wrapper.wrapperPath;
    }
    const value = process.env[WRAPPER_PATH_ENV_KEY];
    if (value !== undefined && value !== "") {
        return value;
    }
    return undefined;
}

/**
 * appid 解析：显式传入优先；否则从 wrapperPath 同目录 major.node 解析。
 * 仍无法解析时抛清晰的 INVALID_PARAM（不静默回退过期 appid）。
 */
export function resolveCoreAppid(wrapper: WrapperContext, explicit: string | undefined): string {
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const wrapperPath = resolveWrapperPath(wrapper);
    if (wrapperPath !== undefined) {
        try {
            return resolveAppidQua(
                wrapper.versionInfo.fullVersion,
                join(dirname(wrapperPath), "major.node"),
            ).appid;
        } catch {
            // 继续走下方清晰报错（保留原始语义：无法定位 major.node）
        }
    }
    throw kernelError(
        "未提供 appid 且无法自动定位 major.node，请在 CoreLoginOptions.appid 或 BootEnv.wrapperPath 中指定",
        "INVALID_PARAM",
    );
}

/**
 * session 数据目录：worker/自建宿主优先 QQ 真实数据目录（数据根/nt_qq/global），
 * 否则回退账号目录（与 loader bootstrap-core 的激活路径同口径）。
 */
export function resolveSessionAccountPath(ctx: CoreContext, wrapper: WrapperContext): string {
    const root = resolveQqUserDataRoot(wrapper.exports, { dataRoot: ctx.paths.root });
    return root !== null ? resolveQqGlobalPath(root) : ctx.paths.accountDir;
}

/**
 * loginService.initConfig 的 commonPath：
 * worker/自建宿主（非 browser）优先 QQ 真实数据目录（数据根/nt_qq/global），
 * 否则回退账号目录。Linux 下数据根即 Napuketto 数据根（`ctx.paths.root`），
 * Windows 由 QQ 官方 API 定位。
 */
export function resolveCommonPath(ctx: CoreContext, wrapper: WrapperContext): string {
    if (electronProcessType() !== "browser") {
        const root = resolveQqUserDataRoot(wrapper.exports, { dataRoot: ctx.paths.root });
        if (root !== null) {
            return resolveQqGlobalPath(root);
        }
    }
    return ctx.paths.accountDir;
}

/**
 * loginService.initConfig 形状守卫（可带一个配置参数调用）。
 * `hasFunctionProp` 的函数类型是「零参可调用」（`(...args: never[])`），
 * 这里需要带参调用，故给一个精确到参数的谓词。
 */
export function hasInitConfig(
    val: Record<string, unknown>,
): val is Record<string, unknown> & { initConfig: (config: unknown) => void } {
    return typeof val["initConfig"] === "function";
}

/** CoreLoginOptions → quickLogin 参数（仅取快速登录相关两键，QR 键不透传）。 */
export function buildQuickLoginOptions(opts: {
    quickUin?: string | undefined;
    quickLoginTimeoutMs?: number | undefined;
}): QuickLoginOptions {
    const quickOpts: QuickLoginOptions = {};
    if (opts.quickUin !== undefined) {
        quickOpts.uin = opts.quickUin;
    }
    if (opts.quickLoginTimeoutMs !== undefined) {
        quickOpts.quickLoginTimeoutMs = opts.quickLoginTimeoutMs;
    }
    return quickOpts;
}

/**
 * loginService.initConfig（worker/自建宿主需指定 QQ 真实数据路径）。
 * worker（utilityProcess）模式 + 自建宿主（标准 node）下 loginService 是
 * new 的，commonPath 必须指向 QQ 真实数据目录（数据根/nt_qq/global，
 * HANDOVER-V6 三要素之三）才能读到历史账号——cli 的 `.napuketto\default`
 * 读不到（getLoginList 空，P2-1 实测 2026-08-06）。
 * QQ 主进程（V1）模式 QQ 自己 initConfig 过正确路径，无需解析。
 */
export function initLoginConfig(ctx: CoreContext, wrapper: WrapperContext, appid: string): void {
    const raw = wrapper.loginService;
    if (!isRecord(raw) || !hasInitConfig(raw)) {
        ctx.logger.warn("loginService 不可用，跳过 initConfig");
        return;
    }
    const commonPath = resolveCommonPath(ctx, wrapper);
    const loginCfg = buildLoginConfig(appid, wrapper.versionInfo.fullVersion, commonPath);
    raw["initConfig"](loginCfg);
    ctx.logger.info({ commonPath }, "loginService.initConfig OK");
}
