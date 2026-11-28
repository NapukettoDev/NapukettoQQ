import { pathToFileURL } from "node:url";
import { isShuttingDown } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage, getOwnProp } from "../../shared/type-guards.js";
import { sendStatus } from "../ipc/sender.js";
import type { IpcServerOptions } from "../ipc/server.js";
import { env, isEnvEnabled } from "../runtime/env.js";
import { convergeBootstrapFailure } from "../runtime/errors.js";
import { isKernelModule } from "../runtime/module-guards.js";
import type { BootstrapEnv, KernelLike, PreparedHostLike } from "../runtime/types.js";
import { bootstrapWithCore } from "./core.js";

async function importKernel(): Promise<unknown> {
    const kernelEntry = env.NAPUKETTO_KERNEL_ENTRY;
    if (!kernelEntry) {
        throw new Error("NAPUKETTO_KERNEL_ENTRY 未设置");
    }
    return import(pathToFileURL(kernelEntry).href);
}

function buildBootEnv(): BootstrapEnv {
    return {
        qqVersion: env.NAPUKETTO_QQ_VERSION || "",
        dataDir: env.NAPUKETTO_CFG_DIR || "",
        dataRoot: env.NAPUKETTO_DATA_ROOT || "",
        wrapperPath: env.NAPUKETTO_WRAPPER_PATH || "",
    };
}

function prepareHost(
    kernel: unknown,
    bootEnv: BootstrapEnv,
): {
    kernel: KernelLike;
    host: PreparedHostLike;
} {
    const ipcMode = isEnvEnabled(env.NAPUKETTO_IPC);
    if (ipcMode) {
        sendStatus("dlopening");
    }
    try {
        if (!isKernelModule(kernel)) {
            throw Object.assign(
                new Error("kernel 缺少 prepareSelfHost，请升级并同步部署 kernel 与 loader"),
                { code: "INVALID_STATE" },
            );
        }
        return { kernel, host: kernel.prepareSelfHost(bootEnv) };
    } catch (err) {
        const code = getOwnProp(err, "code") === "INVALID_STATE" ? "INVALID_STATE" : "UNKNOWN";
        if (ipcMode) {
            sendStatus("failed", "原生引导失败", { code, message: getErrorMessage(err) });
        }
        throw err;
    }
}

export async function bootstrap(ipc?: IpcServerOptions): Promise<boolean> {
    try {
        const rawKernel = await importKernel();
        if (isShuttingDown()) {
            return false;
        }
        const bootEnv = buildBootEnv();
        const { kernel, host } = prepareHost(rawKernel, bootEnv);
        const appid = host.resolveAppid();
        log("bootstrap: appid 已解析");
        return await bootstrapWithCore(kernel, host, bootEnv, appid, ipc);
    } catch (e) {
        return convergeBootstrapFailure(e, "kernel 引导失败");
    }
}
