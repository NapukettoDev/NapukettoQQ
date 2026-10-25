/**
 * 主配置 store：默认值、ConfigBase 子类、模板落盘、内联/文件来源加载。
 *
 * 从 config-cmds.ts 拆出（2026-10-25 模块收拢）：
 * - `CliConfigStore` 只负责 napuketto.toml 的读写/校验（kernel ConfigBase）；
 * - `loadCliConfigWithSource` 负责来源决议（NAPKETTO_CONFIG_JSON 优先）与来源日志；
 * - 4 个 config 子命令留在 commands/config.ts，不反向依赖本文件的私有实现。
 */
import { mkdirSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConfigSchema } from "@napuketto/kernel";
import { ConfigBase, resolveConfigPath, resolveDataRoot } from "@napuketto/kernel";
import { logger } from "../logger.js";
import { type ConfigSource, parseInlineConfig, readInlineConfigText } from "./inline.js";
import { type CliConfig, parseCliConfig } from "./schema.js";
import { configTemplate } from "./template.js";

/** 主配置默认值（dataRoot 为当前解析的数据根 = 项目根/.napuketto）。 */
export function defaultCliConfig(dataRoot: string): CliConfig {
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
export class CliConfigStore extends ConfigBase<CliConfig> {
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

/** 生效配置来源（内联优先；只解析来源，不读文件、不落模板）。 */
export type ResolvedCliConfigSource =
    | { source: "inline"; text: string }
    | { source: "file"; path: string; dataRoot: string };

/**
 * 解析生效配置来源（loadCliConfigWithSource 与 config validate 无参分支共用）：
 * 内联非空 → inline；否则按 kernel resolveConfigPath 解析文件路径，并带回数据根。
 */
export function resolveCliConfigSource(opts: { dataDir?: string } = {}): ResolvedCliConfigSource {
    const inlineText = readInlineConfigText();
    if (inlineText !== undefined) {
        return { source: "inline", text: inlineText };
    }
    const dataRoot = resolveDataRoot(opts.dataDir);
    return { source: "file", path: resolveConfigPath({ dataRoot }), dataRoot };
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
    const resolved = resolveCliConfigSource(opts);
    if (resolved.source === "inline") {
        const config = parseInlineConfig(resolved.text);
        if (!sourceLogged) {
            sourceLogged = true;
            logger.info("配置来源: inline（NAPKETTO_CONFIG_JSON）");
        }
        return { config, source: "inline" };
    }
    const config = await loadCliConfig(resolved.dataRoot);
    return { config, source: "file", path: resolved.path };
}
