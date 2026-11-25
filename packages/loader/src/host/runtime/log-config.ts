/**
 * loader 引导链日志配置解析：自建宿主不经过 cli 的 loadCliConfig，这里按同一契约用 kernel.parseLogConfig 解析主配置 [log] 段。
 * 主配置来源 NAPUKETTO_CONFIG_JSON（内联，不读盘）> NAPUKETTO_CONFIG > NAPUKETTO_CFG_DIR 兜底；kernel 缺导出或读取失败回退缺省。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { env } from "./env.js";
import { readInlineConfigDoc } from "./load-config.js";
import type { KernelLike, LogConfigLike } from "./types.js";

/** 缺省（kernel parseLogConfig 缺省值的最小面镜像；未配置/解析失败兜底）。 */
export function defaultLogConfig(): LogConfigLike {
    return {
        level: "info",
        banner: true,
        timestamp: "local",
        unboundReceive: true,
        levels: {},
    };
}

/** 解析引导链日志配置（内联 > toml 文件的 [log] 段 + env 覆盖；失败回退缺省）。 */
export function resolveLoaderLogConfig(kernel: KernelLike): LogConfigLike {
    if (typeof kernel.parseLogConfig !== "function") {
        return defaultLogConfig();
    }
    try {
        const inlineDoc = readInlineConfigDoc();
        let section: unknown;
        if (inlineDoc !== undefined) {
            section = inlineDoc["log"];
        } else {
            const cfgFile =
                env.NAPUKETTO_CONFIG || join(env.NAPUKETTO_CFG_DIR || ".", "napuketto.toml");
            section = kernel.parseToml(readFileSync(cfgFile, "utf8"))["log"];
        }
        return kernel.parseLogConfig(section, process.env);
    } catch {
        return defaultLogConfig();
    }
}

/** [log.file] 相对路径展开基准（数据根：NAPUKETTO_DATA_ROOT > NAPUKETTO_DATA > CFG_DIR 父目录）。 */
function logFileBaseDir(): string {
    if (env.NAPUKETTO_DATA_ROOT !== undefined && env.NAPUKETTO_DATA_ROOT !== "") {
        return env.NAPUKETTO_DATA_ROOT;
    }
    if (env.NAPUKETTO_DATA !== undefined && env.NAPUKETTO_DATA !== "") {
        return env.NAPUKETTO_DATA;
    }
    // CFG_DIR = <数据根>/<账号>；未注入数据根时退到账号目录自身（相对路径少见场景）
    return env.NAPUKETTO_CFG_DIR !== undefined && env.NAPUKETTO_CFG_DIR !== ""
        ? join(env.NAPUKETTO_CFG_DIR, "..")
        : ".";
}

/** [log.file] path → 绝对路径。 */
export function resolveLogFilePath(path: string): string {
    return isAbsolute(path) ? path : join(logFileBaseDir(), path);
}
