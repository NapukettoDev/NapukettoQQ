/**
 * launcher：自建宿主引导——spawn 标准 node 跑 self-host.cjs。
 * win32 走 PE stub `QQNT.dll`，linux 走 `LD_PRELOAD` stub `.so`；Wine 路径已完全退役。
 */
import { type StdioOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import type { QqInstallInfo } from "../artifacts/locate.js";
import { packageRoot } from "../shared/package.js";
import { getErrorCode, getErrorMessage } from "../shared/type-guards.js";
import { ENV } from "./env-keys.js";
import {
    applyPathEnv,
    buildLaunchEnv,
    type LaunchLogOptions,
    windowsSandboxProfile,
} from "./launch-env.js";
import {
    defaultLinuxStubPath,
    linuxHomeEnv,
    linuxPreload,
    resolveGnutls,
    resolveLinuxHome,
    resolveLinuxNode,
} from "./linux-native.js";
import { resolveHostNodePath } from "./win-node.js";

export { ENV } from "./env-keys.js";
export type { LaunchLogOptions } from "./launch-env.js";

export interface LaunchOptions {
    /** QQ 安装信息（qqPath/version/wrapperPath）。 */
    qq: QqInstallInfo;
    /** kernel 入口（.mjs，self-host.cjs 里 import）。 */
    kernelEntry: string;
    /** 配置目录（账号数据目录，NAPUKETTO_CFG_DIR）。 */
    cfgDir: string;
    /** 全局配置文件路径（项目根 napuketto.toml，注入 NAPUKETTO_CONFIG 供装配链读取）。 */
    configPath?: string;
    /** adapter 入口（.mjs，协议装配用）。 */
    adapterEntry?: string;
    /** network 入口（.mjs，协议装配用）。 */
    networkEntry?: string;
    /** 自建宿主：标准 node + stub QQNT.dll 直接引导，不拉起 QQ。 */
    selfHost?: boolean;
    /** stub QQNT.dll 目录（PATH 前置，转发 napi_*、uv_* 符号到 node.exe）。 */
    stubDir?: string;
    /** Linux 原生 stub `.so` 路径（缺省 native/prebuilt/linux-x64/libnapuketto_stub.so）。 */
    linuxStubPath?: string;
    /** 强制指定快速登录账号（注入 NAPUKETTO_QUICK_UIN；cli `-q <uin>` 透传）。 */
    quickUin?: string;
    /** 强制扫码登录（注入 NAPUKETTO_QR_ONLY；跳过快速登录直接 QR，koishi 面板「扫码登录」用）。 */
    qrOnly?: boolean;
    /**
     * IPC 诊断动作（`diag.*`）开关：true = 显式启用（仅本地调试），false = 强制关闭，
     * undefined = 沿用父进程 `NAPUKETTO_DIAG`。默认关闭。
     */
    diagnostics?: boolean;
    /** 子进程日志配置（可选公开契约；映射到 NAPUKETTO_LOG_*，值不写日志）。 */
    log?: LaunchLogOptions;
    /** IPC 子进程模式（=1：stdout 走 JSON 行协议 + stdin 收 action/control，koishi 插件驱动）。 */
    ipc?: boolean;
    /**
     * 入站图片自动下载补丁（私有 native/ stub 组件）开关。
     * true（缺省）/ undefined = 启用并注入状态文件路径；false = 注入
     * NAPUKETTO_DISABLE_MEDIA_PATCH=1 killswitch（stub 跳过全部内存操作）。
     */
    nativeMediaPatch?: boolean;
    /** 自建宿主入口（默认 dist/host/self-host.cjs）。 */
    selfHostEntry?: string;
    /** Windows 版 node.exe 路径（win32 非 node 宿主时显式指定；缺省系统 PATH 探测/自动下载）。 */
    winNodePath?: string;
    /**
     * 子进程工作目录（缺省继承父进程 cwd）。
     *
     * ⚠️ 必须指向数据根（~/.napuketto）：QQ 原生层在账号上下文就绪前会
     * fallback 到进程 cwd 落盘（如频道库 guild1.db），不指定则污染调用方
     * 目录（实测写入项目根，GPro 模块初始化早于账号上下文）。cli 传 dataRoot 根治。
     */
    cwd?: string;
    /**
     * 子进程 stdio（默认 "inherit"）。cli 传 ["inherit","pipe","pipe"] 并接管
     * 子进程 stdout/stderr：逐行过滤 wrapper 原生噪音（MMKV 刷屏、Node 符号
     * 查找失败警告），其余转发——原生 printf 直写 fd 的字节无法从 JS 层拦截。
     */
    stdio?: StdioOptions;
    /**
     * 追加注入子进程的环境变量（在继承白名单之后合并；同键以本对象的强类型字段为准）。
     * cli 用：传播有效控制台渲染决策（NAPUKETTO_LOG_FORMAT/COLORIZE——子进程
     * stdout 恒为 pipe，TTY 判定失真）与数据根（NAPUKETTO_DATA_ROOT，停止哨兵用）。
     */
    extraEnv?: Record<string, string>;
    /**
     * 阶段回调（stub 校验 / node 解析下载 / spawn 提示）——首次下载 313MB 安装包与解析宿主 node
     * 全程静默会让用户以为没生效。调用方接 logger.info。
     */
    onStage?: (message: string) => void;
}

export interface LaunchResult {
    /** 子进程句柄（自建宿主 node 进程）。 */
    child: ReturnType<typeof spawn>;
    /** 自建宿主入口路径（self-host.cjs）。 */
    bootJsPath: string;
}

/**
 * 启动自建宿主（路线 A）：spawn node 直接跑 self-host.cjs，不拉起 QQ / 不注入。
 *
 * ⚠️ Windows 版 `wrapper.node` 从 QQNT.dll 导入 99 符号（napi_*×40 + uv_*×56 + qq_magic×1 +
 * v8/node mangled×2）——标准 node 没有这些宿主符号，必须 PATH 前置 stub QQNT.dll 目录（转发到
 * node.exe）+ QQ resources\app（wrapper.node 同目录依赖 DLL）才能 dlopen 成功。Linux 版
 * `wrapper.node` 是 ELF，宿主符号由官方 node 的全局符号表直接解析，stub `.so` 只补 3 个缺失符号。
 */
export async function launchSelfHost(options: LaunchOptions): Promise<LaunchResult> {
    const selfHostPath =
        options.selfHostEntry ?? join(packageRoot(), "dist", "host", "self-host.cjs");
    if (!existsSync(selfHostPath)) {
        throw new Error(
            `self-host.cjs 缺失: ${selfHostPath}（先运行 pnpm --filter @napuketto/loader build）`,
        );
    }

    // Linux：原生 ELF 宿主（ADR-027 起唯一分支，Wine 分支代码已删除）。
    if (process.platform === "linux") {
        return { child: launchLinuxNative(options, selfHostPath), bootJsPath: selfHostPath };
    }

    // stub QQNT.dll 校验（自建宿主必需：PATH 前置 stub 转发 napi_* 到 node.exe，
    // 否则 wrapper.node dlopen 失败）。默认 loader 包内闭源 submodule
    // native/prebuilt/win32-x64，缺失时提示 --stub-dir / NAPUKETTO_STUB_DIR 指定。
    const stub = options.stubDir ?? defaultStubDir();
    if (!existsSync(join(stub, "QQNT.dll"))) {
        throw new Error(
            `stub QQNT.dll 未找到: ${stub}（自建宿主必需：stub 转发 QQNT.dll 符号到 node.exe；` +
                "请用 --stub-dir 或环境变量 NAPUKETTO_STUB_DIR 指定 stub 目录）",
        );
    }
    options.onStage?.(`stub QQNT.dll 就绪：${stub}`);

    // 平台分支：win32 解析宿主 node（非 node 宿主如 Bun 需真 node.exe）
    const hostNode = await resolveHostNodePath(options);

    // 账号数据目录（实例锁 / boot 日志 / 配置兜底）在 spawn 前存在
    mkdirSync(resolve(options.cfgDir), { recursive: true });
    const env = buildLaunchEnv(options, "win32");
    Object.assign(env, windowsSandboxProfile(process.env, "win32"));
    applyPathEnv(env, { stub, wrapperPath: options.qq.wrapperPath }, "win32");
    if (options.diagnostics === true) {
        options.onStage?.("诊断动作已启用（仅本地调试；diag.* 按方法 allowlist 执行）");
    }

    // 标准 node 直接跑入口（不拉起 QQ，不注入）
    // cwd 显式指向数据根（cli 传入）：QQ 原生层 fallback 落盘（guild1.db 等）
    // 不再污染项目根目录（GPro 模块初始化早于账号上下文）。
    if (options.cwd !== undefined) {
        mkdirSync(options.cwd, { recursive: true });
    }
    const command = hostNode ?? process.execPath;
    const args = [selfHostPath];
    options.onStage?.(`启动自建宿主子进程：${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
        // exactOptionalPropertyTypes：未传 cwd 时不显式写入 undefined（继承父进程）
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env,
        stdio: options.stdio ?? "inherit",
        windowsHide: false,
    });

    // ⚠️ spawn error 兜底（生产事故实证）：子进程命令不存在时 Node 异步 emit 'error'
    // （ENOENT），无监听者 = EventEmitter 默认 throw → uncaughtException →
    // 整个宿主进程（koishi）崩溃。预检已覆盖常见场景，
    // 这里防漏网并输出可读信息，绝不让宿主进程崩掉。
    child.once("error", (err) => {
        const code = getErrorCode(err);
        const message =
            code === "ENOENT"
                ? `无法启动子进程（命令不存在）: ${command}`
                : `子进程启动失败: ${getErrorMessage(err)}`;
        // 防崩溃兜底输出（driver 侧另有 error 监听转 onError 友好流程）
        process.stderr.write(`[napuketto-loader] ${message}\n`);
    });

    return { child, bootJsPath: selfHostPath };
}

/**
 * Linux 原生 ELF 分支（ADR-027 起 Linux 唯一路径）：标准 node + 最小 stub `.so` +
 * 系统 libgnutls 预加载。不需要 PATH 前置（ELF 全局符号表直接解析），也不下载
 * 任何 Windows 产物。
 */
function launchLinuxNative(options: LaunchOptions, selfHostPath: string): ReturnType<typeof spawn> {
    const stub =
        options.linuxStubPath ?? process.env["NAPUKETTO_LINUX_STUB"] ?? defaultLinuxStubPath();
    if (!existsSync(stub)) {
        throw new Error(
            `Linux stub 未找到: ${stub}（应随 @napuketto/loader 的 native/prebuilt/linux-x64/ 发布；` +
                "可用 --stub-dir 之外的 NAPUKETTO_LINUX_STUB 指定）",
        );
    }
    const gnutls = resolveGnutls();
    if (gnutls === null) {
        throw new Error(
            "未找到系统 libgnutls.so.30（libbugly 的隐藏依赖，缺失会报 undefined symbol: gnutls_free）；" +
                "Ubuntu 24.04 请安装 libgnutls30t64，Debian 12 安装 libgnutls30",
        );
    }
    const node = resolveLinuxNode();
    if (node === null) {
        throw new Error(
            "Linux 原生宿主需要可执行的 node（当前宿主不是 node，且 PATH 中找不到 node）",
        );
    }
    const env = buildLaunchEnv(options, "linux");
    env["LD_PRELOAD"] = linuxPreload(stub, gnutls);
    env[ENV.STUB_DIR] = stub;
    if (options.diagnostics === true) {
        options.onStage?.("诊断动作已启用（仅本地调试；diag.* 按方法 allowlist 执行）");
    }
    mkdirSync(resolve(options.cfgDir), { recursive: true });
    // HOME/XDG 收敛：Bugly 的崩溃处理器只认 $HOME，改它才能把
    // `.config/QQ/crash_files/` 收进数据根（strace 实测）。
    const home = resolveLinuxHome({
        dataRoot: options.cwd,
        cfgDir: options.cfgDir,
        explicit: process.env["NAPUKETTO_LINUX_HOME"],
    });
    mkdirSync(home, { recursive: true });
    Object.assign(env, linuxHomeEnv(home));
    if (options.cwd !== undefined) {
        mkdirSync(options.cwd, { recursive: true });
    }
    options.onStage?.(
        `Linux 原生宿主：${node} self-host.cjs（stub=${stub}，gnutls=${gnutls}，HOME=${home}）`,
    );
    const child = spawn(node, [selfHostPath], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env,
        stdio: options.stdio ?? "inherit",
        windowsHide: false,
    });
    child.once("error", (err) => {
        process.stderr.write(`[napuketto-loader] Linux 原生宿主启动失败: ${err.message}\n`);
    });
    return child;
}

/**
 * 默认 stub QQNT.dll 目录（loader 包内闭源 native/prebuilt/win32-x64）。
 * src 与 native 同层，构建后 dist 与 native 同层——`../native` 恒正确。
 */
export function defaultStubDir(): string {
    return join(packageRoot(), "native", "prebuilt", "win32-x64");
}
