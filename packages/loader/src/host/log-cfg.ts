/**
 * loader 引导链日志配置解析（2026-10-25 日志可配置化；2026-10-25 内联配置接入）。
 *
 * 自建宿主进程（self-host → bootstrap → NapukettoCore / kernel-services）不经过
 * cli 的 loadCliConfig，这里按同一契约解析：主配置 [log] 段经 kernel.parseLogConfig
 * （env 覆盖在内）解析。主配置来源优先级与 loadProtocolSections 一致：
 * NAPKETTO_CONFIG_JSON（内联，不读盘）> NAPKETTO_CONFIG > NAPUTO_CFG_DIR 兜底。
 * kernel 无该导出（老版本）或配置读取失败时回退缺省——日志配置损坏不阻塞引导。
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
                env.NAPKETTO_CONFIG || join(env.NAPUTO_CFG_DIR || ".", "napuketto.toml");
            section = kernel.parseToml(readFileSync(cfgFile, "utf8"))["log"];
        }
        return kernel.parseLogConfig(section, process.env);
    } catch {
        return defaultLogConfig();
    }
}

/** [log.file] 相对路径展开基准（数据根：NAPUTO_DATA_ROOT > NAPKETTO_DATA > CFG_DIR 父目录）。 */
function logFileBaseDir(): string {
    if (env.NAPUTO_DATA_ROOT !== undefined && env.NAPUTO_DATA_ROOT !== "") {
        return env.NAPUTO_DATA_ROOT;
    }
    if (env.NAPKETTO_DATA !== undefined && env.NAPKETTO_DATA !== "") {
        return env.NAPKETTO_DATA;
    }
    // CFG_DIR = <数据根>/<账号>；未注入数据根时退到账号目录自身（相对路径少见场景）
    return env.NAPUTO_CFG_DIR !== undefined && env.NAPUTO_CFG_DIR !== ""
        ? join(env.NAPUTO_CFG_DIR, "..")
        : ".";
}

/** [log.file] path → 绝对路径。 */
export function resolveLogFilePath(path: string): string {
    return isAbsolute(path) ? path : join(logFileBaseDir(), path);
}
