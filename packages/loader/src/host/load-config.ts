/**
 * 协议配置段读取（从 protocols.ts 拆分，2026-08-08 FTA 优化；2026-08-08 结构拍板：按账号取段）
 *
 * 全局 TOML 配置（<项目根>/napuketto.toml）：**协议配置嵌在账号内**——
 * accounts 数组每项含 [onebot11] / [satori] 段，登录成功后按账号 uin 找到对应项，
 * 取其段作 seed（zod 校验）。路径优先级：NAPKETTO_CONFIG（launcher 注入）>
 * 装配链自身探测（kernel.resolveConfigPath）> NAPUTO_CFG_DIR 兜底（旧行为兼容）。
 * （ConfigBase seed 模式：load() 直接用内存值，不再读写独立协议文件）
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

/** 宽松账号项（TOML [[accounts]] 元素）。 */
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
 * 按登录账号 uin 读取全局 TOML 的协议段（读取失败 / 未找到账号 / 无协议段 → 空段，
 * 不阻塞装配）。uin 为登录成功后实际账号（-q 指定账号与配置不一致时以 uin 为准）。
 */
export function loadProtocolSections(kernel: KernelLike, uin?: string): ProtocolSections {
    const cfgFile = env.NAPKETTO_CONFIG || join(env.NAPUTO_CFG_DIR || ".", "napuketto.toml");
    let ob11Section: Record<string, unknown> = {};
    let satoriSection: Record<string, unknown> = {};
    let kurobotSection: Record<string, unknown> = {};
    try {
        const raw = readFileSync(cfgFile, "utf8");
        const parsed = kernel.parseToml(raw);
        const accounts = parsed["accounts"];
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
    } catch (e) {
        log(`bootstrap: 全局配置读取失败（用默认 ob11/satori 配置）: ${errMsg(e)}`);
    }
    return { cfgFile, ob11Section, satoriSection, kurobotSection };
}
