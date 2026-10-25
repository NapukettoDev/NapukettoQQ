/**
 * 内联配置（NAPKETTO_CONFIG_JSON，2026-10-25 嵌入式宿主契约）。
 *
 * KuroBridge 等嵌入式宿主每次拉起前整体生成配置，经环境变量喂 JSON 文本
 * （与 napuketto.toml 同构：parseCliConfig 直接吃 JSON.parse 产物），消除托管
 * toml 文件本体。优先级 NAPKETTO_CONFIG_JSON > NAPKETTO_CONFIG > 缺省模板生成；
 * 内联生效时不读 / 不写 / 不校验任何 toml 文件。Windows 单环境变量上限 32767
 * 字符（约 32KB），嵌入式配置形状远小于该限（超限宿主退回文件形态）。
 *
 * 错误一概 ConfigError（exit 78 一族），文案指明来源为「内联配置」且不含任何
 * toml 文件路径。本模块不 import logger（logger.ts 反向依赖本模块判内联来源）。
 */
import process from "node:process";
import { configError } from "@napuketto/kernel";
import { type CliConfig, parseCliConfig } from "./config-parse.js";

/** 内联配置 env 键（读取为精确键访问；Windows 上 process.env 本身大小写不敏感）。 */
const INLINE_CONFIG_ENV = "NAPKETTO_CONFIG_JSON";

/** 配置来源。 */
export type ConfigSource = "inline" | "file";

/**
 * 读取内联配置文本（未设置 / 空串 / 纯空白 → undefined，回退文件形态）。
 */
export function readInlineConfigText(): string | undefined {
    const raw = process.env[INLINE_CONFIG_ENV];
    if (raw === undefined || raw.trim() === "") {
        return undefined;
    }
    return raw;
}

/** 内联是否生效（boot/装配链决定「不碰文件」的判定口径，与 readInlineConfigText 同源）。 */
export function isInlineConfigActive(): boolean {
    return readInlineConfigText() !== undefined;
}

/**
 * 内联 JSON 文本 → 校验后的主配置。JSON 解析失败 / 非对象 / 字段校验失败
 * 均抛 ConfigError（宿主消费 exit 78，不重试）。
 */
export function parseInlineConfig(text: string): CliConfig {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw configError(`内联配置 JSON 解析失败: ${detail}`, { cause: err });
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        throw configError("内联配置必须是 JSON 对象（与 napuketto.toml 同构）");
    }
    return parseCliConfig(doc);
}
