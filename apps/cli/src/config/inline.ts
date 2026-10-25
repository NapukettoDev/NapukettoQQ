/**
 * 内联配置（NAPKETTO_CONFIG_JSON，2026-10-25 嵌入式宿主契约）。
 *
 * KuroBridge 等嵌入式宿主每次拉起前整体生成配置，经环境变量喂 JSON 文本
 * （与 napuketto.toml 同构：parseCliConfig 直接吃 JSON.parse 产物），消除托管
 * toml 文件本体。优先级 NAPKETTO_CONFIG_JSON > NAPKETTO_CONFIG > 缺省模板生成；
 * 内联生效时不读 / 不写 / 不校验任何 toml 文件。Windows 单环境变量上限 32767
 * 字符（约 32KB），嵌入式配置形状远小于该限（超限宿主退回文件形态）。
 *
 * 读取口径分两档（有意为之）：
 * - parseInlineConfig：严格，主配置加载 / config validate 用；JSON 解析失败、
 *   非对象、字段校验失败一律 ConfigError（exit 78 一族）。
 * - readInlineConfigDoc / readInlineConfigSection：宽松，logger 读 [log] 段用；
 *   坏文档返回 undefined（日志配置损坏不阻塞启动，严格校验由主配置路径负责）。
 * loader 引导进程另有自己的宽松读取（编译期不静态依赖 kernel），两套不合并。
 *
 * 错误文案指明来源为「内联配置」且不含任何 toml 文件路径。本模块不 import
 * logger（logger.ts 反向依赖本模块判内联来源）。
 */
import process from "node:process";
import { configError } from "@napuketto/kernel";
import { type CliConfig, parseCliConfig } from "./schema.js";

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

/** JSON.parse 产物 → 配置对象（数组 / null / 原始值 → undefined）。 */
function asConfigObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

/**
 * 读内联配置文档（宽松口径：未设置 / 空串 / JSON 解析失败 / 非对象 → undefined）。
 * 供日志段等「坏配置不阻塞启动」的消费方使用。
 */
function readInlineConfigDoc(): Record<string, unknown> | undefined {
    const text = readInlineConfigText();
    if (text === undefined) {
        return undefined;
    }
    try {
        return asConfigObject(JSON.parse(text) as unknown);
    } catch {
        return undefined;
    }
}

/** 读内联配置的单个顶层段（坏文档 → undefined；logger 读 [log] 用）。 */
export function readInlineConfigSection(key: string): unknown {
    const doc = readInlineConfigDoc();
    return doc === undefined ? undefined : doc[key];
}

/** 严格解析内联 JSON 对象（主配置校验入口；错误一概 ConfigError）。 */
function parseJsonObject(text: string): Record<string, unknown> {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw configError(`内联配置 JSON 解析失败: ${detail}`, { cause: err });
    }
    const object = asConfigObject(doc);
    if (object === undefined) {
        throw configError("内联配置必须是 JSON 对象（与 napuketto.toml 同构）");
    }
    return object;
}

/**
 * 内联 JSON 文本 → 校验后的主配置。JSON 解析失败 / 非对象 / 字段校验失败
 * 均抛 ConfigError（宿主消费 exit 78，不重试）。
 */
export function parseInlineConfig(text: string): CliConfig {
    return parseCliConfig(parseJsonObject(text));
}
