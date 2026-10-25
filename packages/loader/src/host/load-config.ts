/**
 * 协议配置段读取（从 protocols.ts 拆分，2026-08-08 FTA 优化；2026-08-08 结构拍板：按账号取段）
 *
 * 主配置来源（2026-10-25 嵌入式内联契约）：**NAPKETTO_CONFIG_JSON（内联 JSON，
 * 与 napuketto.toml 同构）> NAPKETTO_CONFIG（文件）> NAPUTO_CFG_DIR 兜底（旧行为
 * 兼容）**。内联生效时不读任何 toml 文件，cfgFile 返回哨兵 "<inline>"（仅作
 * ProtocolConfig 来源标注；seed 模式本就不读盘，协议段热更新在内联形态不可用）。
 *
 * 全局配置：**协议配置嵌在账号内**——accounts 数组每项含 [onebot11] / [satori] /
 * [kurobot] 段，登录成功后按账号 uin 找到对应项，取其段作 seed（zod 校验）。
 * （ConfigBase seed 模式：load() 直接用内存值，不再读写独立协议文件）
 *
 * 内联分支宽松（解析失败回退文件形态并记日志，不阻塞引导）：cli 主路径已在
 * 拉起前完整校验（exit 78），走到这里的坏内联多见于绕过 cli 的直跑场景。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.js";
import type { KernelLike } from "./types.js";
import { errMsg, log } from "./util.js";

/** 协议配置段（账号内 [onebot11] / [satori] / [kurobot]，宽松对象，装配时 zod 校验）。 */
export interface ProtocolSections {
    cfgFile: string;
    ob11Section: Record<string, unknown>;
    satoriSection: Record<string, unknown>;
    kurobotSection: Record<string, unknown>;
}

/** 内联来源时 cfgFile 的哨兵值（非文件路径；日志/错误标注里不出现真实路径）。 */
const INLINE_CONFIG_SENTINEL = "<inline>";

/** 宽松账号项（TOML [[accounts]] 元素 / JSON accounts 元素）。 */
interface AccountLike {
    qq?: unknown;
    onebot11?: unknown;
    satori?: unknown;
    kurobot?: unknown;
}

/** 账号内取协议段（宽松对象，装配时 zod 校验）。 */
function sectionOf(
    account: AccountLike,
    key: "onebot11" | "satori" | "kurobot",
): Record<string, unknown> | undefined {
    const section = account[key];
    if (section !== undefined && section !== null && typeof section === "object") {
        return section as Record<string, unknown>;
    }
    return undefined;
}

/**
 * 读内联配置文档（NAPKETTO_CONFIG_JSON 非空才生效；JSON 解析失败 / 非对象 →
 * undefined 回退文件形态并记日志）。
 */
export function readInlineConfigDoc(): Record<string, unknown> | undefined {
    const raw = env.NAPKETTO_CONFIG_JSON;
    if (raw === undefined || raw.trim() === "") {
        return undefined;
    }
    try {
        const doc: unknown = JSON.parse(raw);
        if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
            return doc as Record<string, unknown>;
        }
        log("bootstrap: 内联配置不是 JSON 对象（回退文件形态）");
        return undefined;
    } catch (e) {
        log(`bootstrap: 内联配置 JSON 解析失败（回退文件形态）: ${errMsg(e)}`);
        return undefined;
    }
}

/** accounts 数组按登录 uin 取协议段（文件/内联共用；未找到账号 / 无协议段 → 空段）。 */
function extractSections(
    accounts: unknown,
    uin?: string,
): Pick<ProtocolSections, "ob11Section" | "satoriSection" | "kurobotSection"> {
    let ob11Section: Record<string, unknown> = {};
    let satoriSection: Record<string, unknown> = {};
    let kurobotSection: Record<string, unknown> = {};
    if (Array.isArray(accounts)) {
        const mine = accounts.find(
            (item): item is AccountLike =>
                typeof item === "object" &&
                item !== null &&
                String((item as AccountLike)["qq"]) === uin,
        );
        if (mine !== undefined) {
            ob11Section = sectionOf(mine, "onebot11") ?? {};
            satoriSection = sectionOf(mine, "satori") ?? {};
            kurobotSection = sectionOf(mine, "kurobot") ?? {};
        }
    }
    return { ob11Section, satoriSection, kurobotSection };
}

/**
 * 按登录账号 uin 读取主配置的协议段（读取失败 / 未找到账号 / 无协议段 → 空段，
 * 不阻塞装配）。uin 为登录成功后实际账号（-q 指定账号与配置不一致时以 uin 为准）。
 */
export function loadProtocolSections(kernel: KernelLike, uin?: string): ProtocolSections {
    const inlineDoc = readInlineConfigDoc();
    if (inlineDoc !== undefined) {
        log("bootstrap: 配置来源: inline（NAPKETTO_CONFIG_JSON）");
        return { cfgFile: INLINE_CONFIG_SENTINEL, ...extractSections(inlineDoc["accounts"], uin) };
    }
    const cfgFile = env.NAPKETTO_CONFIG || join(env.NAPUTO_CFG_DIR || ".", "napuketto.toml");
    let sections: Pick<ProtocolSections, "ob11Section" | "satoriSection" | "kurobotSection"> = {
        ob11Section: {},
        satoriSection: {},
        kurobotSection: {},
    };
    try {
        const raw = readFileSync(cfgFile, "utf8");
        const parsed = kernel.parseToml(raw);
        sections = extractSections(parsed["accounts"], uin);
    } catch (e) {
        log(`bootstrap: 全局配置读取失败（用默认 ob11/satori 配置）: ${errMsg(e)}`);
    }
    return { cfgFile, ...sections };
}
