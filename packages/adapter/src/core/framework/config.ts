/**
 * 协议配置加载基类：复用 kernel ConfigBase（zod schema 天然满足其校验器接口）。
 */
import type { ConfigFormat } from "@napuketto/kernel";
import { ConfigBase } from "@napuketto/kernel";
import type { ZodType } from "zod";

/** 协议配置基类：zod schema + 文本读写（JSON/TOML，文件路径由装配层传入）。 */
export class ProtocolConfig<T> extends ConfigBase<T> {
    constructor(opts: {
        path: string;
        schema: ZodType<T>;
        defaults: T;
        /** 内存初值（全局 TOML 分段装配：seed 存在时 load() 直接用它）。 */
        seed?: T;
        format?: ConfigFormat;
    }) {
        super({
            path: opts.path,
            schema: opts.schema,
            defaults: opts.defaults,
            seed: opts.seed,
            format: opts.format,
        });
    }
}
