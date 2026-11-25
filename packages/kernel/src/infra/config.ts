/**
 * 配置基类（ADR-012）：读文件 → 校验 → 内存对象 → 变更写回；文本格式按扩展名推断
 * （.toml → smol-toml，其余 → JSON）。kernel 不依赖 zod，只依赖校验器的最小 `parse` 形状
 * （`ConfigSchema`），协议包的 zod schema 天然满足；协议配置 schema 在各自协议包。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import process from "node:process";
import { parse as parseTomlText, stringify as stringifyTomlText } from "smol-toml";
import { configError } from "./errors.js";
import { getErrorCode, isRecord } from "./type-guards.js";

/** 配置文本格式。 */
export type ConfigFormat = "json" | "toml";

/**
 * 配置落盘权限（POSIX 0o600：仅属主可读写）。配置可能含协议鉴权 token，
 * 不得按默认 umask（常见 0o644）暴露给同机其他用户；Windows 以 ACL 为准，
 * 忽略 mode 位。
 */
export const CONFIG_FILE_MODE = 0o600;

/** 按扩展名推断格式（.toml → toml，其余 → json）。 */
function inferFormat(path: string): ConfigFormat {
    if (extname(path).toLowerCase() === ".toml") {
        return "toml";
    }
    return "json";
}

function isMissingFileError(err: unknown): boolean {
    if (err instanceof Error) {
        return getErrorCode(err) === "ENOENT";
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
 * - `save()`：调用时取得校验后的快照，原子替换成功后更新内存。
 * - 同实例 load/save 按调用顺序串行；跨实例/进程仅隔离临时文件，不合并更新。
 */
export class ConfigBase<T> {
    readonly path: string;
    readonly defaults: T;

    private readonly schema: ConfigSchema<T>;
    private readonly format: ConfigFormat;
    private readonly seed: T | undefined;
    private value: T;
    private pending: Promise<void> = Promise.resolve();

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
        return this.enqueue(() => this.loadValue());
    }

    private async loadValue(): Promise<T> {
        if (this.seed !== undefined) {
            this.value = this.seed;
            return this.value;
        }
        let raw: string;
        try {
            raw = await readFile(this.path, "utf8");
        } catch (err) {
            if (isMissingFileError(err)) {
                const parsed = this.parse(this.serialize(this.defaults));
                await this.commit(parsed, `${this.serialize(parsed)}\n`);
                return this.value;
            }
            throw configError(`读取配置文件失败: ${this.path}`, { cause: err });
        }
        this.value = this.parse(raw);
        return this.value;
    }

    /**
     * 校验纯文本配置（反序列化 + schema 校验，不读写文件；`config validate`
     * 等只读场景用）。错误包装与 load()/save() 完全一致（ConfigError，
     * 文案含 this.path），保证 validate 与运行时校验逐字一致。
     */
    parseText(raw: string): T {
        return this.parse(raw);
    }

    /** 调用时校验并取得快照，按同实例调用顺序落盘，成功后更新内存。 */
    async save(next: T): Promise<void> {
        const parsed = this.parse(this.serialize(next));
        const text = `${this.serialize(parsed)}\n`;
        await this.enqueue(() => this.commit(parsed, text));
    }

    private enqueue<R>(operation: () => Promise<R>): Promise<R> {
        const result = this.pending.then(operation);
        // 仅队列尾部吸收拒绝以继续后续操作；原始 result 把错误交还调用方。
        this.pending = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async commit(parsed: T, text: string): Promise<void> {
        mkdirSync(dirname(this.path), { recursive: true });
        const tmpPath = `${this.path}.${randomUUID()}.tmp`;
        // 独占创建成功后才拥有该临时文件，创建失败时不得清理他人的文件。
        const file = await open(tmpPath, "wx", CONFIG_FILE_MODE);
        try {
            try {
                if (process.platform !== "win32") {
                    // 创建 mode 受 umask 限制，写入凭据前显式确定为 0o600。
                    await file.chmod(CONFIG_FILE_MODE);
                }
                await file.writeFile(text, "utf8");
            } finally {
                await file.close();
            }
            await rename(tmpPath, this.path);
            this.value = parsed;
        } finally {
            // rename 成功则源文件已不存在；失败则移除本次提交的中间态。
            await rm(tmpPath, { force: true });
        }
    }

    /** 对象 → 文本（TOML/JSON）。 */
    private serialize(value: T): string {
        if (this.format === "toml") {
            if (!isRecord(value)) {
                throw configError(`TOML 配置根必须是对象: ${this.path}`);
            }
            return stringifyTomlText(value);
        }
        return JSON.stringify(value, null, 4);
    }

    /** 文本 → 对象（TOML/JSON）。 */
    private deserialize(raw: string): unknown {
        if (this.format === "toml") {
            return parseTomlText(raw);
        }
        const parsed: unknown = JSON.parse(raw);
        return parsed;
    }

    /** 反序列化 + schema 校验，错误统一包装为 ConfigError（配置未就绪一族）。 */
    private parse(raw: string): T {
        let input: unknown;
        try {
            input = this.deserialize(raw);
        } catch (err) {
            throw configError(`配置文件 ${this.format.toUpperCase()} 解析失败: ${this.path}`, {
                cause: err,
            });
        }
        try {
            return this.schema.parse(input);
        } catch (err) {
            throw configError(`配置文件校验失败: ${this.path}`, { cause: err });
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
