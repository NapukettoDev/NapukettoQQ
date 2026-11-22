/** 标准 Node 自建宿主入口。加载与激活原生模块由 kernel 负责。 */
import {
    acquireInstanceLock,
    checkInstanceLock,
    registerLockCleanup,
} from "../../lifecycle/instance-lock.js";
import {
    installSignalShutdown,
    isShuttingDown,
    registerShutdownHook,
    requestShutdown,
    watchStopSentinel,
} from "../../lifecycle/shutdown.js";
import { env, isEnvEnabled } from "../env.js";
import {
    enableIpc,
    flushIpc,
    type IpcServerOptions,
    lastIpcStatusPhase,
    sendStatus,
    shouldSendGenericBootFailed,
    startIpcServer,
} from "../ipc/index.js";
import { bootstrapExitCode, createState, errMsg, log, logFatal } from "../util.js";
import { bootstrap } from "./bootstrap.js";
import { reportMediaPatchStatus } from "./media-patch-status.js";

const ACCOUNT_PATH_SEPARATOR = /[\\/]/;
const ipcMode = isEnvEnabled(env.NAPUTO_IPC);
const ipc: IpcServerOptions | undefined = ipcMode ? { actions: new Map() } : undefined;

installSignalShutdown();
const dataRoot = env.NAPUTO_DATA_ROOT;
if (dataRoot) {
    const account =
        env.NAPUTO_CFG_DIR?.split(ACCOUNT_PATH_SEPARATOR).filter(Boolean).pop() ?? "default";
    registerShutdownHook(
        watchStopSentinel({
            dataRoot,
            account,
            onTrigger: () => {
                void requestShutdown("停止哨兵");
            },
        }),
        "intake",
    );
}

if (ipc !== undefined) {
    enableIpc(() => {
        void requestShutdown("IPC stdout 已失效");
    });
    registerShutdownHook(flushIpc, "flush");
    registerShutdownHook(startIpcServer(ipc), "intake");
    if (!isShuttingDown()) {
        sendStatus("booting");
    }
}

process.once("beforeExit", (code) => {
    void requestShutdown("事件循环结束", code);
});

process.on("unhandledRejection", (reason: unknown) => {
    log(`[self-host] unhandledRejection: ${errMsg(reason)}`);
});

async function failBoot(message: string, code: number, errorCode: string): Promise<void> {
    if (isShuttingDown()) {
        return;
    }
    logFatal(`[self-host] ${message}`);
    if (shouldSendGenericBootFailed(ipcMode, lastIpcStatusPhase())) {
        sendStatus("failed", message, { code: errorCode, message });
    }
    await requestShutdown("引导失败", code);
}

async function main(): Promise<void> {
    if (isShuttingDown()) {
        return;
    }
    log(`[self-host] 启动 pid=${process.pid} node=${process.version}`);
    const lockDataDir = env.NAPUTO_CFG_DIR;
    if (lockDataDir) {
        if (!acquireInstanceLock(lockDataDir)) {
            const { pid } = checkInstanceLock(lockDataDir);
            await failBoot(`无法获取账号目录锁（持有者 PID=${pid ?? "未知"}）`, 1, "INVALID_STATE");
            return;
        }
        registerLockCleanup(lockDataDir);
    } else {
        log("[self-host] NAPUTO_CFG_DIR 未设置，跳过单实例锁");
    }
    if (!env.NAPUTO_WRAPPER_PATH) {
        await failBoot("NAPUTO_WRAPPER_PATH 未设置", 1, "INVALID_STATE");
        return;
    }
    if (!(await bootstrap(createState(), ipc))) {
        await failBoot("bootstrap 未完成，详见 napuketto-boot.log", 1, "UNKNOWN");
        return;
    }
    if (!isShuttingDown()) {
        log("[self-host] bootstrap 完成");
        reportMediaPatchStatus();
    }
}

void main().catch(async (err: unknown) => {
    const code = bootstrapExitCode(err);
    await failBoot(
        `bootstrap 失败: ${errMsg(err)}`,
        code,
        code === 78 ? "INVALID_PARAM" : "UNKNOWN",
    );
});
