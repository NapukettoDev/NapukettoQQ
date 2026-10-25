/**
 * 结构化控制台流（single-line / json 格式，2026-10-25 日志可配置化）。
 *
 * pino-pretty 面向交互终端（多行展开 / JSON 内联渲染），其 singleLine 输出为
 * `msg {"k":"v"}` 形态且 messageFormat 会与字段追加双重渲染——无法干净满足
 * 嵌入式宿主的「一条记录一行、字段 k=v / NDJSON」契约，故自写轻量渲染流：
 *
 *   single-line：[时间] LEVEL (name/pid): 消息 key=value key=value
 *   json：NDJSON，每行 {time, level, module, account?, pid, msg, ...fields}
 *
 * 时间渲染（LogConfig.timestamp）：local = [HH:MM:ss.l]（与 pretty 缺省一致）、
 * iso8601 = 2026-10-25T16:01:33.294+08:00、elapsed = +123.456s（进程内单调秒）。
 * json 的 time 恒为 ISO8601（机器可解析契约，不受 timestamp 键影响）。
 */
import process from "node:process";
import type pino from "pino";
import type { TimestampMode } from "./log-config.js";

/** 级别数值 → 名称（pino 标准映射）。 */
const LEVEL_LABELS: Record<number, string> = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal",
};

/** single-line 颜色（colorize 时仅着色级别与元数据头，正文默认色）。 */
const LEVEL_COLORS: Record<string, string> = {
    trace: "\u001b[34m",
    debug: "\u001b[36m",
    info: "\u001b[32m",
    warn: "\u001b[33m",
    error: "\u001b[31m",
    fatal: "\u001b[91m",
};
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** 结构化流选项。 */
export interface ConsoleFormatStreamOptions {
    /** 输出格式（pretty 走 pino-pretty，不进本流）。 */
    format: "single-line" | "json";
    /** 时间戳渲染模式。 */
    timestamp: TimestampMode;
    /** single-line 是否着色（json 恒不着色）。 */
    colorize: boolean;
    /** 输出目的地（缺省 process.stdout；测试注入用）。 */
    destination?: NodeJS.WriteStream;
}

/** 2 位补零。 */
function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

/** 单调墙钟毫秒 → 本地时区 ISO8601（+08:00 形态；new Date(epoch) 构造不受 Date.now 篡改影响）。 */
function isoLocalTime(epochMs: number): string {
    const d = new Date(epochMs);
    const offsetMinutes = -d.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    return (
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
        `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
        `.${String(d.getMilliseconds()).padStart(3, "0")}` +
        `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
    );
}

/** 单调墙钟毫秒 → 本地时分秒（与 pino-pretty SYS:HH:MM:ss.l 一致的短格式）。 */
function localShortTime(epochMs: number): string {
    const d = new Date(epochMs);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(
        d.getMilliseconds(),
    ).padStart(3, "0")}`;
}

/** 单调墙钟毫秒 → 进程内相对秒（+123.456s）。 */
function elapsedLabel(epochMs: number, timeOriginMs: number): string {
    return `+${((epochMs - timeOriginMs) / 1000).toFixed(3)}s`;
}

/** 渲染记录时间（timestamp 模式分发；json 恒 ISO8601）。 */
function renderTime(
    rawTime: unknown,
    mode: TimestampMode,
    forceIso: boolean,
    timeOriginMs: number,
): string {
    if (typeof rawTime === "string") {
        // pretty+elapsed 等场景记录时间已是预渲染字符串，原样透出
        return rawTime;
    }
    const epoch = typeof rawTime === "number" ? rawTime : timeOriginMs;
    if (forceIso || mode === "iso8601") {
        return isoLocalTime(epoch);
    }
    if (mode === "elapsed") {
        return elapsedLabel(epoch, timeOriginMs);
    }
    return localShortTime(epoch);
}

/** 级别数值 → 标签名。 */
function levelLabel(raw: unknown): string {
    if (typeof raw === "number") {
        return LEVEL_LABELS[raw] ?? String(raw);
    }
    return typeof raw === "string" ? raw.toUpperCase() : "LOG";
}

/** k=v 内联值：字符串裸输出（含空格时不加引号——宽松人类格式），其余 JSON 序列化。 */
function inlineValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value) ?? "null";
}

/** 结构化输出忽略的标准字段（渲染进头/独立字段，不进 k=v 尾部）。 */
const RESERVED_KEYS = new Set(["pid", "hostname", "level", "time", "msg", "name"]);

/** 渲染上下文（流构造时固化，渲染函数共享）。 */
interface RenderContext {
    timestamp: TimestampMode;
    timeOriginMs: number;
    useColor: boolean;
}

/** json 渲染：NDJSON 契约 {time, level, module, account?, pid, msg, ...fields}。 */
function renderJsonLine(record: Record<string, unknown>, ctx: RenderContext): string {
    const { time, level, name, module, account, pid, msg: _msg, ...fields } = record;
    const msg = typeof record["msg"] === "string" ? record["msg"] : "";
    const jsonLine = {
        time: renderTime(time, ctx.timestamp, true, ctx.timeOriginMs),
        level: levelLabel(level).toLowerCase(),
        ...(module !== undefined
            ? { module: module as string }
            : typeof name === "string"
              ? { module: name }
              : {}),
        ...(account !== undefined ? { account: account as string } : {}),
        ...(typeof pid === "number" ? { pid } : {}),
        msg,
        ...fields,
    };
    return `${JSON.stringify(jsonLine)}\n`;
}

/** single-line 元数据头：(name/pid)，无 name 时 (pid)。 */
function renderMeta(record: Record<string, unknown>): string {
    const pid = record["pid"] ?? "-";
    const name = record["name"];
    return typeof name === "string" ? `(${name}/${pid})` : `(${pid})`;
}

/** single-line 附加字段：非保留键按 k=v 内联（无字段时空串）。 */
function renderKvFields(record: Record<string, unknown>): string {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(record)) {
        if (!RESERVED_KEYS.has(key)) {
            fields.push(`${key}=${inlineValue(value)}`);
        }
    }
    return fields.length > 0 ? ` ${fields.join(" ")}` : "";
}

/** single-line 渲染：[时间] LEVEL (name/pid): 消息 k=v k=v（级别大写与 pretty 一致）。 */
function renderSingleLine(record: Record<string, unknown>, ctx: RenderContext): string {
    const label = levelLabel(record["level"]);
    const msg = typeof record["msg"] === "string" ? record["msg"] : "";
    const time = renderTime(record["time"], ctx.timestamp, false, ctx.timeOriginMs);
    const labelUpper = label.toUpperCase();
    const meta = renderMeta(record);
    const fieldsSuffix = renderKvFields(record);
    if (ctx.useColor) {
        const color = LEVEL_COLORS[label.toLowerCase()] ?? "";
        return `${DIM}[${time}]${RESET} ${color}${labelUpper}${RESET} ${DIM}${meta}:${RESET} ${msg}${fieldsSuffix}\n`;
    }
    return `[${time}] ${labelUpper} ${meta}: ${msg}${fieldsSuffix}\n`;
}

/** 创建结构化控制台流（single-line / json）。 */
export function createConsoleFormatStream(
    opts: ConsoleFormatStreamOptions,
): pino.DestinationStream {
    const out = opts.destination ?? process.stdout;
    const ctx: RenderContext = {
        timestamp: opts.timestamp,
        timeOriginMs: performance.timeOrigin,
        useColor: opts.format === "single-line" && opts.colorize,
    };
    const render = opts.format === "json" ? renderJsonLine : renderSingleLine;

    return {
        write(line: string) {
            let record: Record<string, unknown>;
            try {
                record = JSON.parse(line) as Record<string, unknown>;
            } catch {
                // 非法 JSON 行原样透出（不吞日志）
                out.write(`${line}\n`);
                return;
            }
            out.write(render(record, ctx));
        },
    };
}
