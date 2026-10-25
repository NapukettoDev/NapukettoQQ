/**
 * self-host.ts：自建宿主（路线 A，NAPUTO_SELF_HOST）入口——标准 Node 进程直接运行。
 * 2026-08-07 阶段 2：由 runtime/self-host.cjs TS 化（零语义改动）。
 * 由 loader launcher.launchSelfHost() spawn 标准 node 启动；环境变量继承。
 *
 * 背景（2026-08-07 HANDOVER-V6/V9 实测，勿重复探索）：
 *  - 纯 Node（系统 node）+ stub QQNT.dll 转发 + 9.9.33 官方 wrapper.node 可完整登录，
 *    且 session 业务 service 全部 READY（getMsgService 298 方法）。
 *  - 与路线 B（注入 QQ worker，继承 QQ env）不同：标准 node 没有 QQ 的环境与事件分发
 *    对象，必须手动完成三要素：
 *      ① 加载 = stub QQNT.dll 转发（napi_* → node.exe，PATH 前置 stub 目录，
 *         launcher.launchSelfHost 负责装配 PATH）
 *      ② `NodeIO3MiscService.get()` + `addO3MiscListener` 激活事件分发
 *         （否则 getLoginList 永不 resolve——挂起，V6 实测）
 *      ③ commonPath/desktopGlobalPath = 数据根/nt_qq/global（kernel 已按
 *         electronProcessType() !== "browser" 自动解析，见 wrapper-loader.ts）
 *
 * 职责（本文件只做自建宿主特有的引导前置，业务链路完全复用）：
 *  1. process.dlopen(wrapper.node) → exports（98 个，stub 提供宿主符号）
 *  2. O3MiscService 激活事件分发
 *  3. 构造 state（wrapperExports）→ 调 bootstrap(state)
 *     → kernel 装配 → 登录（快速/QR）→ session（先 init 后 start）→ 冒烟 → 协议装配
 */

import {
    acquireInstanceLock,
    checkInstanceLock,
    registerLockCleanup,
} from "../../instance-lock.js";
import { installSignalShutdown, requestShutdown, watchStopSentinel } from "../../shutdown.js";
import { env } from "../env.js";
import {
    enableIpc,
    lastIpcStatusPhase,
    sendStatus,
    shouldSendGenericBootFailed,
} from "../ipc/index.js";
import { createState, errMsg, log } from "../util.js";
import { bootstrap } from "./bootstrap.js";

const state = createState();

// 优雅关停接入（2026-10-25 生命周期契约）：
//  - 信号：SIGINT/SIGTERM/SIGBREAK（Windows CTRL_BREAK_EVENT 可达——嵌入式宿主
//    CREATE_NEW_PROCESS_GROUP + GenerateConsoleCtrlEvent 优雅停整树）
//  - 停止哨兵：<数据根>/napuketto.stop（宿主/脚本写文件即可，零 win32 依赖；
//    mtime 晚于进程启动才触发，账号内容匹配 basename(NAPUTO_CFG_DIR)）
//  - 编排：关停钩子（bootstrapWithCore 注册：适配器停止 → IPC 面 → 桥/缓存
//    退订）→ exit 0（0 = 请求式正常退出，与崩溃区分）
installSignalShutdown();
{
    const dataRoot = env.NAPUTO_DATA_ROOT;
    if (dataRoot !== undefined && dataRoot !== "") {
        const account =
            env.NAPUTO_CFG_DIR !== undefined && env.NAPUTO_CFG_DIR !== ""
                ? (env.NAPUTO_CFG_DIR.split(/[\\/]/).filter(Boolean).pop() ?? "default")
                : "default";
        watchStopSentinel({
            dataRoot,
            account,
            onTrigger: () => {
                void requestShutdown("停止哨兵");
            },
        });
    }
}

// IPC 子进程模式（NAPUTO_IPC=1，koishi 插件驱动）：stdout 专用于 JSON 行协议
const ipcMode = env.NAPUTO_IPC === "1";
if (ipcMode) {
    enableIpc();
    sendStatus("booting");
}

log(
    `[self-host] 启动 @ ${new Date().toISOString()} pid=${process.pid} node=${process.version} type=${(process as { type?: string }).type ?? "(标准 node)"}`,
);
log(`[self-host] stub 目录: ${env.NAPUTO_STUB_DIR ?? "(PATH 前置，未记录)"}`);

// unhandledRejection 兜底（2026-08-22 崩溃防御）：一次失败的 Promise 不应拖垮
// 整个子进程（实测：sendMsg 确认事件 reject 未被消费 → Node 默认抛错退出，连带
// IPC 通道关闭、Koishi 侧全部动作失败）。记录日志但不退出——业务错误仍由调用方
// 显式处理（不静默吞掉），此处只防「漏网」的进程级崩溃。
process.on("unhandledRejection", (reason: unknown) => {
    log(`[self-host] ⚠️ unhandledRejection: ${errMsg(reason)}`);
});

// 0. 单实例锁兜底（2026-08-07 根治）：数据目录粒度锁——同一账号数据目录
//    只允许一个实例（QQ 原生层 MMKV/登录单例有锁，第二个实例抢不到会挂起）。
//    cli 已做启动前检测，此处防 supervisor/直接跑 self-host 绕过 cli 的路径。
//    NAPUTO_CFG_DIR 即账号数据目录（launcher 注入）。
const lockDataDir = env.NAPUTO_CFG_DIR;
if (lockDataDir) {
    if (!acquireInstanceLock(lockDataDir)) {
        const { pid: holderPid } = checkInstanceLock(lockDataDir);
        log(
            `[self-host] ❌ 数据目录已被其他实例占用（pid=${holderPid ?? "?"}），退出；` +
                "同一账号数据目录仅允许一个实例，请先停止已有实例",
        );
        if (ipcMode) {
            sendStatus("failed", "数据目录被占用", {
                code: "INVALID_STATE",
                message: `数据目录已被其他实例占用（pid=${holderPid ?? "?"}）`,
            });
        }
        process.exit(1);
    }
    registerLockCleanup(lockDataDir);
    log(`[self-host] ✅ 已获取数据目录锁（${lockDataDir}）`);
} else {
    log("[self-host] ⚠️ NAPUTO_CFG_DIR 未设置，跳过单实例锁");
}

const wrapperPath = env.NAPUTO_WRAPPER_PATH;
if (!wrapperPath) {
    log("[self-host] NAPUTO_WRAPPER_PATH 未设置，退出");
    if (ipcMode) {
        sendStatus("failed", "NAPUTO_WRAPPER_PATH 未设置", {
            code: "INVALID_STATE",
            message: "NAPUTO_WRAPPER_PATH 未设置，退出",
        });
    }
    process.exit(1);
}

// 1. dlopen wrapper.node（stub QQNT.dll 转发 napi_*/uv_* → node.exe，标准 node 可注册）
log(`[self-host] dlopen wrapper.node: ${wrapperPath}`);
if (ipcMode) {
    sendStatus("dlopening");
}
try {
    // { exports: {} } 是 process.dlopen 的最小载体（wrapper 向其中填充 NAPI exports）
    const m: { exports: Record<string, unknown> } = { exports: {} };
    process.dlopen(m as object, wrapperPath);
    const keys = Object.keys(m.exports ?? {});
    log(`[self-host] ✅ dlopen 成功，exports ${keys.length} 个`);
    if (!keys.includes("NodeIKernelLoginService")) {
        log("[self-host] ❌ exports 无 NodeIKernelLoginService（stub 环境异常？）");
        if (ipcMode) {
            sendStatus("failed", "exports 无 NodeIKernelLoginService", {
                code: "INVALID_STATE",
                message: "exports 无 NodeIKernelLoginService（stub 环境异常？）",
            });
        }
        process.exit(1);
    }
    state.wrapperExports = m.exports;
} catch (e) {
    log(`[self-host] ❌ dlopen 失败: ${errMsg(e)}`);
    if (ipcMode) {
        sendStatus("failed", "dlopen 失败", { code: "UNKNOWN", message: errMsg(e) });
    }
    process.exit(1);
}

// 2. 🔑 O3MiscService 激活事件分发（自建宿主三要素之二，V6 实测决定性）：
//    不激活则 getLoginList 永不 resolve（挂起）。listener 用普通 JS 对象
//    （getOnAmgomDataPiece 空实现，wrapper 契约回调）。
try {
    const O3 = state.wrapperExports?.["NodeIO3MiscService"] as
        | { get?(): { addO3MiscListener(listener: unknown): void } }
        | undefined;
    if (O3 && typeof O3.get === "function") {
        O3.get().addO3MiscListener({
            getOnAmgomDataPiece() {
                // 空实现：wrapper 契约回调，仅需注册存在即可激活事件分发
            },
        });
        log("[self-host] ✅ O3MiscService 激活事件分发");
    } else {
        log("[self-host] ⚠️ NodeIO3MiscService 缺失（版本变化？继续尝试）");
    }
} catch (e) {
    log(`[self-host] ⚠️ O3MiscService 激活失败: ${errMsg(e)}`);
}

// 3. kernel 引导（bootstrap.ts 完全复用——登录/initAndStartSession/冒烟/协议装配）
log("[self-host] 调 bootstrap(state) ...");
// void：显式忽略 IIFE promise（内部已 try/catch 兜底，不会 reject）
void (async () => {
    try {
        const ok = await bootstrap(state);
        if (!ok) {
            // 引导未完成（登录失败/服务装配失败/生命周期异常——bootstrap 内部
            // 不抛错，具体原因见 NAPUTO_CFG_DIR 下 napuketto-boot.log）。
            // 已发过更具体的 failed（如 NOT_LOGIN）则不覆盖，否则补发通用
            // failed；随后退出，由 koishi driver 既有重启循环接管（cli 模式
            // 同样退出——失败留驻只会以假 ready 干扰父进程判断，2026-09-06）。
            if (shouldSendGenericBootFailed(ipcMode, lastIpcStatusPhase())) {
                sendStatus("failed", "bootstrap 未完成", {
                    code: "UNKNOWN",
                    message: "bootstrap 未完成，详见 napuketto-boot.log",
                });
            }
            process.exit(1);
        }
        log("[self-host] bootstrap 完成");
        if (ipcMode) {
            sendStatus("ready");
        }
        // 常驻：协议服务在事件循环上；不 process.exit（业务运行中）
    } catch (e) {
        log(`[self-host] bootstrap 失败: ${errMsg(e)}`);
        if (ipcMode) {
            sendStatus("failed", "bootstrap 失败", { code: "UNKNOWN", message: errMsg(e) });
        }
        process.exit(1);
    }
})();
