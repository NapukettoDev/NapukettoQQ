/**
 * pino 日志封装（ADR-007）
 *
 * - console（pretty 可读输出 / single-line / json 结构化）+ 可选文件双目的地
 * - 统一 level 控制（控制台与文件可分别设级，2026-10-25 日志可配置化）
 * - 内置 redact（token / 票据等敏感字段不打日志），可追加
 * - 无全局单例（ADR-015 推论）：每进程实例化一份，由装配层持有
 *
 * 时间源（2026-10-25 修复）：QQNT 原生层会在 onRecvSysMsg 回调窗口内篡改进程
 * Date（实测记录时间冻结为假值、回调外恢复），故时间戳统一取
 * performance.timeOrigin + performance.now() 单调派生墙钟，不受 Date 篡改影响。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import pino from "pino";
import pinoPretty from "pino-pretty";
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

/** 进程内相对秒标签（elapsed 模式，pretty 字符串时间路径用）。 */
function elapsedLabelNow(): string {
    return `+${(performance.now() / 1000).toFixed(3)}s`;
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
     * （logger name），pino-pretty 渲染为 `(name/pid)` 元数据头。 */
    base?: Optional<Record<string, unknown>>;
    /** 追加的敏感字段路径（默认内置 token/票据等，见 DEFAULT_REDACT_PATHS）。 */
    redact?: string[];
}

/**
 * 创建 pino logger：console（pretty/single-line/json）+ 可选文件，统一 level / redact。
 *
 * 文件目的地用同步写入（`sync: true`）：日志量级下性能可接受，且进程退出不丢日志，
 * 无需额外的 flush 步骤（对比异步 SonicBoom 的 flushSync 时序陷阱）。
 * 文件目的地恒为 JSON 行（数值时间戳），格式/时间戳渲染仅作用于控制台目的地。
 */
/** 控制台流构造参数（格式分支共用）。 */
interface ConsoleStreamParams {
    format: LogFormat;
    timestampMode: TimestampMode;
    colorize: boolean;
    destination: NodeJS.WriteStream;
}

/** 构造控制台流：pretty 走 pino-pretty，single-line/json 走结构化渲染流。 */
function buildConsoleStream(params: ConsoleStreamParams): pino.DestinationStream {
    const { format, timestampMode, colorize, destination } = params;
    if (format !== "pretty") {
        return createConsoleFormatStream({
            format,
            timestamp: timestampMode,
            colorize,
            destination,
        });
    }
    return pinoPretty({
        colorize,
        // 短格式时间（2026-08-07 用户定稿）：完整日期+时区前缀近 60 字符，
        // 每条日志重复占满横向视线；缩短为时分秒+毫秒，文件日志（JSON）
        // 仍保留完整时间戳可精确追溯。
        // ⚠️ 必须带 SYS: 前缀：无前缀按 UTC 渲染（北京 = UTC+8，时间会差 8 小时），
        // SYS: 才用本地系统时间。iso8601 模式用完整日期+时区后缀；elapsed 模式
        // 时间为预渲染字符串（不可解析则 pretty 原样输出），不走 translateTime。
        ...(timestampMode === "local" ? { translateTime: "SYS:HH:MM:ss.l" as const } : {}),
        ...(timestampMode === "iso8601"
            ? { translateTime: "SYS:yyyy-mm-dd'T'HH:MM:ss.l Z" as const }
            : {}),
        // 原生多行展开（默认值，显式声明）：属性按 key/value 逐行渲染，
        // 由 pino-pretty 自带颜色高亮（key 紫色 / 字符串青色），不手写格式化
        // 函数对抗原生渲染——高频业务日志（如收到消息）在调用点直接传
        // 纯字符串，不传对象，天然单行。
        singleLine: false,
        // ⚠️ 必须显式传 destination=process.stdout：pino-pretty 默认用
        // sonic-boom 直写 fd 1（UTF-8 字节流），在 pnpm start（cmd.exe +
        // 管道 936 转码）链路下中文被按 GBK 解码成乱码、ANSI 残留；
        // 走 process.stdout 的 TTY 路径（WriteConsoleW UTF-16）编码正确。
        destination,
    });
}

/** 解析后的渲染参数（createLogger 决策折叠，降低主函数复杂度）。 */
interface ResolvedRenderParams {
    format: LogFormat;
    timestampMode: TimestampMode;
    colorize: boolean;
    destination: NodeJS.WriteStream;
}

/** 折叠 LoggerOptions 的渲染缺省：格式按 TTY 自动（TTY pretty / pipe single-line）、
 * 颜色仅在 pretty 且 TTY 时开。 */
function resolveRenderParams(opts: LoggerOptions): ResolvedRenderParams {
    const destination = opts.destination ?? process.stdout;
    const isTty = destination.isTTY === true;
    const format: LogFormat = opts.format ?? (isTty ? "pretty" : "single-line");
    return {
        format,
        timestampMode: opts.timestamp ?? "local",
        colorize: opts.colorize ?? (format === "pretty" && isTty),
        destination,
    };
}

export function createLogger(opts: LoggerOptions = {}): pino.Logger {
    const consoleLevel = opts.level ?? "info";
    const fileLevel = opts.fileLevel ?? consoleLevel;
    const { file, base } = opts;
    const render = resolveRenderParams(opts);

    const streams: Array<{ stream: pino.DestinationStream; level: pino.LevelWithSilent }> = [];
    if ((opts.console ?? true) === true) {
        streams.push({ stream: buildConsoleStream(render), level: consoleLevel });
    }
    if (file) {
        mkdirSync(dirname(file), { recursive: true });
        streams.push({ stream: pino.destination({ dest: file, sync: true }), level: fileLevel });
    }
    if (streams.length === 0) {
        throw new KernelError("logger 至少需要一个输出目标：console 或 file", "INVALID_PARAM");
    }

    // 记录产生门槛 = 全部目的地中最低级别（multistream 再按各自级别分发过滤）
    let gate: pino.LevelWithSilent = "fatal";
    for (const entry of streams) {
        gate = minLevel(gate, entry.level);
    }

    // 时间戳：local/iso8601 记数值（单调墙钟）交渲染层；elapsed 在 pretty 字符串
    // 时间路径预渲染（pino-pretty 对不可解析字符串时间原样输出）
    const pinoTimestamp =
        render.format === "pretty" && render.timestampMode === "elapsed"
            ? (): string => `,"time":"${elapsedLabelNow()}"`
            : (): string => `,"time":${wallMs()}`;

    const pinoOptions: pino.LoggerOptions = {
        level: gate,
        redact: [...DEFAULT_REDACT_PATHS, ...(opts.redact ?? [])],
        timestamp: pinoTimestamp,
    };
    if (base) {
        pinoOptions.base = { pid: process.pid, ...base };
    }

    let stream: pino.DestinationStream | ReturnType<typeof pino.multistream>;
    if (streams.length === 1) {
        stream = toSingle(streams);
    } else {
        stream = pino.multistream(streams);
    }

    return pino(pinoOptions, stream);
}
