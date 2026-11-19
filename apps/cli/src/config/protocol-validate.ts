/**
 * 协议段严格校验（`config validate` / `config apply` 共用）。
 *
 * 主配置解析（schema.ts）刻意保持协议段为宽松对象：普通启动路径不把协议包
 * 拉进 CLI 进程，字段级校验由 loader 装配时用各协议自己的 zod schema 完成。
 * 但 `config validate` 的承诺是「与运行时同一校验器落地」——只做 `isRecord`
 * 浅校验会让 `httpServers = "not-an-array"` 报「配置合法」，真正启动却以 78
 * 退出；`config apply` 若跳过这层，则会把非法协议段写进主配置。因此两条路径
 * 懒加载 adapter 补校验（普通 CLI 启动与 supervisor 不引入协议包）。
 *
 * 空段与 loader 装配语义一致：`{}` = 不启用该协议，跳过校验（kurobot 的
 * url 必填只在段非空时生效）。
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

/** 单账号协议段校验（空段跳过；zod 错误压成单行，归 ConfigError 78 一族）。 */
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
