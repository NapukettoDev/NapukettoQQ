/**
 * [log] 配置段解析（napuketto.toml 全局段，2026-10-25 日志可配置化）。
 *
 * 统一解析入口：cli（apps/cli）与 loader 引导链共用本函数（经 kernel 导出），
 * 避免两处手写解析漂移。输入为 TOML 解析后的 [log] 段原对象（缺失传 undefined）
 * + 环境变量快照；输出为已解析的 LogConfig（env 覆盖优先于 toml）。
 *
 * 环境变量（优先级高于 toml；非法值忽略——与既有 NAPKETTO_LOG_LEVEL 行为一致）：
 *   - NAPUKETTO_LOG_LEVEL / NAPKETTO_LOG_LEVEL（兼容旧拼写，NAPUKETTO_ 优先）
 *   - NAPUKETTO_LOG_FORMAT（pretty | single-line | json）
 *   - NAPUKETTO_NO_BANNER（1/true = 关 banner）
 *   - NAPUKETTO_LOG_COLORIZE（1/true/0/false，CLI 顶层进程向子进程传播控制台
 *     渲染决策用；toml 不暴露此键）
 */
import { kernelError } from "./errors.js";
import type { LogLevel } from "./logger.js";

/** 控制台输出格式。 */
export type LogFormat = "pretty" | "single-line" | "json";
/** 时间戳渲染模式（见 LogConfig.timestamp）。 */
export type TimestampMode = "local" | "iso8601" | "elapsed";
/** 可按模块覆盖级别的模块名（= logger 来源名）。 */
export type LogModuleName = "cli" | "kernel" | "loader" | "ob11";

/** pino 标准级别 + silent。 */
const LOG_LEVEL_VALUES: readonly LogLevel[] = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
    "silent",
];
const LOG_FORMAT_VALUES: readonly LogFormat[] = ["pretty", "single-line", "json"];
const TIMESTAMP_MODE_VALUES: readonly TimestampMode[] = ["local", "iso8601", "elapsed"];
const MODULE_NAME_VALUES: readonly LogModuleName[] = ["cli", "kernel", "loader", "ob11"];

/** 独立文件 sink 配置（[log.file]）。 */
export interface LogFileConfig {
    /** 文件路径（相对路径由消费方按数据根展开）。 */
    path: string;
    /** 文件目的地级别（可低于控制台级别）。 */
    level: LogLevel;
}

/** [log] 段解析结果（env 已覆盖）。 */
export interface LogConfig {
    /** 控制台（全局）级别。 */
    level: LogLevel;
    /**
     * 显式配置的输出格式；undefined = 未配置——消费端按 TTY 自动
     * （TTY = pretty 保持终端体验 / pipe = single-line 嵌入式友好），
     * 显式配置值不受 TTY 影响。
     */
    format?: LogFormat;
    /** 是否打印启动 banner（CLI 入口）。 */
    banner: boolean;
    /** 时间戳渲染模式（json 格式恒为 ISO8601，不受此键影响）。 */
    timestamp: TimestampMode;
    /** false = 未绑定频道的群消息接收行不打（需 kurobot 握手拿到绑定表后生效）。 */
    unboundReceive: boolean;
    /** 按模块覆盖全局级别。 */
    levels: Partial<Record<LogModuleName, LogLevel>>;
    /** 独立文件 sink（不配 = 沿用各层缺省文件日志）。 */
    file?: LogFileConfig;
    /**
     * 控制台颜色（env 专用：CLI 顶层进程向 pipe 后面的子进程传播用；
     * undefined = 消费端自动判定 TTY + pretty）。
     */
    colorize?: boolean;
}

/** 环境变量快照类型（process.env 的结构子集，便于测试注入）。 */
export type LogEnvSource = Record<string, string | undefined>;

/** 校验级别字面量；非法值抛 INVALID_PARAM。 */
function requireLevel(value: unknown, key: string): LogLevel {
    if (typeof value !== "string" || !(LOG_LEVEL_VALUES as readonly string[]).includes(value)) {
        throw kernelError(
            `主配置 ${key} 必须是日志级别（${LOG_LEVEL_VALUES.join(" / ")}）`,
            "INVALID_PARAM",
        );
    }
    return value as LogLevel;
}

/** 宽松级别解析（env 覆盖用；非法/缺失返回 undefined 不生效）。 */
function optionalLevel(value: string | undefined): LogLevel | undefined {
    if (value === undefined) {
        return undefined;
    }
    return (LOG_LEVEL_VALUES as readonly string[]).includes(value)
        ? (value as LogLevel)
        : undefined;
}

/** 宽松格式解析（env 覆盖用）。 */
function optionalFormat(value: string | undefined): LogFormat | undefined {
    if (value === undefined) {
        return undefined;
    }
    return (LOG_FORMAT_VALUES as readonly string[]).includes(value)
        ? (value as LogFormat)
        : undefined;
}

/** 宽松布尔解析（env 用：仅识别 1/true/0/false，其余忽略）。 */
function optionalBool(value: string | undefined): boolean | undefined {
    if (value === "1" || value === "true") {
        return true;
    }
    if (value === "0" || value === "false") {
        return false;
    }
    return undefined;
}

/** 解析 [log.levels] 按模块覆盖表（未知模块名报错，键集封闭防拼写错误）。 */
function parseModuleLevels(raw: unknown): Partial<Record<LogModuleName, LogLevel>> {
    if (raw === undefined) {
        return {};
    }
    if (typeof raw !== "object" || raw === null) {
        throw kernelError("主配置 log.levels 必须是对象", "INVALID_PARAM");
    }
    const out: Partial<Record<LogModuleName, LogLevel>> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!(MODULE_NAME_VALUES as readonly string[]).includes(key)) {
            throw kernelError(
                `主配置 log.levels 未知模块 "${key}"（合法模块：${MODULE_NAME_VALUES.join(" / ")}）`,
                "INVALID_PARAM",
            );
        }
        out[key as LogModuleName] = requireLevel(value, `log.levels.${key}`);
    }
    return out;
}

/** 解析 [log.file] 独立文件 sink。 */
function parseLogFile(raw: unknown, fallbackLevel: LogLevel): LogFileConfig {
    if (typeof raw !== "object" || raw === null) {
        throw kernelError("主配置 log.file 必须是对象", "INVALID_PARAM");
    }
    const record = raw as Record<string, unknown>;
    const path = record["path"];
    if (typeof path !== "string" || path === "") {
        throw kernelError("主配置 log.file.path 必须是非空字符串", "INVALID_PARAM");
    }
    const level =
        record["level"] === undefined
            ? fallbackLevel
            : requireLevel(record["level"], "log.file.level");
    return { path, level };
}

/** [log] 解析中间产物（可变草稿：toml 字段与 env 覆盖分步填充）。 */
interface LogConfigDraft extends LogConfig {
    /** [log.file] 是否显式配置 level（env 覆盖判断用；不进最终配置面）。 */
    fileLevelExplicit?: boolean;
}

/** 校验字面量枚举值（非法抛 INVALID_PARAM，报错文案带键名与合法值集）。 */
function requireEnum<T extends string>(value: unknown, key: string, values: readonly T[]): T {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
        throw kernelError(`主配置 ${key} 必须是（${values.join(" / ")}）`, "INVALID_PARAM");
    }
    return value as T;
}

/** 校验布尔字段（undefined 保留原值）。 */
function applyBoolean(
    draft: LogConfigDraft,
    raw: Record<string, unknown>,
    key: "banner" | "unboundReceive",
): void {
    if (raw[key] === undefined) {
        return;
    }
    if (typeof raw[key] !== "boolean") {
        throw kernelError(`主配置 log.${key} 必须是布尔值`, "INVALID_PARAM");
    }
    draft[key] = raw[key] as boolean;
}

/** toml [log] 段字段填充（level/format/timestamp/banner/unboundReceive）。 */
function applySectionFields(draft: LogConfigDraft, raw: Record<string, unknown>): void {
    if (raw["level"] !== undefined) {
        draft.level = requireLevel(raw["level"], "log.level");
    }
    if (raw["format"] !== undefined) {
        draft.format = requireEnum(raw["format"], "log.format", LOG_FORMAT_VALUES);
    }
    if (raw["timestamp"] !== undefined) {
        draft.timestamp = requireEnum(raw["timestamp"], "log.timestamp", TIMESTAMP_MODE_VALUES);
    }
    applyBoolean(draft, raw, "banner");
    applyBoolean(draft, raw, "unboundReceive");
}

/** env 覆盖（优先级高于 toml；非法值忽略）：兼容旧拼写 NAPKETTO_LOG_LEVEL。
 * file.level 显式配置时不被 env 全局级别顶掉（缺省跟随全局）。 */
function applyEnvOverrides(draft: LogConfigDraft, env: LogEnvSource): void {
    const envLevel =
        optionalLevel(env["NAPUKETTO_LOG_LEVEL"]) ?? optionalLevel(env["NAPKETTO_LOG_LEVEL"]);
    if (envLevel !== undefined) {
        draft.level = envLevel;
        if (draft.file !== undefined && draft.fileLevelExplicit !== true) {
            draft.file = { ...draft.file, level: envLevel };
        }
    }
    const envFormat = optionalFormat(env["NAPUKETTO_LOG_FORMAT"]);
    if (envFormat !== undefined) {
        draft.format = envFormat;
    }
    if (optionalBool(env["NAPUKETTO_NO_BANNER"]) === true) {
        draft.banner = false;
    }
    const envColorize = optionalBool(env["NAPUKETTO_LOG_COLORIZE"]);
    if (envColorize !== undefined) {
        draft.colorize = envColorize;
    }
}

/**
 * 解析 [log] 段 + 环境变量覆盖。
 *
 * @param section TOML 解析后的 [log] 段（缺失/undefined = 全缺省）
 * @param env 环境变量快照（默认空对象 = 无 env 覆盖）
 */
export function parseLogConfig(section: unknown, env: LogEnvSource = {}): LogConfig {
    const draft: LogConfigDraft = {
        level: "info",
        banner: true,
        timestamp: "local",
        unboundReceive: true,
        levels: {},
    };
    if (section !== undefined) {
        if (typeof section !== "object" || section === null) {
            throw kernelError("主配置 log 段必须是对象", "INVALID_PARAM");
        }
        const raw = section as Record<string, unknown>;
        applySectionFields(draft, raw);
        draft.levels = parseModuleLevels(raw["levels"]);
        if (raw["file"] !== undefined) {
            draft.file = parseLogFile(raw["file"], draft.level);
            draft.fileLevelExplicit =
                typeof raw["file"] === "object" &&
                raw["file"] !== null &&
                (raw["file"] as Record<string, unknown>)["level"] !== undefined;
        }
    }
    applyEnvOverrides(draft, env);
    // 内部传递字段不进最终配置面
    delete draft.fileLevelExplicit;
    return draft;
}
