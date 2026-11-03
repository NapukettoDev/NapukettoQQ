/**
 * pino 日志封装（ADR-007）
 *
 * - console（pretty 可读输出 / single-line / json 结构化）+ 可选文件双目的地
 * - 统一 level 控制（控制台与文件可分别设级，2026-10-25 日志可配置化）
 * - 内置 redact（token / 票据等敏感字段不打日志），可追加
 * - 无全局单例（ADR-015 推论）：每进程实例化一份，由装配层持有
 * - 三种控制台格式全部由 log-format 自渲染（2026-11-03 起不再依赖 pino-pretty）
 *
 * 时间源（2026-10-25 修复）：QQNT 原生层会在 onRecvSysMsg 回调窗口内篡改进程
 * Date（实测记录时间冻结为假值、回调外恢复），故时间戳统一取
 * performance.timeOrigin + performance.now() 单调派生墙钟，不受 Date 篡改影响。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import pino from "pino";
import { KernelError } from "./errors.js";
import type { LogFormat, TimestampMode } from "./log-config.js";
import { createConsoleFormatStream } from "./log-format.js";

/** 默认 redact 路径：顶层 token/票据 + 任意深度的密码/密钥。 */
const DEFAULT_REDACT_PATHS = ["token", "ticket", "cookie", "password", "secret"] as const;

/** 级别数值序（求多目的地最低级别用）。 */
const LEVEL_ORDER: readonly pino.LevelWithSilent[] = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
    "silent",
];

/** 取两级别中更低（更宽容）的一个。 */
function minLevel(a: pino.LevelWithSilent, b: pino.LevelWithSilent): pino.LevelWithSilent {
    return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b;
}

/** 单调墙钟毫秒（timeOrigin 为进程启动真实 Unix 时间，不受进程内 Date 篡改影响）。 */
function wallMs(): number {
    return performance.timeOrigin + performance.now();
}

function toSingle(streams: Array<{ stream: pino.DestinationStream }>): pino.DestinationStream {
    const [only] = streams;
    if (only === undefined) {
        // 不可达：调用方已保证 streams 非空
        throw new KernelError("logger 内部错误：目的地列表为空", "UNKNOWN");
    }
    return only.stream;
}

/** 日志级别（pino 标准级别 + silent）。 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

/**
 * 可选属性统一带 `| undefined`（2026-10-25）：exactOptionalPropertyTypes 下
 * 纯直传调用点（装配层透传 LogConfig 字段）可写 `format: cfg.format` 一类
 * 直赋值，免去逐字段条件展开（展开链是复杂度热点）。
 */
type Optional<T> = T | undefined;

export interface LoggerOptions {
    /** 控制台级别，默认 `info`。 */
    level?: Optional<LogLevel>;
    /** 是否输出到 console，默认 true。 */
    console?: Optional<boolean>;
    /** 文件日志路径；不传则不写文件（父目录自动创建）。 */
    file?: Optional<string>;
    /** 文件目的地级别（缺省同 level；可低于控制台级别保留排查信息）。 */
    fileLevel?: Optional<LogLevel>;
    /**
     * 输出格式，默认按 TTY 自动：TTY = pretty（终端体验不变）/ pipe = single-line
     * （嵌入式逐行转发友好）。显式指定后不受 TTY 影响。
     */
    format?: Optional<LogFormat>;
    /** 时间戳渲染模式（local/iso8601/elapsed），默认 local。 */
    timestamp?: Optional<TimestampMode>;
    /** 控制台颜色（缺省自动：pretty 且 TTY 才着色）。 */
    colorize?: Optional<boolean>;
    /** 控制台目的地（缺省 process.stdout；测试注入用）。 */
    destination?: Optional<NodeJS.WriteStream>;
    /** 附加基础字段（如 `{ name: 'kernel' }`），自动保留 pid；name 用 pino 保留字段
     * （logger name），pretty 渲染为 `(name/pid)` 元数据头。 */
    base?: Optional<Record<string, unknown>>;
    /** 追加的敏感字段路径（默认内置 token/票据等，见 DEFAULT_REDACT_PATHS）。 */
    redact?: string[];
}

/** 一片输出目的地（stream + 该目的地级别）。 */
interface OutputTarget {
    stream: pino.DestinationStream;
    level: pino.LevelWithSilent;
}

/** 控制台目的地（console=false 返回 null）。 */
function buildConsoleTarget(
    opts: LoggerOptions,
    render: { format: LogFormat; timestamp: TimestampMode; colorize: boolean },
    destination: NodeJS.WriteStream,
): OutputTarget | null {
    if ((opts.console ?? true) !== true) {
        return null;
    }
    const stream = createConsoleFormatStream({ ...render, destination });
    return { stream, level: opts.level ?? "info" };
}

/** 文件目的地（未配置 file 返回 null；同步写入，父目录自动创建）。 */
function buildFileTarget(opts: LoggerOptions, level: LogLevel): OutputTarget | null {
    const { file } = opts;
    if (file === undefined) {
        return null;
    }
    mkdirSync(dirname(file), { recursive: true });
    return { stream: pino.destination({ dest: file, sync: true }), level };
}

/** 记录产生门槛 = 全部目的地中最低级别（multistream 再按各自级别分发过滤）。 */
function gateLevel(targets: readonly OutputTarget[]): pino.LevelWithSilent {
    let gate: pino.LevelWithSilent = "fatal";
    for (const target of targets) {
        gate = minLevel(gate, target.level);
    }
    return gate;
}

/** 单目的地直连（避免 multistream 包装），多目的地走 multistream。 */
function mergeTargets(
    targets: OutputTarget[],
): pino.DestinationStream | ReturnType<typeof pino.multistream> {
    return targets.length === 1 ? toSingle(targets) : pino.multistream(targets);
}

/**
 * 创建 pino logger：console（pretty/single-line/json）+ 可选文件，统一 level / redact。
 *
 * 文件目的地用同步写入（`sync: true`）：日志量级下性能可接受，且进程退出不丢日志，
 * 无需额外的 flush 步骤（对比异步 SonicBoom 的 flushSync 时序陷阱）。
 * 文件目的地恒为 JSON 行（数值时间戳），格式/时间戳渲染仅作用于控制台目的地。
 */
export function createLogger(opts: LoggerOptions = {}): pino.Logger {
    const consoleLevel = opts.level ?? "info";
    const destination = opts.destination ?? process.stdout;
    const isTty = destination.isTTY === true;
    // 格式按 TTY 自动（TTY pretty / pipe single-line）；颜色仅在 pretty 且 TTY 时开
    const format: LogFormat = opts.format ?? (isTty ? "pretty" : "single-line");
    const timestamp: TimestampMode = opts.timestamp ?? "local";
    const colorize = opts.colorize ?? (format === "pretty" && isTty);

    const targets = [
        buildConsoleTarget(opts, { format, timestamp, colorize }, destination),
        buildFileTarget(opts, opts.fileLevel ?? consoleLevel),
    ].filter((target): target is OutputTarget => target !== null);
    if (targets.length === 0) {
        throw new KernelError("logger 至少需要一个输出目标：console 或 file", "INVALID_PARAM");
    }

    // 时间戳恒记数值（单调墙钟），local/iso8601/elapsed 的差异全部由渲染层决定：
    // 文件日志因此始终是可精确追溯的数值时间，控制台按 timestamp 模式渲染。
    const pinoOptions: pino.LoggerOptions = {
        level: gateLevel(targets),
        redact: [...DEFAULT_REDACT_PATHS, ...(opts.redact ?? [])],
        timestamp: (): string => `,"time":${wallMs()}`,
        ...(opts.base === undefined ? {} : { base: { pid: process.pid, ...opts.base } }),
    };

    return pino(pinoOptions, mergeTargets(targets));
}
