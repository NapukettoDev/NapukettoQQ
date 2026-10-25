/**
 * 配置基类（ADR-012）
 *
 * 读文件 → 校验 → 内存对象 → 变更写回。支持 **JSON / TOML** 两种文本格式
 * （按扩展名推断：.toml → TOML（smol-toml），其余 → JSON）。
 *
 * kernel 不依赖 zod：只依赖校验器的最小 `parse` 形状（`ConfigSchema`），
 * 协议包的 zod schema 天然满足；kernel 主配置用手写校验器包装。
 * 协议配置 schema 在各自协议包，见各包 docs/design.md。
 */
import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { parse as parseTomlText, stringify as stringifyTomlText } from "smol-toml";
import { ConfigError } from "./errors.js";

/** 配置文本格式。 */
export type ConfigFormat = "json" | "toml";

/** 按扩展名推断格式（.toml → toml，其余 → json）。 */
function inferFormat(path: string): ConfigFormat {
    if (extname(path).toLowerCase() === ".toml") {
        return "toml";
    }
    return "json";
}

function isMissingFileError(err: unknown): boolean {
    if (err instanceof Error) {
        return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
    return false;
}

/**
 * 校验器最小接口。zod 的 `ZodType<T>`（`parse(data: unknown): T`）天然满足；
 * 手写校验器包装成该形状即可。
 */
export interface ConfigSchema<T> {
    parse: (input: unknown) => T;
}

export interface ConfigOptions<T> {
    /** 配置文件绝对路径。 */
    path: string;
    /** 校验器（协议 schema 用 zod；kernel 主配置用手写校验器包装）。 */
    schema: ConfigSchema<T>;
    /** 默认值：文件缺失时生成并落盘；校验以它为兜底。 */
    defaults: T;
    /** 内存初值（已校验对象）：load() 时直接使用，跳过文件读写（全局 TOML 分段的装配方式）。 */
    seed?: T | undefined;
    /** 文本格式（缺省按扩展名推断）。 */
    format?: ConfigFormat | undefined;
}

/**
 * 配置基类。每次 `load()` / `save()` 都经过 schema 校验，
 * 校验失败抛 `KernelError('INVALID_PARAM')`，不静默吞掉。
 * - `load()`：seed 存在 → 直接用 seed；否则读文件（缺失落默认值）。
 * - `save()`：按格式序列化（TOML/JSON）原子写。
 */
export class ConfigBase<T> {
    readonly path: string;
    readonly defaults: T;

    private readonly schema: ConfigSchema<T>;
    private readonly format: ConfigFormat;
    private readonly seed: T | undefined;
    private value: T;

    constructor(opts: ConfigOptions<T>) {
        this.path = opts.path;
        this.defaults = opts.defaults;
        this.schema = opts.schema;
        this.format = opts.format ?? inferFormat(opts.path);
        this.seed = opts.seed;
        this.value = opts.seed ?? opts.defaults;
    }

    /** 当前内存值（只读消费；外部不得直接修改返回对象）。 */
    get(): T {
        return this.value;
    }

    /**
     * 加载配置：
     * - seed 存在 → 直接用 seed（已校验，不读文件；全局 TOML 分段装配方式）；
     * - 文件缺失 → 写入默认值并落盘（首次运行自动生成），返回默认值；
     * - 文件存在 → 读取 + 校验，更新内存，返回。
     */
    async load(): Promise<T> {
        if (this.seed !== undefined) {
            this.value = this.seed;
            return this.value;
        }
        let raw: string;
        try {
            raw = await readFile(this.path, "utf8");
        } catch (err) {
            if (isMissingFileError(err)) {
                await this.save(this.defaults);
                return this.value;
            }
            throw new ConfigError(`读取配置文件失败: ${this.path}`, { cause: err });
        }
        this.value = this.parse(raw);
        return this.value;
    }

    /** 重新从磁盘加载（外部变更后的热更新入口，P2 配置热更新使用）。 */
    reload(): Promise<T> {
        return this.load();
    }

    /**
     * 校验纯文本配置（反序列化 + schema 校验，不读写文件；`config validate`
     * 等只读场景用）。错误包装与 load()/save() 完全一致（ConfigError，
     * 文案含 this.path），保证 validate 与运行时校验逐字一致。
     */
    parseText(raw: string): T {
        return this.parse(raw);
    }

    /** 校验并落盘（原子写：临时文件 + rename），随后更新内存。 */
    async save(next: T): Promise<void> {
        const parsed = this.parse(this.serialize(next));
        mkdirSync(dirname(this.path), { recursive: true });
        const tmpPath = `${this.path}.tmp`;
        await writeFile(tmpPath, `${this.serialize(parsed)}\n`, "utf8");
        await rename(tmpPath, this.path);
        this.value = parsed;
    }

    /** 对象 → 文本（TOML/JSON）。 */
    private serialize(value: T): string {
        if (this.format === "toml") {
            return stringifyTomlText(value as Record<string, unknown>);
        }
        return JSON.stringify(value, null, 4);
    }

    /** 文本 → 对象（TOML/JSON）。 */
    private deserialize(raw: string): unknown {
        if (this.format === "toml") {
            return parseTomlText(raw);
        }
        return JSON.parse(raw) as unknown;
    }

    /** 反序列化 + schema 校验，错误统一包装为 ConfigError（配置未就绪一族）。 */
    private parse(raw: string): T {
        let input: unknown;
        try {
            input = this.deserialize(raw);
        } catch (err) {
            throw new ConfigError(`配置文件 ${this.format.toUpperCase()} 解析失败: ${this.path}`, {
                cause: err,
            });
        }
        try {
            return this.schema.parse(input);
        } catch (err) {
            throw new ConfigError(`配置文件校验失败: ${this.path}`, { cause: err });
        }
    }
}

/** 解析 TOML 文本 → 对象（boot.cjs / 探测脚本等无 ConfigBase 场景复用）。 */
export function parseToml(text: string): Record<string, unknown> {
    return parseTomlText(text);
}

/** 对象 → TOML 文本（config init 生成全局配置文件等场景）。 */
export function stringifyToml(value: Record<string, unknown>): string {
    return stringifyTomlText(value);
}
