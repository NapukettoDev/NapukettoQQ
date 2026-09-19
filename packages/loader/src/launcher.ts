/**
 * launcher：自建宿主引导（2026-08-07 唯一路线）——spawn 标准 node 跑 self-host.cjs。
 *
 * 历史（V1/路线 B 事实链，已归档 archive/）：
 *  1. wrapper.node 只能在 QQ 定制版 Electron 里注册（实测纯 Node/普通 Electron 均 self-register 失败）
 *  2. QQ 是打包应用，禁 NODE_OPTIONS（实测 stderr）
 *  → 旧方案：NapukettoBootMain.exe 启动 QQ + 注入 NapukettoWinBootHook.dll（已废弃）
 *  → 现方案：stub QQNT.dll 转发宿主符号 → 标准 node 直接 dlopen wrapper.node（自建宿主）
 *
 * P2（2026-08-12）：平台分支——win32 本机 node；linux 经 wine 跑 Windows 版 node.exe
 * （ensureWinNode 下载）。所有传给 wine 子进程的路径过 toWinePath（Z:\）。
 */
import { type StdioOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { QqInstallInfo } from "./locate-qq.js";
import { ensureWinNode } from "./win-node.js";
import {
    buildSpawnCommand,
    isLinux,
    toWinePath,
    unixPathToWinePath,
    wineBinary,
    wineCheckError,
    wineInstallHint,
} from "./wine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LaunchOptions {
    /** QQ 安装信息（qqPath/version/wrapperPath）。 */
    qq: QqInstallInfo;
    /** kernel 入口（.mjs，self-host.cjs 里 import）。 */
    kernelEntry: string;
    /** 配置目录（账号数据目录，NAPUTO_CFG_DIR）。 */
    cfgDir: string;
    /** 全局配置文件路径（项目根 napuketto.toml，注入 NAPKETTO_CONFIG 供装配链读取）。 */
    configPath?: string;
    /** adapter 入口（.mjs，协议装配用）。 */
    adapterEntry?: string;
    /** network 入口（.mjs，协议装配用）。 */
    networkEntry?: string;
    /** 自建宿主：标准 node + stub QQNT.dll 直接引导，不拉起 QQ（2026-08-07 唯一路线）。 */
    selfHost?: boolean;
    /** stub QQNT.dll 目录（PATH 前置，转发 napi_*、uv_* 符号到 node.exe）。 */
    stubDir?: string;
    /** 强制指定快速登录账号（注入 NAPUTO_QUICK_UIN；cli `-q <uin>` 透传，2026-08-07）。 */
    quickUin?: string;
    /** 强制扫码登录（注入 NAPUTO_QR_ONLY；跳过快速登录直接 QR，koishi 面板「扫码登录」用）。 */
    qrOnly?: boolean;
    /** IPC 子进程模式（=1：stdout 走 JSON 行协议 + stdin 收 action/control，koishi 插件驱动）。 */
    ipc?: boolean;
    /** 自建宿主入口（默认 dist/host/self-host.cjs）。 */
    selfHostEntry?: string;
    /** Windows 版 node.exe 路径（linux 下载覆盖 / win32 非 node 宿主时显式指定；缺省自动解析）。 */
    winNodePath?: string;
    /**
     * 子进程工作目录（缺省继承父进程 cwd）。
     *
     * ⚠️ 必须指向数据根（~/.napuketto）：QQ 原生层在账号上下文就绪前会
     * fallback 到进程 cwd 落盘（如频道库 guild1.db），不指定则污染调用方
     * 目录（实测写入项目根，guild1.db 08-07）。cli 传 dataRoot 根治。
     */
    cwd?: string;
    /**
     * 子进程 stdio（默认 "inherit"）。cli 传 ["inherit","pipe","pipe"] 并接管
     * 子进程 stdout/stderr：逐行过滤 wrapper 原生噪音（MMKV 刷屏、Node 符号
     * 查找失败警告），其余转发——原生 printf 直写 fd 的字节无法从 JS 层拦截。
     */
    stdio?: StdioOptions;
    /**
     * 阶段回调（stub 校验/win-node 下载/spawn 提示，2026-08-23 起——下载
     * 313MB 安装包与 win-node 全程静默的坑）。调用方接 logger.info。
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
 * 启动自建宿主（路线 A）：spawn 标准 node 直接跑 self-host.cjs，不拉起 QQ / 不注入。
 *
 * 关键（HANDOVER-V7 技术数据）：wrapper.node 从 QQNT.dll 导入 99 符号
 * （napi_*×40 + uv_*×56 + qq_magic×1 + v8/node mangled×2）——标准 node 无这些宿主
 * 符号，必须 PATH 前置 stub QQNT.dll 目录（转发到 node.exe）+ QQ resources\app
 * （wrapper.node 同目录依赖 DLL）才能 dlopen 成功。
 *
 * P2 平台分支：win32 用本机 node；linux 用 wine + Windows 版 node.exe
 * （ensureWinNode 自动下载，路径过 toWinePath）。async（win-node 可能需下载）。
 */
export async function launchSelfHost(options: LaunchOptions): Promise<LaunchResult> {
    const selfHostPath =
        options.selfHostEntry ?? join(__dirname, "..", "dist", "host", "self-host.cjs");
    if (!existsSync(selfHostPath)) {
        throw new Error(
            `self-host.cjs 缺失: ${selfHostPath}（先运行 pnpm --filter @napuketto/loader build）`,
        );
    }

    // stub QQNT.dll 校验（自建宿主必需：PATH 前置 stub 转发 napi_* 到 node.exe，
    // 否则 wrapper.node dlopen 失败）。默认 loader 包内闭源 submodule native/stub-test-env，
    // 缺失时提示 --stub-dir / NAPUTO_STUB_DIR 指定。
    const stub = options.stubDir ?? defaultStubDir();
    if (!existsSync(join(stub, "QQNT.dll"))) {
        throw new Error(
            `stub QQNT.dll 未找到: ${stub}（自建宿主必需：stub 转发 QQNT.dll 符号到 node.exe；` +
                "请用 --stub-dir 或环境变量 NAPUTO_STUB_DIR 指定 stub 目录）",
        );
    }
    options.onStage?.(`stub QQNT.dll 就绪：${stub}`);

    // 平台分支：win32 本机 node；linux wine + win-node（下载）
    const { useWine, winNodePath } = await resolveNodeExecutable(options);

    const env = buildLaunchEnv(options, useWine);
    applyPathEnv(env, { stub, wrapperPath: options.qq.wrapperPath, useWine });

    // 标准 node 直接跑入口（不拉起 QQ，不注入）
    // cwd 显式指向数据根（cli 传入）：QQ 原生层 fallback 落盘（guild1.db 等）
    // 不再污染项目根目录（实测 08-07，GPro 模块初始化早于账号上下文）。
    if (options.cwd !== undefined) {
        mkdirSync(options.cwd, { recursive: true });
    }
    // spawn 命令：win32 = node.exe selfHostPath；linux = wine winNodePath selfHostPath
    // wine 场景 selfHostPath 也需转 Windows 路径（wine 内 node 读参数）
    // winNodePath：resolveNodeExecutable 解析出的宿主 node（wine 下载 / win32 非
    // node 宿主解析）；未解析（win32 标准 node 环境，execPath 即 node 自身）回退。
    const { command, args } = buildSpawnCommand({
        ...(winNodePath !== undefined ? { winNodePath } : { winNodePath: process.execPath }),
        selfHostPath: useWine ? toWinePath(selfHostPath) : selfHostPath,
        wine: wineBinary(),
    });
    options.onStage?.(`启动自建宿主子进程：${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
        // exactOptionalPropertyTypes：未传 cwd 时不显式写入 undefined（继承父进程）
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env,
        stdio: options.stdio ?? "inherit",
        windowsHide: false,
    });

    // ⚠️ spawn error 兜底（2026-08-23 WSL 生产事故）：wine 未安装时 Node 异步
    // emit 'error'（ENOENT），无监听者 = EventEmitter 默认 throw →
    // uncaughtException → 整个宿主进程（koishi）崩溃。预检（assertWineAvailable）
    // 已覆盖常见场景，这里防漏网并输出可读信息，绝不让宿主进程崩掉。
    child.once("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        const message =
            code === "ENOENT"
                ? `无法启动子进程（命令不存在）: ${command}\n${isLinux() ? wineInstallHint() : ""}`
                : `子进程启动失败: ${err.message}`;
        // 防崩溃兜底输出（driver 侧另有 error 监听转 onError 友好流程）
        process.stderr.write(`[napuketto-loader] ${message}\n`);
    });

    return { child, bootJsPath: selfHostPath };
}

/**
 * 平台分支解析 node 可执行：win32 本机（非 node 宿主时解析真 node）；linux wine +
 * Windows 版 node.exe（ensureWinNode 下载）。
 */
async function resolveNodeExecutable(options: LaunchOptions): Promise<{
    useWine: boolean;
    winNodePath: string | undefined;
}> {
    if (!isLinux()) {
        // win32：标准 node 宿主（execPath 即 node）直接用自身；非 node 宿主
        // （koishi CE 等 Bun 运行时，execPath=bun.exe）必须解析真 node——
        // wrapper.node 的符号由 stub QQNT.dll 绑定到 node.exe，bun.exe 进程内
        // 无此模块，LoadLibrary 报 1114「DLL 初始化例程失败」（2026-09-05 实测）。
        if (isNodeExecutable(process.execPath)) {
            return { useWine: false, winNodePath: undefined };
        }
        const hostNode = await resolveWinHostNode({
            ...(options.winNodePath !== undefined ? { explicitPath: options.winNodePath } : {}),
            ...(options.cwd !== undefined ? { dataRoot: options.cwd } : {}),
            ...(options.onStage !== undefined ? { onStage: options.onStage } : {}),
        });
        return { useWine: false, winNodePath: hostNode };
    }
    // ⚠️ wine 预检（2026-08-23 WSL 生产事故）：spawn 前确认 wine 可执行——
    // 干净 WSL 环境默认没有 wine，缺失时给出安装指引（throw 可读错误，由
    // 调用方 driver 捕获转 [W] 驱动错误），而不是 spawn 后异步 'error' 崩进程。
    const wine = wineBinary();
    const probe = spawnSync(wine, ["--version"], { stdio: "ignore" });
    const hint = wineCheckError(probe);
    if (hint !== null) {
        throw new Error(hint);
    }
    options.onStage?.("wine 就绪，获取 Windows 版 node.exe（Linux/wine 场景）…");
    const winNode = await ensureWinNode({
        ...(options.cwd !== undefined ? { dataRoot: options.cwd } : {}),
        ...(options.winNodePath !== undefined ? { exePath: options.winNodePath } : {}),
    });
    options.onStage?.(`Windows 版 node.exe 就绪：${winNode.exePath}（${winNode.version}）`);
    return { useWine: true, winNodePath: winNode.exePath };
}

/** 可执行文件名是否 node（win32 宿主判定；node.exe / node 两种形态）。 */
export function isNodeExecutable(execPath: string): boolean {
    // 反斜杠 Windows 路径先归一化：posix basename 不认 `\` 分隔符，整个字符串
    // 当文件名比对恒 false（CI ubuntu 门禁实测挂过）
    const name = basename(execPath.replaceAll("\\", "/")).toLowerCase();
    return name === "node.exe" || name === "node";
}

/** 系统 node 探测结果（win32，PATH 解析 + 可执行校验）。 */
export interface SystemNodeInfo {
    exePath: string;
    version: string;
}

/** 行拆分（where 输出 \r\n / \n 兼容）。 */
const LINE_SPLIT = /\r?\n/;

/** 探测系统 PATH 上的 node（win32；where node 首条 + --version 校验可执行）。 */
export function findSystemNode(): SystemNodeInfo | undefined {
    const probe = spawnSync("where", ["node"], {
        stdio: "pipe",
        encoding: "utf8",
        windowsHide: true,
    });
    if (probe.status !== 0 || !probe.stdout) {
        return undefined;
    }
    const first = probe.stdout
        .split(LINE_SPLIT)
        .map((line) => line.trim())
        .find((line) => line !== "");
    if (first === undefined || !existsSync(first)) {
        return undefined;
    }
    const ver = spawnSync(first, ["--version"], {
        stdio: "pipe",
        encoding: "utf8",
        windowsHide: true,
    });
    const version = ver.status === 0 ? ver.stdout.trim() : "";
    if (!version.startsWith("v")) {
        return undefined;
    }
    return { exePath: resolve(first), version };
}

/** resolveWinHostNode 测试注入面（探测/下载替换为假实现）。 */
export interface WinHostNodeResolvers {
    findSystemNode?: () => SystemNodeInfo | undefined;
    ensureWinNode?: typeof ensureWinNode;
}

/**
 * win32 非 node 宿主时解析真 node.exe：显式覆盖（winNodePath 参数 /
 * NAPUTO_WIN_NODE_PATH）> 系统 PATH node（离线可用，免下载）> ensureWinNode
 * 下载（缓存幂等）。显式路径不存在时静默跳过（与 ensureWinNode 行为一致）。
 */
export async function resolveWinHostNode(
    options: {
        explicitPath?: string;
        dataRoot?: string;
        onStage?: (message: string) => void;
    },
    resolvers: WinHostNodeResolvers = {},
): Promise<string | undefined> {
    const findSystem = resolvers.findSystemNode ?? findSystemNode;
    const ensure = resolvers.ensureWinNode ?? ensureWinNode;

    const explicit = options.explicitPath ?? process.env["NAPUTO_WIN_NODE_PATH"];
    if (explicit !== undefined && explicit !== "" && existsSync(explicit)) {
        const exePath = resolve(explicit);
        options.onStage?.(`使用显式指定 node：${exePath}`);
        return exePath;
    }

    options.onStage?.(
        `当前宿主非 node（${basename(process.execPath)}），解析 Windows 版 node.exe…`,
    );

    const sys = findSystem();
    if (sys !== undefined) {
        options.onStage?.(`系统 node ${sys.version}：${sys.exePath}`);
        return sys.exePath;
    }

    const winNode = await ensure({
        ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    });
    options.onStage?.(`Windows 版 node.exe 就绪：${winNode.exePath}（${winNode.version}）`);
    return winNode.exePath;
}

/** 注入 PATH（stub 目录 + wrapper.node 目录前置）与 STUB_DIR（wine 场景转 Z:\）。 */
function applyPathEnv(
    env: Record<string, string>,
    opts: { stub: string; wrapperPath: string; useWine: boolean },
): void {
    const p = (linuxPath: string): string => (opts.useWine ? toWinePath(linuxPath) : linuxPath);
    // ⚠️ wine 场景 PATH 必须纯 Windows 风格（全部 Z:\ 条目 + 分号分隔）：混入
    // Unix PATH（冒号分隔）会让 wine 按错误分隔符拆分，盘符路径（Z:\...）被拆散，
    // stub 目录丢失 → wrapper.node 依赖的 QQNT.dll 找不到（2026-08-14 生产实测
    // "import_dll Library QQNT.dll not found"）。Unix PATH 逐条转 Z:\ 再并入。
    const unixPath = process.env["PATH"] ?? "";
    const winPath = opts.useWine ? unixPathToWinePath(unixPath) : unixPath;
    const pathEntries = [p(opts.stub), p(dirname(opts.wrapperPath)), winPath]
        .filter((entry) => entry !== undefined && entry !== "")
        .join(";");
    env["PATH"] = pathEntries;
    env[ENV.STUB_DIR] = p(opts.stub);
}

/**
 * 默认 stub QQNT.dll 目录（loader 包内闭源 native/build/stub-test-env，开发机默认）。
 * src 与 native 同层，构建后 dist 与 native 同层——`../native` 恒正确。
 */
export function defaultStubDir(): string {
    return join(__dirname, "..", "native", "build", "stub-test-env");
}

/** 装配自建宿主环境变量（wine 场景路径转 Z:\；win32 原样）。 */
function buildLaunchEnv(options: LaunchOptions, useWine: boolean): Record<string, string> {
    // 配置目录兜底
    const cfg = resolve(options.cfgDir);
    mkdirSync(cfg, { recursive: true });

    // wine 场景：传给子进程的路径全转 Z:\（node.exe 在 wine 内按 Windows 路径读）
    const p = (linuxPath: string): string => (useWine ? toWinePath(linuxPath) : linuxPath);
    const env: Record<string, string> = {
        ...process.env,
        [ENV.QQ_PATH]: p(options.qq.qqPath),
        [ENV.KERNEL_ENTRY]: p(resolve(options.kernelEntry)),
        [ENV.CFG_DIR]: p(cfg),
        [ENV.QQ_VERSION]: options.qq.version,
        [ENV.WRAPPER_PATH]: p(options.qq.wrapperPath),
    };
    // 可选注入（对象展开，保持低复杂度）
    const optional: Record<string, string> = {
        ...(options.selfHost === true ? { [ENV.SELF_HOST]: "1" } : {}),
        ...(options.adapterEntry !== undefined
            ? { [ENV.ADAPTER_ENTRY]: p(resolve(options.adapterEntry)) }
            : {}),
        ...(options.networkEntry !== undefined
            ? { [ENV.NETWORK_ENTRY]: p(resolve(options.networkEntry)) }
            : {}),
        ...(options.configPath !== undefined
            ? { [ENV.CONFIG_PATH]: p(resolve(options.configPath)) }
            : {}),
        ...(options.quickUin !== undefined ? { [ENV.QUICK_UIN]: options.quickUin } : {}),
        ...(options.qrOnly === true ? { [ENV.QR_ONLY]: "1" } : {}),
        ...(options.ipc === true ? { [ENV.IPC]: "1" } : {}),
    };
    return { ...env, ...optional };
}

/** 环境变量名（self-host.cjs 与 kernel 引导读取）。 */
export const ENV = {
    QQ_PATH: "NAPUTO_QQ_PATH",
    KERNEL_ENTRY: "NAPUTO_KERNEL_ENTRY",
    CFG_DIR: "NAPUTO_CFG_DIR",
    QQ_VERSION: "NAPUTO_QQ_VERSION",
    WRAPPER_PATH: "NAPUTO_WRAPPER_PATH",
    /** 自建宿主：标准 node + stub QQNT.dll 引导（self-host.cjs 分支）。 */
    SELF_HOST: "NAPUTO_SELF_HOST",
    /** stub QQNT.dll 目录（launchSelfHost 注入，self-host.cjs 诊断用）。 */
    STUB_DIR: "NAPUTO_STUB_DIR",
    /** adapter 包入口（协议装配用）。 */
    ADAPTER_ENTRY: "NAPUTO_ADAPTER_ENTRY",
    /** network 包入口（协议装配用）。 */
    NETWORK_ENTRY: "NAPUTO_NETWORK_ENTRY",
    /** 全局配置文件路径（项目根 napuketto.toml，boot-protocols 读取）。 */
    CONFIG_PATH: "NAPKETTO_CONFIG",
    /** 强制指定快速登录账号（cli `-q <uin>` 透传，bootstrap 登录用）。 */
    QUICK_UIN: "NAPUTO_QUICK_UIN",
    /** 强制扫码登录（跳过快速登录直接 QR；koishi 面板「扫码登录」重启路径用）。 */
    QR_ONLY: "NAPUTO_QR_ONLY",
    /** IPC 子进程模式（koishi 插件驱动：stdout JSON 行 + stdin action/control）。 */
    IPC: "NAPUTO_IPC",
} as const;
