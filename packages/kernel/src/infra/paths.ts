/**
 * 数据目录布局（ADR-016，2026-08-08 修订：数据根默认放项目根）
 *
 * ```
 * <数据根>/<qq号>/             # 每账号独立目录（ADR-015 多账号前提）
 * ├── config/                  # 各账号独立配置（历史产物，协议段已走 seed）
 * ├── logs/                    # pino 文件日志
 * └── cache/                   # 临时文件、媒体缓存
 *
 * <项目根>/napuketto.toml      # 全局配置文件（放项目根目录，不入库）
 * <项目根>/.napuketto/         # 数据根（默认值，2026-08-08 用户拍板：直接放项目主目录）
 * ```
 *
 * 数据根优先级：cli `--data-dir`（显式参数）> `NAPKETTO_DATA` 环境变量 >
 * `<项目根>/.napuketto`（默认，部署原因不放用户目录）。
 * 配置文件路径见 `resolveConfigPath`（项目根探测，与数据根解耦）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configError } from "./errors.js";
import { isPathWithin, resolveExistingPath } from "./path-boundary.js";

/** 默认数据根目录名（项目根下，2026-08-08 用户拍板：不放用户目录）。 */
export const DEFAULT_DATA_ROOT_NAME = ".napuketto";

/** 全局配置文件名。 */
export const MAIN_CONFIG_FILE = "napuketto.toml";

/** Check an actual write destination when the development launcher has set a boundary. */
export function resolveSandboxWritePath(path: string, field: string): string {
    const sandbox = process.env["NAPUKETTO_SANDBOX_ROOT"];
    if (!sandbox) {
        return path;
    }
    const target = resolve(path);
    if (!isPathWithin(sandbox, target)) {
        throw configError(`${field} 必须位于调试沙箱内: ${target}`);
    }
    let realTarget: string;
    try {
        realTarget = resolveExistingPath(target);
    } catch (err) {
        throw configError(`无法解析沙箱内的 ${field}: ${target}`, { cause: err });
    }
    if (!isPathWithin(sandbox, realTarget)) {
        throw configError(`${field} 必须位于调试沙箱内: ${target}`);
    }
    return target;
}

export interface PathOptions {
    /** 显式数据根（cli `--data-dir` 传入，优先级最高）。 */
    dataRoot?: string | undefined;
    /** QQ 号，用于多账号隔离；缺省时直接使用数据根本身。 */
    account?: string | undefined;
}

/** `~` 前缀展开为用户主目录（跨平台配置文件写法 `dataDir = "~/.napuketto"`）。 */
function expandTilde(p: string): string {
    if (p === "~") {
        return homedir();
    }
    if (p.startsWith("~/") || p.startsWith("~\\")) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

/**
 * 项目根查找：入口模块向上找 `pnpm-workspace.yaml`（monorepo 开发场景，即仓库根）→
 * cwd 向上找 `pnpm-workspace.yaml` / `package.json`（发布后用户项目）→ undefined（兜底）。
 */
function resolveProjectRoot(): string | undefined {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const moduleRoot = findProjectRoot(moduleDir, "pnpm-workspace.yaml");
    if (moduleRoot !== undefined) {
        return moduleRoot;
    }
    return (
        findProjectRoot(process.cwd(), "pnpm-workspace.yaml") ??
        findProjectRoot(process.cwd(), "package.json")
    );
}

/**
 * 解析数据根：显式参数 > 环境变量 > `<项目根>/.napuketto`（默认）> 用户目录兜底（裸脚本）。
 * 支持 `~` 前缀（展开为用户主目录）与相对路径（相对 cwd 解析）。
 * 返回绝对路径。独立导出便于 cli / 探测脚本复用。
 */
export function resolveDataRoot(dataRoot?: string): string {
    const explicit = dataRoot ?? process.env["NAPUKETTO_DATA"] ?? process.env["NAPKETTO_DATA"];
    if (explicit !== undefined && explicit !== "") {
        return resolveSandboxWritePath(resolve(expandTilde(explicit)), "数据目录");
    }
    const sandbox = process.env["NAPUKETTO_SANDBOX_ROOT"];
    if (sandbox) {
        return resolveSandboxWritePath(join(sandbox, DEFAULT_DATA_ROOT_NAME), "数据目录");
    }
    const projectRoot = resolveProjectRoot();
    if (projectRoot !== undefined) {
        return join(projectRoot, DEFAULT_DATA_ROOT_NAME);
    }
    return join(homedir(), DEFAULT_DATA_ROOT_NAME);
}

/** 向上查找含标志文件的目录（项目根探测：monorepo 根 / 用户项目根）。 */
function findProjectRoot(startDir: string, marker: string): string | undefined {
    let dir = startDir;
    for (;;) {
        if (existsSync(join(dir, marker))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

export interface ConfigPathOptions {
    /** 兜底数据根（探测全部失败时用 `<dataRoot>/napuketto.toml`，保持旧行为）。 */
    dataRoot?: string | undefined;
}

/**
 * 全局配置文件路径解析（2026-08-07 用户拍板：**配置文件放项目根目录，
 * 数据仍按数据根组织**——数据根只承载账号目录/日志/缓存/QQ 数据）。
 *
 * 优先级：
 *  1. `NAPKETTO_CONFIG` 环境变量（显式指定完整路径，任意场景可用）
 *  2. 项目根探测（入口模块向上找 pnpm-workspace.yaml → cwd 向上找，见 resolveProjectRoot）
 *  3. 数据根兜底 `<dataRoot>/napuketto.toml`（旧行为兼容）
 *
 * 返回绝对路径。独立导出便于 cli / loader 装配链复用。
 */
export function resolveConfigPath(opts: ConfigPathOptions = {}): string {
    const explicit = process.env["NAPUKETTO_CONFIG"] ?? process.env["NAPKETTO_CONFIG"];
    if (explicit !== undefined && explicit !== "") {
        return resolveSandboxWritePath(resolve(explicit), "配置文件");
    }
    const sandbox = process.env["NAPUKETTO_SANDBOX_ROOT"];
    if (sandbox) {
        return resolveSandboxWritePath(join(sandbox, MAIN_CONFIG_FILE), "配置文件");
    }
    const projectRoot = resolveProjectRoot();
    if (projectRoot !== undefined) {
        return join(projectRoot, MAIN_CONFIG_FILE);
    }
    return join(opts.dataRoot ?? resolveDataRoot(), MAIN_CONFIG_FILE);
}

/**
 * 路径装配器：持有账号数据目录下的全部子目录。
 * 无全局单例（ADR-015 推论）——每账号每进程实例化一份。
 */
export class PathWrapper {
    /** 数据根（绝对路径）。 */
    readonly root: string;
    /** 账号数据目录（绝对路径），缺省 account 时等于 root。 */
    readonly accountDir: string;
    /** config 目录（napuketto.json + 各协议配置）。 */
    readonly configDir: string;
    /** logs 目录（pino 文件日志）。 */
    readonly logsDir: string;
    /** cache 目录（临时文件、媒体缓存）。 */
    readonly cacheDir: string;

    constructor(opts: PathOptions = {}) {
        const root = resolveDataRoot(opts.dataRoot);
        this.root = root;
        if (opts.account) {
            this.accountDir = join(root, opts.account);
        } else {
            this.accountDir = root;
        }
        this.configDir = join(this.accountDir, "config");
        this.logsDir = join(this.accountDir, "logs");
        this.cacheDir = join(this.accountDir, "cache");
    }

    /** 递归创建全部目录，启动装配时调用一次。 */
    ensure(): void {
        for (const dir of [this.configDir, this.logsDir, this.cacheDir]) {
            mkdirSync(dir, { recursive: true });
        }
    }

    /** 账号目录内的文件路径（如 `file('config', 'napuketto.json')`）。 */
    file(...segments: string[]): string {
        return join(this.accountDir, ...segments);
    }

    /**
     * 清空缓存目录（clean_cache 动作经注入回调消费）。
     * 只删除 cacheDir 下的条目，保留目录本身。
     */
    clearCache(): void {
        let entries: string[];
        try {
            entries = readdirSync(this.cacheDir);
        } catch {
            return; // 目录不存在视为空
        }
        for (const entry of entries) {
            rmSync(join(this.cacheDir, entry), { recursive: true, force: true });
        }
    }
}
