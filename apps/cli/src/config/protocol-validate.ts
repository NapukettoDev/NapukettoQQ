/**
 * 协议段严格校验（`config validate` / `config apply` 共用）：schema 刻意保持协议段为宽松对象——普通启动
 * 不把协议包拉进 CLI 进程，字段级校验由 loader 装配时用各协议自己的 zod schema 完成；但 validate 承诺
 * 「与运行时同一校验器落地」：只做浅校验会让 httpServers 非法时误报合法、启动却 78；故懒加载 adapter 补校验。
 */
import { configError, errorMessage } from "@napuketto/kernel";
import type { CliAccountConfig, CliConfig } from "./schema.js";

/** 校验器最小面（与 kernel ConfigSchema 同形；不把 zod 类型引入 cli）。 */
interface ProtocolSchema {
    parse(input: unknown): unknown;
}

const PROTOCOL_KEYS = ["onebot11", "satori", "kurobot", "milky"] as const;
type ProtocolKey = (typeof PROTOCOL_KEYS)[number];
type ProtocolSchemas = Record<ProtocolKey, ProtocolSchema>;

/** 懒加载四个协议的 zod schema（adapter 根入口已导出）。 */
async function loadProtocolSchemas(): Promise<ProtocolSchemas> {
    const { kurobotConfigSchema, milkyConfigSchema, ob11ConfigSchema, satoriConfigSchema } =
        await import("@napuketto/adapter");
    return {
        onebot11: ob11ConfigSchema,
        satori: satoriConfigSchema,
        kurobot: kurobotConfigSchema,
        milky: milkyConfigSchema,
    };
}

/**
 * 单账号协议段校验（空段 `{}` = 不启用，与 loader 装配语义一致而跳过——kurobot 的 url
 * 必填只在段非空时生效；zod 错误压成单行，归 ConfigError 78 一族）。
 */
function validateAccountSections(account: CliAccountConfig, schemas: ProtocolSchemas): void {
    for (const key of PROTOCOL_KEYS) {
        const section = account[key];
        if (section === undefined || Object.keys(section).length === 0) {
            continue;
        }
        try {
            schemas[key].parse(section);
        } catch (err) {
            const detail = errorMessage(err).replace(/\s+/g, " ").trim();
            throw configError(`账号 ${account.qq} 的 ${key} 段校验失败: ${detail}`, { cause: err });
        }
    }
}

/** 校验配置中全部账号的协议段（与 loader 装配同 schema、同空段语义）。 */
export async function validateProtocolSections(config: CliConfig): Promise<void> {
    const schemas = await loadProtocolSchemas();
    for (const account of config.accounts) {
        validateAccountSections(account, schemas);
    }
}
