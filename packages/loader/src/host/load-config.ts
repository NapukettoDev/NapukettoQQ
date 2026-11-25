/**
 * 协议配置段读取（从 protocols.ts 拆分，2026-08-08 FTA 优化；2026-08-08 结构拍板：按账号取段）
 *
 * 主配置来源（2026-10-25 嵌入式内联契约）：**NAPUKETTO_CONFIG_JSON（内联 JSON，
 * 与 napuketto.toml 同构）> NAPUKETTO_CONFIG（文件）> NAPUKETTO_CFG_DIR 兜底（旧行为
 * 兼容）**。内联生效时不读任何 toml 文件，cfgFile 返回哨兵 "<inline>"（仅作
 * ProtocolConfig 来源标注；seed 模式本就不读盘，协议段热更新在内联形态不可用）。
 *
 * 全局配置：**协议配置嵌在账号内**——accounts 数组每项含 [onebot11] / [satori] /
 * [kurobot] / [milky] 段，登录成功后按账号 uin 找到对应项，取其段作 seed（zod 校验）。
 * （ConfigBase seed 模式：load() 直接用内存值，不再读写独立协议文件）
 *
 * 内联分支宽松（解析失败回退文件形态并记日志，不阻塞引导）：cli 主路径已在
 * 拉起前完整校验（exit 78），走到这里的坏内联多见于绕过 cli 的直跑场景。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getErrorMessage, isRecord } from "../internal/type-guards.js";
import { PROTOCOL_KEYS, type ProtocolKey } from "./constants.js";
import { env } from "./env.js";
import type { KernelLike } from "./types.js";
import { ConfigError, log } from "./util.js";

/** 协议段表（协议键 → 宽松段对象；装配时 zod 校验）。 */
type SectionMap = Record<ProtocolKey, Record<string, unknown>>;

/** 协议配置段（账号内 [onebot11] / [satori] / [kurobot] / [milky]，宽松对象，装配时 zod 校验）。 */
export interface ProtocolSections {
    cfgFile: string;
    /** 表驱动访问面：协议键 → 段对象（装配方按 PROTOCOL_KEYS 消费）。 */
    sections: SectionMap;
    /** 具名投影（兼容既有调用方；= sections.onebot11 等，同一引用）。 */
    ob11Section: Record<string, unknown>;
    satoriSection: Record<string, unknown>;
    kurobotSection: Record<string, unknown>;
    milkySection: Record<string, unknown>;
}

/** ProtocolSections 的具名投影面（兼容既有测试与调用方）。 */
type SectionFields = Pick<
    ProtocolSections,
    "sections" | "ob11Section" | "satoriSection" | "kurobotSection" | "milkySection"
>;

/** 内联来源时 cfgFile 的哨兵值（非文件路径；日志/错误标注里不出现真实路径）。 */
const INLINE_CONFIG_SENTINEL = "<inline>";

/** Relative local media roots in IPC and network mode have the same deployment base. */
export function localMediaBaseDir(cfgFile: string, dataRoot: string | undefined): string {
    return cfgFile === INLINE_CONFIG_SENTINEL
        ? resolve(dataRoot ?? ".")
        : dirname(resolve(cfgFile));
}

/** 用动态加载的协议 schema 校验内存配置，保留宿主配置错误的退出码。 */
export function parseProtocolSeed(
    label: string,
    schema: { parse(input: unknown): unknown },
    section: Record<string, unknown>,
): unknown {
    try {
        return schema.parse(section);
    } catch (error) {
        const detail = getErrorMessage(error).replace(/\s+/g, " ").trim();
        throw new ConfigError(`协议配置 ${label} 段校验失败: ${detail}`, { cause: error });
    }
}

/** 宽松账号项（TOML [[accounts]] 元素 / JSON accounts 元素）。 */
type AccountLike = Record<string, unknown>;

/** 账号内取协议段（宽松对象，装配时 zod 校验）。 */
function sectionOf(account: AccountLike, key: ProtocolKey): Record<string, unknown> | undefined {
    const section = account[key];
    return isRecord(section) ? section : undefined;
}

/** 全空协议段表（未找到账号 / 无协议段 / 读取失败）。 */
function emptySections(): SectionMap {
    return { onebot11: {}, satori: {}, kurobot: {}, milky: {} };
}

/** 协议段表 → ProtocolSections（具名属性只是同一批对象的兼容投影）。 */
function sectionFields(sections: SectionMap): SectionFields {
    return {
        sections,
        ob11Section: sections.onebot11,
        satoriSection: sections.satori,
        kurobotSection: sections.kurobot,
        milkySection: sections.milky,
    };
}

/**
 * 读内联配置文档（NAPUKETTO_CONFIG_JSON 非空才生效；JSON 解析失败 / 非对象 →
 * undefined 回退文件形态并记日志）。
 */
export function readInlineConfigDoc(): Record<string, unknown> | undefined {
    const raw = env.NAPUKETTO_CONFIG_JSON;
    if (raw === undefined || raw.trim() === "") {
        return undefined;
    }
    try {
        const doc: unknown = JSON.parse(raw);
        if (isRecord(doc)) {
            return doc;
        }
        log("bootstrap: 内联配置不是 JSON 对象（回退文件形态）");
        return undefined;
    } catch (e) {
        log(`bootstrap: 内联配置 JSON 解析失败（回退文件形态）: ${getErrorMessage(e)}`);
        return undefined;
    }
}

/** accounts 数组按登录 uin 取协议段（文件/内联共用；未找到账号 / 无协议段 → 空段）。 */
function extractSections(accounts: unknown, uin?: string): SectionMap {
    const sections = emptySections();
    if (Array.isArray(accounts)) {
        const mine = accounts.find(
            (item): item is AccountLike => isRecord(item) && String(item["qq"]) === uin,
        );
        if (mine !== undefined) {
            // 表驱动：协议键单一来源，新增协议只改 PROTOCOL_KEYS 与具名投影。
            for (const key of PROTOCOL_KEYS) {
                sections[key] = sectionOf(mine, key) ?? {};
            }
        }
    }
    return sections;
}

/**
 * 按登录账号 uin 读取主配置的协议段（读取失败 / 未找到账号 / 无协议段 → 空段，
 * 不阻塞装配）。uin 为登录成功后实际账号（-q 指定账号与配置不一致时以 uin 为准）。
 */
export function loadProtocolSections(kernel: KernelLike, uin?: string): ProtocolSections {
    const inlineDoc = readInlineConfigDoc();
    if (inlineDoc !== undefined) {
        log("bootstrap: 配置来源: inline（NAPUKETTO_CONFIG_JSON）");
        return {
            cfgFile: INLINE_CONFIG_SENTINEL,
            ...sectionFields(extractSections(inlineDoc["accounts"], uin)),
        };
    }
    const cfgFile = env.NAPUKETTO_CONFIG || join(env.NAPUKETTO_CFG_DIR || ".", "napuketto.toml");
    let sections = emptySections();
    try {
        const raw = readFileSync(cfgFile, "utf8");
        const parsed = kernel.parseToml(raw);
        sections = extractSections(parsed["accounts"], uin);
    } catch (e) {
        log(`bootstrap: 全局配置读取失败（用默认 ob11/satori 配置）: ${getErrorMessage(e)}`);
    }
    return { cfgFile, ...sectionFields(sections) };
}
