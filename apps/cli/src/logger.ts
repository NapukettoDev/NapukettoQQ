/**
 * cli 进程级 logger：复用 kernel `createLogger`，输出格式/级别/时间戳/颜色由 napuketto.toml [log] 段 +
 * 环境变量决定（kernel parseLogConfig 单一解析源；env 优先级高于 toml）。
 * 懒构造：preAction 钩子先 resolveCliLogConfig 缓存（banner 决策），首个日志调用时按缓存构造。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import {
    createLogger,
    type LogConfig,
    type LogFormat,
    parseLogConfig,
    parseToml,
    resolveConfigPath,
    resolveDataRoot,
    resolveSandboxWritePath,
} from "@napuketto/kernel";
import { isInlineConfigActive, readInlineConfigSection } from "./config/inline.js";

/** 已解析日志配置缓存（同一数据根复用；显式传入不同数据根时重新解析）。 */
let cachedConfig: LogConfig | null = null;
/** 解析配置时用的数据根（[log.file] 相对路径展开基准，兼缓存键）。 */
let cachedDataRoot: string = resolveDataRoot();

/** 同步解析日志配置（内联 > toml 文件的 [log] 段 + env 覆盖）。损坏/缺失配置回退缺省
 * （不阻塞启动：配置的严格校验由 loadCliConfig 主路径负责报错）。内联生效时不读
 * 任何 toml 文件。
 *
 * 缓存口径：显式 `dataDir` 解析出的根与缓存不一致时重新解析，
 * 避免早期无参调用（缺省数据根）把后续 `-d` 指定数据根的配置/日志路径锁死；
 * 无参调用始终复用当前缓存（preAction 解析后，懒构造 logger 的 LazyCliLogger
 * 不能再用缺省根把 `-d` 的结果覆盖掉）。 */
export function resolveCliLogConfig(dataDir?: string): LogConfig {
    if (cachedConfig !== null) {
        if (dataDir === undefined || resolveDataRoot(dataDir) === cachedDataRoot) {
            return cachedConfig;
        }
    }
    cachedDataRoot = resolveDataRoot(dataDir);
    let section: unknown;
    if (isInlineConfigActive()) {
        // 宽松口径（config/inline 单一实现）：坏内联文档 → undefined，不阻塞日志构造
        section = readInlineConfigSection("log");
    } else {
        try {
            const configPath = resolveConfigPath({ dataRoot: cachedDataRoot });
            section = parseToml(readFileSync(configPath, "utf8"))["log"];
        } catch {
            section = undefined;
        }
    }
    try {
        cachedConfig = parseLogConfig(section, process.env);
    } catch {
        // [log] 段非法：env 覆盖仍生效，缺省兜底（主配置加载路径会给出确切报错）
        cachedConfig = parseLogConfig(undefined, process.env);
    }
    if (cachedConfig.file !== undefined) {
        try {
            resolveLogFilePath(cachedConfig.file.path);
        } catch (err) {
            // Report the configuration error through a console-only logger.
            cachedConfig = parseLogConfig(undefined, process.env);
            throw err;
        }
    }
    return cachedConfig;
}

/**
 * 顶层进程的最终控制台格式（[log] format 显式优先，否则按 TTY 自动：
 * 终端 pretty / 管道 single-line）。supervisor 的前缀转发决策同源。
 */
export function effectiveConsoleFormat(cfg: LogConfig): LogFormat {
    const isTty = process.stdout.isTTY === true;
    return cfg.format ?? (isTty ? "pretty" : "single-line");
}

/**
 * 顶层进程的有效控制台渲染决策（传播给子进程）：
 * 子进程 stdout 恒为 pipe（TTY 判定失真），由本进程按最终控制台形态决定
 * format/colorize 并经 env 注入（NAPUKETTO_LOG_FORMAT/NAPUKETTO_LOG_COLORIZE）。
 */
export function effectiveConsoleEnv(cfg: LogConfig): Record<string, string> {
    const isTty = process.stdout.isTTY === true;
    const format = effectiveConsoleFormat(cfg);
    const colorize = cfg.colorize ?? (format === "pretty" && isTty);
    return {
        NAPUKETTO_LOG_FORMAT: format,
        NAPUKETTO_LOG_COLORIZE: colorize ? "1" : "0",
    };
}

/** [log.file] 相对路径按数据根展开。 */
function resolveLogFilePath(path: string): string {
    return resolveSandboxWritePath(
        isAbsolute(path) ? path : join(cachedDataRoot, path),
        "log.file.path",
    );
}

/**
 * 窄接口注解（避免 TS2883：createLogger 返回 pino.Logger，cli 不直接依赖 pino，
 * declaration emit 无法命名该类型；pino.Logger 结构兼容本接口）。
 */
export interface CliLogger {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
    debug(obj: unknown, msg?: string): void;
    trace(obj: unknown, msg?: string): void;
    fatal(obj: unknown, msg?: string): void;
}

/** cli logger 构造参数（[log] 段折叠；file/fileLevel 成对生效，其余直传 undefined）。 */
function cliLoggerOptions(cfg: LogConfig): Parameters<typeof createLogger>[0] {
    return {
        level: cfg.levels.cli ?? cfg.level,
        format: cfg.format,
        timestamp: cfg.timestamp,
        colorize: cfg.colorize,
        file: cfg.file !== undefined ? resolveLogFilePath(cfg.file.path) : undefined,
        fileLevel: cfg.file?.level,
        // name=cli：与 kernel/loader 统一（pretty 渲染 (cli/pid) 头，
        // json 通道作 module 字段），service 保留作进程来源过滤
        base: { name: "cli", service: "cli" },
    };
}

/** 懒构造 cli 进程日志（name 渲染为 (cli/pid) 元数据头，文件 JSON 保留 name 字段可过滤）。 */
class LazyCliLogger implements CliLogger {
    #inner: CliLogger | null = null;

    #ensure(): CliLogger {
        if (this.#inner === null) {
            this.#inner = createLogger(cliLoggerOptions(resolveCliLogConfig()));
        }
        return this.#inner;
    }

    info(obj: unknown, msg?: string): void {
        this.#ensure().info(obj, msg);
    }
    warn(obj: unknown, msg?: string): void {
        this.#ensure().warn(obj, msg);
    }
    error(obj: unknown, msg?: string): void {
        this.#ensure().error(obj, msg);
    }
    debug(obj: unknown, msg?: string): void {
        this.#ensure().debug(obj, msg);
    }
    trace(obj: unknown, msg?: string): void {
        this.#ensure().trace(obj, msg);
    }
    fatal(obj: unknown, msg?: string): void {
        this.#ensure().fatal(obj, msg);
    }
}

/** cli 进程日志（懒构造，配置见 resolveCliLogConfig）。 */
export const logger: CliLogger = new LazyCliLogger();
