/**
 * 内联配置（`NAPUKETTO_CONFIG_JSON`）：KuroBridge 等嵌入式宿主生成 JSON 经 env 喂入（与 napuketto.toml
 * 同构），消除托管 toml 本体；优先级 NAPUKETTO_CONFIG_JSON > NAPUKETTO_CONFIG > 缺省模板生成，内联生效时不读写任何 toml。
 * Windows 单个 env 上限 32767 字符（约 32KB），嵌入式配置形状远小于该限（超限宿主退回文件形态）。
 */
import process from "node:process";
import { configError, errorMessage, isRecord } from "@napuketto/kernel";
import { type CliConfig, parseCliConfig } from "./schema.js";

// 本模块不 import logger：logger.ts 反向依赖本模块判内联来源，反向 import 会成环。

/** 内联配置 env 键（唯一规范拼写；读取为精确键访问，Windows 上 process.env 本身大小写不敏感）。 */
const INLINE_CONFIG_ENV = "NAPUKETTO_CONFIG_JSON";

/** 配置来源。 */
export type ConfigSource = "inline" | "file";

/**
 * 读取内联配置文本（未设置 / 空串 / 纯空白 → undefined，回退文件形态）。
 */
export function readInlineConfigText(): string | undefined {
    const text = process.env[INLINE_CONFIG_ENV];
    return text === undefined || text.trim() === "" ? undefined : text;
}

/** 实际命中的内联配置 env 键名（未生效 → undefined）。来源日志据此标注来源键。 */
export function inlineConfigEnvName(): string | undefined {
    return readInlineConfigText() === undefined ? undefined : INLINE_CONFIG_ENV;
}

/** 内联是否生效（boot/装配链决定「不碰文件」的判定口径，与 readInlineConfigText 同源）。 */
export function isInlineConfigActive(): boolean {
    return readInlineConfigText() !== undefined;
}

/** JSON.parse 产物 → 配置对象（数组 / null / 原始值 → undefined）。 */
function asConfigObject(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

/**
 * 读内联配置文档（宽松口径：未设置 / 空串 / JSON 解析失败 / 非对象 → undefined）。
 * 供日志段等「坏配置不阻塞启动」的消费方使用；loader 引导进程另有自己的宽松读取
 * （编译期不静态依赖 kernel），两套有意不合并。
 */
function readInlineConfigDoc(): Record<string, unknown> | undefined {
    const text = readInlineConfigText();
    if (text === undefined) {
        return undefined;
    }
    try {
        return asConfigObject(JSON.parse(text));
    } catch {
        return undefined;
    }
}

/** 读内联配置的单个顶层段（坏文档 → undefined；logger 读 [log] 用）。 */
export function readInlineConfigSection(key: string): unknown {
    const doc = readInlineConfigDoc();
    return doc === undefined ? undefined : doc[key];
}

/** 严格解析内联 JSON 对象（主配置校验入口；错误一概 ConfigError，文案标明「内联配置」且不含 toml 路径）。 */
function parseJsonObject(text: string): Record<string, unknown> {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        const detail = errorMessage(err);
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
