/**
 * cli boot：单账号启动序列（2026-08-07 用户拍板：只保留自建宿主）
 *
 * resolveQqFiles（多级来源定位 QQ 原生文件）→ 解析各包 dist 入口 → launchSelfHost
 * （标准 node + stub QQNT.dll 直接 dlopen，不拉起 QQ / 不注入）→ 常驻。
 *
 * QQ 原生文件来源（本机未装 QQ 也能跑，2026-08-16 接入）：
 *   L0 NAPUTO_QQ_FILES 显式文件根 → L1 本机 QQ 安装（--qq-path / NAPUTO_QQ_PATH /
 *      注册表 / 常见路径）→ L2 数据根缓存 <数据根>/qq-files/<版本> → 全部缺失时
 *      自动下载官方安装包（sha256 校验 + 7z 解包 + 提取缓存，幂等）。
 * cached 来源下 qq.qqPath 为语义占位（缓存目录无 QQ.exe）——launchSelfHost 只消费
 * qq.wrapperPath / qq.version（NAPUTO_QQ_PATH 仅注入、self-host 未读取），占位安全。
 *
 * 不写业务逻辑：kernel 装配 + 登录 + 协议装配全部在 self-host.cjs → boot-bootstrap.js 完成。
 * 路线 B（拉起 QQ + 注入）已淘汰（launchQqWithLoader 已移除，cli 只走自建宿主）。
 */
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveConfigPath, resolveDataRoot } from "@napuketto/kernel";
import {
    checkInstanceLock,
    defaultStubDir,
    isNativeNoiseLine,
    launchSelfHost,
    type QqInstallInfo,
    resolveQqFiles,
} from "@napuketto/loader";
import QRCode from "qrcode";
import { logger } from "./logger.js";
import { writeAccountRuntime } from "./runtime-state.js";

/** 单账号启动选项。 */
export interface BootOptions {
    /** QQ 号（数据目录账号隔离，ADR-016）。 */
    qq?: string;
    /** 数据根目录（缺省环境变量/用户目录）。 */
    dataDir?: string;
    /** 覆盖 QQ 安装路径（联调）。 */
    qqPath?: string;
    /** stub QQNT.dll 目录（缺省 loader 包内闭源 submodule native/stub-test-env）。 */
    stubDir?: string;
}

/** 解析 workspace 包的 dist 入口（ESM 解析：包是 ESM-only，exports 无 require 条件）。 */
async function packageEntry(pkg: string): Promise<string> {
    const url = await import.meta.resolve(pkg);
    return fileURLToPath(url);
}

/** QR 透出标记行前缀（loader bootstrap-core 非 IPC 模式输出，cli 解析终端渲染）。 */
const QR_LINE_PREFIX = "NAPUTO_QR ";

/**
 * 逐行转发子进程输出到父进程，过滤原生噪音。
 * readline 按 UTF-8 解码 pipe 字节流，再经 process.stdout（TTY 路径，
 * WriteConsoleW UTF-16）输出——顺带修复 pino 中文在 cmd.exe/管道 936 转码
 * 链路下的乱码（原生 printf 字节流无法从 JS 侧改编码，转 pipe 后统一解码）。
 *
 * NAPUTO_QR 标记行（loader bootstrap-core 输出，QR 登录二维码数据）不转发，
 * 解析后用 qrcode 包渲染终端二维码；png 落盘与 URL 提示由 kernel 日志完成。
 * 噪音判定走 loader 共享单一来源（isNativeNoiseLine，与 koishi IPC 路径同源）。
 */
function forwardFiltered(input: NodeJS.ReadableStream, out: NodeJS.WritableStream): void {
    const lines = createInterface({ input });
    lines.on("line", (line) => {
        if (line.startsWith(QR_LINE_PREFIX)) {
            renderTerminalQr(line.slice(QR_LINE_PREFIX.length));
            return;
        }
        if (isNativeNoiseLine(line)) {
            return;
        }
        out.write(`${line}\n`);
    });
}

/**
 * 渲染终端二维码（qrcode 包 terminal 模式，half-block 字符）。
 * 解析失败/无 url 时静默丢弃——标记行是内部协议，坏行不影响登录。
 */
function renderTerminalQr(raw: string): void {
    try {
        const data = JSON.parse(raw) as { qrcodeUrl?: string };
        const { qrcodeUrl } = data;
        if (qrcodeUrl === undefined || qrcodeUrl === "") {
            return;
        }
        void QRCode.toString(qrcodeUrl, { type: "terminal", small: true })
            .then((str) => {
                process.stdout.write(`${str}\n`);
            })
            .catch(() => {
                // 渲染失败静默（不影响登录，kernel 日志的 URL/png 路径仍可用）
            });
    } catch {
        // 坏行静默丢弃
    }
}

/** 启动单个账号（自建宿主 + 常驻）。 */
export async function runSingleAccount(opts: BootOptions = {}): Promise<void> {
    const dataRoot = resolveDataRoot(opts.dataDir);
    // QQ 原生文件多级来源 + 自动下载（本机未装 QQ 时走下载管线；下载失败给可操作提示）
    let qq: QqInstallInfo;
    try {
        qq = await resolveQqFiles({
            dataRoot,
            ...(opts.qqPath !== undefined ? { qqPath: opts.qqPath } : {}),
        });
    } catch (err) {
        logger.error(
            { err },
            `定位/下载 QQ 原生文件失败：${err instanceof Error ? err.message : String(err)}\n` +
                "（本机未装 QQ 时自动下载官方安装包；若下载失败请检查网络，或手动安装 QQ、" +
                "设置 NAPUTO_QQ_PATH 指定已有安装、NAPUTO_QQ_FILES 指定文件根、" +
                "NAPUTO_QQ_URL 覆盖下载地址）",
        );
        process.exitCode = 1;
        return;
    }
    const cfgDir = path.join(dataRoot, opts.qq ?? "default");

    // 单实例锁预检（2026-08-07 根治「多实例抢数据目录锁挂起」）：同一账号数据
    // 目录只允许一个实例（QQ 原生层 MMKV/登录单例有锁，第二个实例抢不到锁会卡死）。
    // 占用 → 快速失败并提示占用 PID；残留（PID 已死 / PID 被复用，2026-09-10
    // cmdline 校验根治）→ self-host 会自动接管。真正的锁由 self-host 子进程
    // 获取/释放（它才是数据目录的实际持有者），cli 这里只做 spawn 前预检，
    // 给用户友好提示（supervisor 等批量拉起同用）。
    const { occupied, pid: holderPid } = checkInstanceLock(cfgDir);
    if (occupied) {
        logger.error(
            { pid: holderPid, dataDir: cfgDir },
            "数据目录已被其他实例占用，拒绝启动（同一账号数据目录仅允许一个实例；" +
                "占用校验已含 pid 复用检测，如仍误报请删除该目录下的 instance.lock）",
        );
        process.exitCode = 1;
        return;
    }

    const kernelEntry = await packageEntry("@napuketto/kernel");
    const adapterEntry = await packageEntry("@napuketto/adapter");
    const networkEntry = await packageEntry("@napuketto/network");

    const stubDir = opts.stubDir ?? process.env["NAPUTO_STUB_DIR"] ?? defaultStubDir();

    // 启动信息走结构化日志（时间戳 + 级别 + pid + 元数据，与 kernel 子进程格式一致）
    logger.info({ qqVersion: qq.version, qqPath: qq.qqPath, source: qq.source }, "QQ 文件来源");
    logger.info({ dataDir: cfgDir }, "数据目录");
    logger.info("自建宿主引导（标准 node + stub QQNT.dll）");

    // 唯一启动路径：自建宿主（2026-08-07 用户拍板，路线 B 淘汰）
    // stdio 接管 stdout/stderr：过滤 MMKV / 符号查找失败等原生噪音，其余转发
    // configPath：全局配置文件（项目根 napuketto.toml），注入 NAPKETTO_CONFIG 供装配链读取
    // ⚠️ P2（2026-08-12）：launchSelfHost 变 async（linux 场景需下载 win-node）
    const { child } = await launchSelfHost({
        qq,
        kernelEntry,
        adapterEntry,
        networkEntry,
        cfgDir,
        // 子进程 cwd 指向数据根：QQ 原生层 fallback 落盘（guild1.db 等）
        // 落在专门的数据目录，不污染项目根（实测 08-07）。
        cwd: dataRoot,
        configPath: resolveConfigPath({ dataRoot }),
        selfHost: true,
        stdio: ["inherit", "pipe", "pipe"],
        ...(opts.qq !== undefined ? { quickUin: opts.qq } : {}),
        ...(stubDir !== undefined ? { stubDir } : {}),
    });

    if (child.stdout !== null) {
        forwardFiltered(child.stdout, process.stdout);
    }
    if (child.stderr !== null) {
        forwardFiltered(child.stderr, process.stderr);
    }

    // 单账号运行时状态落盘（napuketto status/stop 消费，2026-09-08 T8；
    // pid 记 boot 进程——树杀连带 self-host 孙进程）
    writeAccountRuntime(dataRoot, {
        uin: opts.qq ?? "default",
        pid: process.pid,
        ...(child.pid !== undefined ? { selfHostPid: child.pid } : {}),
        startedAt: new Date().toISOString(),
        kind: "single-boot",
        status: "running",
    });

    // 常驻：等待自建宿主进程退出
    await new Promise<void>((resolve) => {
        child.on("exit", (code) => {
            logger.info({ code }, "自建宿主进程退出");
            writeAccountRuntime(dataRoot, {
                uin: opts.qq ?? "default",
                pid: process.pid,
                ...(child.pid !== undefined ? { selfHostPid: child.pid } : {}),
                startedAt: new Date().toISOString(),
                kind: "single-boot",
                status: "exited",
                exitCode: code,
            });
            resolve();
        });
        child.on("error", (err) => {
            logger.error({ err }, "自建宿主进程启动失败");
            resolve();
        });
    });
}
