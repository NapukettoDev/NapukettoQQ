/**
 * 主配置类型与手写校验器（从 config-cmds.ts 拆分，2026-08-08 FTA 优化）
 *
 * 主配置 parse（不引入 zod）：数据根 / 自动重启 / 重启延迟 / 账号列表。
 * 2026-08-08 结构拍板：**一个 QQ 账号一个 [[accounts]] 段，协议与通信配置嵌在
 * 账号内**（[accounts.onebot11] / [accounts.satori]）；账号必填（至少一个）。
 * 协议段为宽松对象，装配时由对应协议包的 zod schema 严格校验。
 * 全部校验错误为 ConfigError（2026-10-25 嵌入式退出码契约：CLI exit 78 一族，
 * 内联与文件两形态共用本校验器）。
 */
import { configError, type LogConfig, parseLogConfig, resolveDataRoot } from "@napuketto/kernel";
import { RESERVED_PLACEHOLDER_QINS } from "./config-template.js";

/** 默认自动重启。 */
const DEFAULT_AUTO_RESTART = true;
/** 默认重启延迟（毫秒）。 */
const DEFAULT_RESTART_DELAY_MS = 2000;

/** QQ 号格式：纯数字 5-11 位（QQ 号合法范围，勿写死 11 位）。 */
const QQ_IN_FORMAT_RE = /^\d{5,11}$/;

/** 协议段键（宽松对象，装配时 zod 严格校验）。 */
type ProtocolKey = "onebot11" | "satori" | "kurobot";

/** 账号配置项（qq 必填；协议段缺省 = 该账号不启用对应协议）。 */
export interface CliAccountConfig {
    qq: string;
    enabled?: boolean;
    /** OneBot 11 协议段（与 ob11ConfigSchema 对应，宽松对象，装配时 zod 校验）。 */
    onebot11?: Record<string, unknown>;
    /** Satori 协议段（与 satoriConfigSchema 对应，宽松对象，装配时 zod 校验）。 */
    satori?: Record<string, unknown>;
    /** Kurobot 协议段（与 kurobotConfigSchema 对应，宽松对象，装配时 zod 校验）。 */
    kurobot?: Record<string, unknown>;
}

/** 主配置（跨账号，全局单文件 TOML）。 */
export interface CliConfig {
    /** 数据根目录（绝对路径）。 */
    dataDir: string;
    /** supervisor 是否自动重启崩溃账号。 */
    autoRestart: boolean;
    /** 崩溃后重启延迟（毫秒）。 */
    restartDelayMs: number;
    /** 账号列表（至少一个，qq 必填）。 */
    accounts: CliAccountConfig[];
    /** [log] 日志配置段（kernel parseLogConfig 解析；未配置段时 undefined = 全缺省）。 */
    log?: LogConfig;
}

/** 解析账号内协议段（宽松对象，装配时由 zod schema 严格校验）。 */
function parseProtocolSection(
    raw: Record<string, unknown>,
    key: ProtocolKey,
): Record<string, unknown> | undefined {
    const section = raw[key];
    if (section === undefined) {
        return;
    }
    if (typeof section !== "object" || section === null) {
        throw configError(`主配置账号 ${key} 段必须是对象`);
    }
    return section as Record<string, unknown>;
}

/**
 * 解析 dataDir（缺省用当前解析的数据根 = 项目根/.napuketto）。
 * 支持绝对路径、"~/" 前缀（用户主目录）、相对路径（相对启动目录），
 * 消费端 resolveDataRoot 统一展开为绝对路径。
 */
function parseDataDir(raw: Record<string, unknown>): string {
    if (raw["dataDir"] === undefined) {
        return resolveDataRoot();
    }
    if (typeof raw["dataDir"] !== "string" || raw["dataDir"] === "") {
        throw configError("主配置 dataDir 必须是非空字符串");
    }
    return raw["dataDir"];
}

/** 解析 autoRestart。 */
function parseAutoRestart(raw: Record<string, unknown>): boolean {
    if (raw["autoRestart"] === undefined) {
        return DEFAULT_AUTO_RESTART;
    }
    if (typeof raw["autoRestart"] !== "boolean") {
        throw configError("主配置 autoRestart 必须是布尔值");
    }
    return raw["autoRestart"];
}

/** 解析 restartDelayMs（毫秒）。 */
function parseRestartDelayMs(raw: Record<string, unknown>): number {
    if (raw["restartDelayMs"] === undefined) {
        return DEFAULT_RESTART_DELAY_MS;
    }
    if (
        typeof raw["restartDelayMs"] !== "number" ||
        !Number.isInteger(raw["restartDelayMs"]) ||
        raw["restartDelayMs"] <= 0
    ) {
        throw configError("主配置 restartDelayMs 必须是正整数");
    }
    return raw["restartDelayMs"];
}

/** 解析 accounts（必须至少一个账号，qq 必填）。 */
function parseAccounts(raw: Record<string, unknown>): CliAccountConfig[] {
    if (raw["accounts"] === undefined) {
        throw configError(
            "主配置缺少 accounts（必须至少一个账号）；首次启动已生成模板，请编辑后重试",
        );
    }
    if (!Array.isArray(raw["accounts"]) || raw["accounts"].length === 0) {
        throw configError(
            "主配置 accounts 必须是非空数组（至少一个 QQ 账号）；首次启动已生成模板，请编辑后重试",
        );
    }
    const accounts: CliAccountConfig[] = [];
    for (const item of raw["accounts"]) {
        accounts.push(parseAccount(item));
    }
    return accounts;
}

/** 解析单个账号项（qq 必填；协议段缺省 = 不启用）。 */
function parseAccount(item: unknown): CliAccountConfig {
    if (typeof item !== "object" || item === null) {
        throw configError("主配置 accounts 元素必须是对象");
    }
    const { qq, enabled } = item as { qq?: unknown; enabled?: unknown };
    if (typeof qq !== "string" || qq === "") {
        throw configError("主配置账号缺少非空 qq");
    }
    if (!QQ_IN_FORMAT_RE.test(qq)) {
        throw configError("主配置账号 qq 必须是 5-11 位纯数字 QQ 号");
    }
    if (RESERVED_PLACEHOLDER_QINS.some((placeholder) => placeholder === qq)) {
        throw configError(
            `主配置账号 qq "${qq}" 是模板占位值，请编辑配置文件填入真实 QQ 号后再启动`,
        );
    }
    const out: CliAccountConfig = { qq };
    if (enabled !== undefined) {
        if (typeof enabled !== "boolean") {
            throw configError("主配置账号 enabled 必须是布尔值");
        }
        out.enabled = enabled;
    }
    const raw = item as Record<string, unknown>;
    const onebot11 = parseProtocolSection(raw, "onebot11");
    if (onebot11 !== undefined) {
        out.onebot11 = onebot11;
    }
    const satori = parseProtocolSection(raw, "satori");
    if (satori !== undefined) {
        out.satori = satori;
    }
    const kurobot = parseProtocolSection(raw, "kurobot");
    if (kurobot !== undefined) {
        out.kurobot = kurobot;
    }
    return out;
}

/**
 * [log] 段落库净化：format 为 undefined（= 按 TTY 自动）时剔除该键，
 * 避免 toml 回写（config list/apply 的 stringifyToml）遇到 undefined 值。
 */
function stripUndefinedFormat(log: LogConfig): LogConfig {
    const { format, ...rest } = log;
    return format === undefined ? rest : { ...rest, format };
}

/**
 * [log] 段解析（kernel parseLogConfig 错误归一为 ConfigError）：日志段非法同属
 * 「配置未就绪」一族（exit 78）；错误文案保持 kernel 原文（主配置 log.xxx ...）。
 */
function parseLogSection(input: unknown): LogConfig {
    try {
        return parseLogConfig(input);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw configError(`主配置 [log] 段非法: ${detail}`, { cause: err });
    }
}

/** 手写校验器：主配置 parse（不引入 zod）。全部校验错误为 ConfigError（exit 78 一族）。 */
export function parseCliConfig(input: unknown): CliConfig {
    if (typeof input !== "object" || input === null) {
        throw configError("主配置必须是对象");
    }
    const raw = input as Record<string, unknown>;
    const dataDir = parseDataDir(raw);
    const autoRestart = parseAutoRestart(raw);
    const restartDelayMs = parseRestartDelayMs(raw);
    const accounts = parseAccounts(raw);
    // [log] 段：kernel parseLogConfig 严格校验（非法值报错；未配置段 = undefined）
    const log =
        raw["log"] !== undefined ? stripUndefinedFormat(parseLogSection(raw["log"])) : undefined;
    return {
        dataDir,
        autoRestart,
        restartDelayMs,
        accounts,
        ...(log !== undefined ? { log } : {}),
    };
}
