/**
 * 控制台渲染流（pretty / single-line / json，2026-10-25 日志可配置化；
 * 2026-11-03 起 pretty 自渲染，移除对 pino-pretty 的依赖）。
 *
 * 三种格式共用同一个「pino JSON 行 → 人读行」渲染入口（文件目的地恒为 JSON 行，
 * 不受本模块影响）：
 *
 *   pretty：多行彩色，终端交互形态
 *           `[HH:MM:ss.l] INFO (name/pid): 消息` + 逐行 `key: value`（4 空格缩进，
 *           嵌套对象/数组按 JSON 形状展开；字段名紫、消息青、级别按级别着色）
 *   single-line：`[时间] LEVEL (name/pid): 消息 key=value key=value`
 *   json：NDJSON，每行 {time, level, module, account?, pid, msg, ...fields}
 *
 * 时间渲染（LogConfig.timestamp）：local = [HH:MM:ss.l]（与 history 一致）、
 * iso8601 = 2026-10-25T16:01:33.294+08:00、elapsed = +123.456s（进程内单调秒）。
 * json 的 time 恒为 ISO8601（机器可解析契约，不受 timestamp 键影响）。
 */
import process from "node:process";
import type pino from "pino";
import type { LogFormat, TimestampMode } from "./log-config.js";

/** 级别数值 → 名称（pino 标准映射）。 */
const LEVEL_LABELS: Record<number, string> = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal",
};

/** 级别颜色（pretty 级别标签 / single-line 级别与元数据头共用）。 */
const LEVEL_COLORS: Record<string, string> = {
    trace: "\u001b[34m",
    debug: "\u001b[36m",
    info: "\u001b[32m",
    warn: "\u001b[33m",
    error: "\u001b[31m",
    fatal: "\u001b[91m",
};
const DIM = "\u001b[2m";
/** 字段名（紫，沿用原 pino-pretty 缺省配色）。 */
const KEY_COLOR = "\u001b[35m";
/** 消息（青，沿用原 pino-pretty 缺省配色）。 */
const MESSAGE_COLOR = "\u001b[36m";
const RESET = "\u001b[0m";

/** pretty 顶层字段缩进（4 空格，与原多行输出一致）。 */
const PRETTY_INDENT = "    ";
/** pretty 嵌套值缩进（2 空格 JSON 缩进，与原多行输出一致）。 */
const NESTED_INDENT = "  ";
/** 换行切分（多行字符串展开用；顶层常量避免每次调用重建正则）。 */
const NEWLINE = /\r?\n/;

/** 结构化流选项。 */
export interface ConsoleFormatStreamOptions {
    /** 输出格式（三种格式全部由本模块渲染）。 */
    format: LogFormat;
    /** 时间戳渲染模式。 */
    timestamp: TimestampMode;
    /** pretty / single-line 是否着色（json 恒不着色）。 */
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

/** 单调墙钟毫秒 → 本地时分秒（原 `SYS:HH:MM:ss.l` 短格式）。 */
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
        // 记录时间已是预渲染字符串时原样透出（兼容旧日志/外部注入）
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

/** 着色（useColor=false / 空串 / 未知级别无色码时原样返回，避免多余转义）。 */
function paint(code: string, text: string, useColor: boolean): string {
    return useColor && code !== "" && text !== "" ? `${code}${text}${RESET}` : text;
}

/** k=v 内联值：字符串裸输出（含空格时不加引号——宽松人类格式），其余 JSON 序列化。 */
function inlineValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value) ?? "null";
}

/** 结构化输出忽略的标准字段（渲染进头/独立字段，不进字段尾部）。 */
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

/** 元数据头：(name/pid)，无 name 时 (pid)。 */
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

/** single-line 渲染：[时间] LEVEL (name/pid): 消息 k=v k=v（级别大写）。 */
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

/** 标量渲染（字符串 JSON 引号；数字/布尔/null/undefined 原样）。 */
function renderScalar(value: unknown): string {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (value === null || value === undefined) {
        return String(value);
    }
    // symbol / function / bigint 等非 JSON 值：尽力转字符串（渲染不抛错）
    return String(value);
}

/** 给渲染块末行追加逗号（容器内非末项用）。 */
function withTrailingComma(lines: string[], trailing: boolean): string[] {
    if (!trailing || lines.length === 0) {
        return lines;
    }
    const copy = [...lines];
    const last = copy.length - 1;
    copy[last] = `${copy[last] ?? ""},`;
    return copy;
}

/**
 * 容器（对象/数组）内一条属性的行：首行接 `key: 值`，续行保持嵌套缩进。
 * 多行字符串的首行为空串，此时 key 行不带尾随内容（值从下一行开始）。
 */
function renderEntryLines(pad: string, key: string, value: unknown, depth: number): string[] {
    const entryPad = `${pad}${NESTED_INDENT}`;
    const [first = "", ...rest] = renderValueLines(value, depth + 1);
    const inline = first.slice(entryPad.length);
    const keyText = `${entryPad}${JSON.stringify(key)}:`;
    const head = inline === "" ? keyText : `${keyText} ${inline}`;
    return rest.length === 0 ? [head] : [head, ...rest];
}

/** 数组渲染：`[` / 元素（逗号分隔）/ `]`。 */
function renderArrayLines(value: readonly unknown[], depth: number): string[] {
    const pad = NESTED_INDENT.repeat(depth);
    if (value.length === 0) {
        return [`${pad}[]`];
    }
    const lines = [`${pad}[`];
    const lastIndex = value.length - 1;
    for (const [index, item] of value.entries()) {
        lines.push(...withTrailingComma(renderValueLines(item, depth + 1), index < lastIndex));
    }
    lines.push(`${pad}]`);
    return lines;
}

/** 对象渲染：`{` / 属性（逗号分隔）/ `}`。 */
function renderObjectLines(value: Record<string, unknown>, depth: number): string[] {
    const pad = NESTED_INDENT.repeat(depth);
    const entries = Object.entries(value);
    if (entries.length === 0) {
        return [`${pad}{}`];
    }
    const lines = [`${pad}{`];
    const lastIndex = entries.length - 1;
    for (const [index, [key, entryValue]] of entries.entries()) {
        lines.push(
            ...withTrailingComma(renderEntryLines(pad, key, entryValue, depth), index < lastIndex),
        );
    }
    lines.push(`${pad}}`);
    return lines;
}

/** 多行字符串展开：首行留空，内容逐行多缩进一级（典型 err.stack）。 */
function renderMultilineStringLines(value: string, depth: number): string[] {
    const pad = NESTED_INDENT.repeat(depth);
    return [`${pad}`, ...value.split(NEWLINE).map((line) => `${pad}${PRETTY_INDENT}${line}`)];
}

/**
 * pretty 值渲染成行（每行带 depth 级 2 空格缩进）：
 * - 对象/数组按 JSON 形状展开（嵌套键带引号）；空容器渲染成 `[]` / `{}`；
 * - 多行字符串（典型为 err.stack）不带引号展开，避免整段堆栈被转义成一行 `\n`；
 * - 其余标量原样（字符串带 JSON 引号）。
 */
function renderValueLines(value: unknown, depth: number): string[] {
    if (Array.isArray(value)) {
        return renderArrayLines(value, depth);
    }
    if (typeof value === "object" && value !== null) {
        return renderObjectLines(value as Record<string, unknown>, depth);
    }
    if (typeof value === "string" && value.includes("\n")) {
        return renderMultilineStringLines(value, depth);
    }
    return [`${NESTED_INDENT.repeat(depth)}${renderScalar(value)}`];
}

/** pretty 单条顶层字段：`    key: 值`（嵌套续行按 JSON 缩进对齐）。 */
function renderPrettyField(key: string, value: unknown, useColor: boolean): string[] {
    const [first = "", ...rest] = renderValueLines(value, 0);
    const label = paint(KEY_COLOR, key, useColor);
    const head = first === "" ? `${PRETTY_INDENT}${label}:` : `${PRETTY_INDENT}${label}: ${first}`;
    return [head, ...rest.map((line) => `${PRETTY_INDENT}${line}`)];
}

/** pretty 渲染：多行彩色 `[时间] LEVEL (name/pid): 消息` + 逐行字段。 */
function renderPrettyLine(record: Record<string, unknown>, ctx: RenderContext): string {
    const label = levelLabel(record["level"]);
    const color = LEVEL_COLORS[label.toLowerCase()] ?? "";
    const time = renderTime(record["time"], ctx.timestamp, false, ctx.timeOriginMs);
    const msg = typeof record["msg"] === "string" ? record["msg"] : "";
    const head = `[${time}] ${paint(color, label.toUpperCase(), ctx.useColor)} ${renderMeta(record)}:`;
    const lines = msg === "" ? [head] : [`${head} ${paint(MESSAGE_COLOR, msg, ctx.useColor)}`];
    for (const [key, value] of Object.entries(record)) {
        if (!RESERVED_KEYS.has(key)) {
            lines.push(...renderPrettyField(key, value, ctx.useColor));
        }
    }
    return `${lines.join("\n")}\n`;
}

/** 创建控制台渲染流（pretty / single-line / json）。 */
export function createConsoleFormatStream(
    opts: ConsoleFormatStreamOptions,
): pino.DestinationStream {
    const out = opts.destination ?? process.stdout;
    const ctx: RenderContext = {
        timestamp: opts.timestamp,
        timeOriginMs: performance.timeOrigin,
        useColor: opts.format !== "json" && opts.colorize,
    };
    const render =
        opts.format === "pretty"
            ? renderPrettyLine
            : opts.format === "json"
              ? renderJsonLine
              : renderSingleLine;

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
