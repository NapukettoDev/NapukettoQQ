/**
 * cli config 子命令：init / list / apply（P6，2026-08-05；2026-08-07 配置文件移到项目根；
 * 2026-08-08 结构拍板：账号内嵌协议段）
 *
 * **全局单配置文件**：`<项目根>/napuketto.toml`（2026-08-07 用户拍板：配置文件放项目根，
 * 数据仍按数据根组织），本项目所有配置都在里面管理（TOML + smol-toml，配合 zod 校验，
 * 用户 2026-08-05 拍板：JSON 门槛太高）。本机配置不入库（.gitignore）。
 *
 * 2026-08-08 结构（用户拍板）：**一个 QQ 账号一个 [[accounts]] 段，协议与通信配置嵌在
 * 账号内**，账号必填（至少一个，qq 必填）：
 *
 *   # dataDir = ".napuketto"    # 可选；缺省 = 项目根/.napuketto（跨平台）
 *   autoRestart = true
 *   restartDelayMs = 2000
 *   [[accounts]]
 *   qq = "123456"                # QQ 号（必填）
 *   enabled = true
 *   [accounts.onebot11]          # 该账号的 OB11 段（无 = 不启用）
 *   token = ""
 *   [[accounts.onebot11.httpServers]]
 *   enabled = true
 *   port = 3000
 *   [accounts.satori]            # 该账号的 Satori 段（无 = 不启用）
 *   [[accounts.satori.httpServers]]
 *   enabled = true
 *   port = 5500
 *
 * 配置文件路径解析见 kernel `resolveConfigPath`（NAPKETTO_CONFIG 显式 > 项目根探测 > 数据根兜底）；
 * 校验器为手写 parse（适配 kernel ConfigBase 的 ConfigSchema 形状）；
 * 协议段由对应协议包的 zod schema 校验（boot 装配时按登录账号 uin 从 accounts 取段作 seed）。
 */
import type { Dirent } from "node:fs";
import { mkdirSync, readdirSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import process from "node:process";
import type { ConfigSchema } from "@napuketto/kernel";
import {
    ConfigBase,
    configError,
    kernelError,
    parseToml,
    resolveConfigPath,
    resolveDataRoot,
    stringifyToml,
} from "@napuketto/kernel";
import { type ConfigSource, parseInlineConfig, readInlineConfigText } from "./config-inline.js";
import { type CliConfig, parseCliConfig } from "./config-parse.js";
import { configTemplate } from "./config-template.js";
import { logger } from "./logger.js";

/** 主配置默认值（dataRoot 为当前解析的数据根 = 项目根/.napuketto）。 */
function defaultCliConfig(dataRoot: string): CliConfig {
    return {
        dataDir: dataRoot,
        autoRestart: true,
        restartDelayMs: 2000,
        accounts: [],
    };
}

/** 配置文件缺失 → 生成带注释模板（首次启动自动生成默认配置）。 */
async function ensureConfigTemplate(path: string): Promise<void> {
    try {
        await access(path);
    } catch {
        mkdirSync(dirname(path), { recursive: true });
        await writeFile(path, `${configTemplate()}\n`, "utf8");
        logger.info({ path }, "配置文件不存在，已生成默认模板（请编辑 accounts 段填入 QQ 号）");
    }
}

/** 主配置 store（读/写/校验；.toml 后缀 → smol-toml 序列化）。
 * 配置文件在项目根（resolveConfigPath），dataRoot 仅作兜底与 dataDir 默认值。 */
class CliConfigStore extends ConfigBase<CliConfig> {
    constructor(dataRoot: string) {
        super({
            path: resolveConfigPath({ dataRoot }),
            schema: { parse: parseCliConfig } satisfies ConfigSchema<CliConfig>,
            defaults: defaultCliConfig(dataRoot),
        });
    }
}

/** 读取主配置（缺失自动落模板；loadCliConfigWithSource 文件分支内部用）。 */
async function loadCliConfig(dataRoot: string): Promise<CliConfig> {
    const store = new CliConfigStore(dataRoot);
    await ensureConfigTemplate(store.path);
    return await store.load();
}

/** 已加载主配置（含来源；启动路径与 config validate 共用）。 */
export interface LoadedCliConfig {
    config: CliConfig;
    source: ConfigSource;
    /** file 来源的配置文件路径；inline 无文件为 undefined。 */
    path?: string;
}

/** 「配置来源」日志每进程至多一行（autoStart 与 runSupervisor 各加载一次）。 */
let sourceLogged = false;

/**
 * 加载主配置（内联优先，2026-10-25 嵌入式契约）：
 * NAPKETTO_CONFIG_JSON 非空 → 内存文档校验（不读 / 不写 / 不校验任何 toml
 * 文件），打一行来源日志；否则现行文件链路（缺失自动落模板）。校验失败两形态
 * 同为 ConfigError（exit 78），文案区别只在来源标注。
 */
export async function loadCliConfigWithSource(
    opts: { dataDir?: string } = {},
): Promise<LoadedCliConfig> {
    const inlineText = readInlineConfigText();
    if (inlineText !== undefined) {
        const config = parseInlineConfig(inlineText);
        if (!sourceLogged) {
            sourceLogged = true;
            logger.info("配置来源: inline（NAPKETTO_CONFIG_JSON）");
        }
        return { config, source: "inline" };
    }
    const dataRoot = resolveDataRoot(opts.dataDir);
    const configPath = resolveConfigPath({ dataRoot });
    const config = await loadCliConfig(dataRoot);
    return { config, source: "file", path: configPath };
}

/** CliConfig → 普通对象（smol-toml stringify 入参）。 */
function toRecord(config: CliConfig): Record<string, unknown> {
    return config as unknown as Record<string, unknown>;
}

/** config init：生成全局 TOML 配置文件（项目根）+ 数据根目录。
 * 文件不存在 → 写带注释模板；已存在 → 跳过（不覆盖用户配置）。
 * 输出原始模板内容（账号未填时解析会校验失败，init 只负责生成不校验）。 */
export async function cmdConfigInit(opts: { dataDir?: string }): Promise<void> {
    const dataRoot = resolveDataRoot(opts.dataDir);
    mkdirSync(dataRoot, { recursive: true });
    const store = new CliConfigStore(dataRoot);
    let created = false;
    try {
        await access(store.path);
    } catch {
        mkdirSync(dirname(store.path), { recursive: true });
        await writeFile(store.path, `${configTemplate()}\n`, "utf8");
        created = true;
    }
    const raw = await readFile(store.path, "utf8");
    logger.info({ dataRoot }, "数据根");
    if (created) {
        logger.info({ path: store.path }, "全局配置已生成（请编辑 accounts 段填入 QQ 号）");
    } else {
        logger.info({ path: store.path }, "全局配置已存在（跳过生成，避免覆盖用户配置）");
    }
    // TOML 内容为功能输出（机器可读），保持原样 stdout，不做日志包装
    process.stdout.write(raw);
}

/** config list：列出全局配置与各账号目录。 */
export async function cmdConfigList(opts: { dataDir?: string }): Promise<void> {
    const dataRoot = resolveDataRoot(opts.dataDir);
    const store = new CliConfigStore(dataRoot);
    const config = await store.load();
    logger.info({ dataRoot }, "数据根");
    logger.info({ path: store.path }, "全局配置");
    process.stdout.write(`${stringifyToml(toRecord(config))}\n`);
    // 账号目录（数据根下的子目录）
    let entries: Dirent[];
    try {
        entries = readdirSync(dataRoot, { withFileTypes: true });
    } catch {
        entries = [];
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            printAccountConfig(entry.name, dataRoot);
        }
    }
}

/** 打印账号 config 目录文件清单。 */
function printAccountConfig(account: string, dataRoot: string): void {
    const configDir = join(dataRoot, account, "config");
    let files: string[] = [];
    try {
        files = readdirSync(configDir).filter((f) => f.endsWith(".json") || f.endsWith(".toml"));
    } catch {
        files = [];
    }
    let fileList = "（未初始化）";
    if (files.length > 0) {
        fileList = files.join(", ");
    }
    // 注意：字段名用 account 而非 name——name 是 pino 保留键（logger name），
    // 会被 pino-pretty 渲染成 `(name/pid)` 元数据头而非普通字段。
    logger.info({ account, files: fileList }, "账号配置");
}

/** 解析外部配置文本（按扩展名推断 TOML/JSON）。 */
function parseExternalConfig(file: string, rawText: string): unknown {
    if (extname(file).toLowerCase() === ".toml") {
        return parseToml(rawText);
    }
    try {
        return JSON.parse(rawText) as unknown;
    } catch {
        throw kernelError(`外部配置 ${file} 不是合法 JSON`, "INVALID_PARAM");
    }
}

/** config apply：应用外部配置（顶层覆盖合并后写回全局配置）。 */
export async function cmdConfigApply(file: string, opts: { dataDir?: string }): Promise<void> {
    const dataRoot = resolveDataRoot(opts.dataDir);
    const store = new CliConfigStore(dataRoot);
    const existing = await store.load();
    let rawText: string;
    try {
        rawText = await readFile(file, "utf8");
    } catch (err) {
        let message = String(err);
        if (err instanceof Error) {
            const { message: errMessage } = err;
            message = errMessage;
        }
        throw kernelError(`读取外部配置失败 ${file}: ${message}`, "INVALID_PARAM", { cause: err });
    }
    const partial = parseExternalConfig(file, rawText);
    if (typeof partial !== "object" || partial === null) {
        throw kernelError("外部配置必须是对象", "INVALID_PARAM");
    }
    const patch = partial as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing, ...patch };
    const next = parseCliConfig(merged);
    await store.save(next);
    logger.info({ path: store.path }, "全局配置已更新");
    // TOML 内容为功能输出（机器可读），保持原样 stdout，不做日志包装
    process.stdout.write(`${stringifyToml(toRecord(next))}\n`);
}

/** 读取配置文件文本（validate 纯只读：ENOENT 不落模板，按「配置缺失」报 ConfigError）。 */
async function readConfigTextForValidate(path: string): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw configError(`配置文件不存在: ${path}`);
        }
        throw configError(`读取配置文件失败: ${path}`, { cause: err });
    }
}

/**
 * 校验配置文件（与运行时同构：ConfigBase.parseText 反序列化 + 校验，报错文案
 * 含路径且与 loadCliConfig 主路径逐字一致；格式按扩展名推断，同 ConfigBase）。
 */
async function validateConfigFile(path: string, dataRoot: string): Promise<void> {
    const raw = await readConfigTextForValidate(path);
    const store = new ConfigBase<CliConfig>({
        path,
        schema: { parse: parseCliConfig } satisfies ConfigSchema<CliConfig>,
        defaults: defaultCliConfig(dataRoot),
    });
    store.parseText(raw);
}

/** config validate 选项（--config / --config-json 二选一；无参 = 校验生效配置）。 */
export interface ConfigValidateOptions {
    /** undefined = 未指定（与 --config-json 互斥）。 */
    configPath?: string | undefined;
    /** undefined = 未指定（与 --config-path 互斥）。 */
    configJson?: string | undefined;
    dataDir?: string;
}

/** config validate 结果（stdout 单行摘要由 index.ts 渲染；测试断言返回值）。 */
export interface ConfigValidateResult {
    source: ConfigSource;
    /** file 来源的配置路径（inline 为 undefined）。 */
    path?: string;
}

/**
 * config validate：校验配置（exit 0 = 合法；exit 78 = 校验失败，ConfigError 一族；
 * --config 与 --config-json 同给 = 用法错误，exit 1）。纯只读——文件形态不落模板
 * （无参形态文件缺失按配置缺失报 78），不触碰数据目录。
 */
export async function cmdConfigValidate(
    opts: ConfigValidateOptions,
): Promise<ConfigValidateResult> {
    const { configPath, configJson } = opts;
    if (configPath !== undefined && configJson !== undefined) {
        throw kernelError("config validate：--config 与 --config-json 只能二选一", "INVALID_PARAM");
    }
    const dataRoot = resolveDataRoot(opts.dataDir);
    if (configJson !== undefined) {
        parseInlineConfig(configJson);
        return { source: "inline" };
    }
    if (configPath !== undefined) {
        await validateConfigFile(configPath, dataRoot);
        return { source: "file", path: configPath };
    }
    // 无参：校验当前生效配置（内联优先；文件缺失按配置缺失报 78，不落模板）
    const inlineText = readInlineConfigText();
    if (inlineText !== undefined) {
        parseInlineConfig(inlineText);
        return { source: "inline" };
    }
    const path = resolveConfigPath({ dataRoot });
    await validateConfigFile(path, dataRoot);
    return { source: "file", path };
}
