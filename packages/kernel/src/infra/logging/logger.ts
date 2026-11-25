/**
 * pino 日志封装（ADR-007）：console（pretty / single-line / json 全部自渲染）+ 可选文件双目的地，
 * 级别可分设、内置 redact（token/票据不入日志），无全局单例。时间源：QQNT 原生层会在 onRecvSysMsg
 * 回调窗口内篡改进程 Date（实测记录时间冻结为假值、回调外恢复），故时间戳统一由 performance 单调派生。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import pino from "pino";
import { kernelError } from "../errors.js";
import { resolveSandboxWritePath } from "../paths.js";
import type { LogFormat, LogLevel, TimestampMode } from "./log-config.js";
import { createConsoleFormatStream } from "./log-format.js";
import { redactLogLine } from "./log-redaction.js";

export type { LogLevel } from "./log-config.js";

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
        throw kernelError("logger 内部错误：目的地列表为空", "UNKNOWN");
    }
    return only.stream;
}

/**
 * 可选属性统一带 `| undefined`：exactOptionalPropertyTypes 下纯直传调用点
 * （装配层透传 LogConfig 字段）可写 `format: cfg.format` 一类直赋值，免去逐字段条件展开。
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
    /** 附加 pino 敏感字段路径；内置字段名保护由输出层统一执行，不能禁用。 */
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
    if (opts.file === undefined) {
        return null;
    }
    const file = resolveSandboxWritePath(opts.file, "log.file.path");
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
        throw kernelError("logger 至少需要一个输出目标：console 或 file", "INVALID_PARAM");
    }

    // 时间戳恒记数值（单调墙钟），local/iso8601/elapsed 的差异全部由渲染层决定：
    // 文件日志因此始终是可精确追溯的数值时间，控制台按 timestamp 模式渲染。
    const pinoOptions: pino.LoggerOptions = {
        level: gateLevel(targets),
        redact: opts.redact ?? [],
        serializers: { err: pino.stdSerializers.errWithCause },
        hooks: { streamWrite: redactLogLine },
        timestamp: (): string => `,"time":${wallMs()}`,
        ...(opts.base === undefined ? {} : { base: { pid: process.pid, ...opts.base } }),
    };

    return pino(pinoOptions, mergeTargets(targets));
}
