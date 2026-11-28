import { Worker } from "node:worker_threads";
import { checkMediaSignal } from "../process.js";
import { MediaError } from "../types.js";

const MAX_SILK_WORK_MS = 30_000;

export interface SilkResult {
    data: Uint8Array;
    duration: number;
}

/** silk-wasm 的 Promise 内部运行同步 WASM；取消时等待执行它的 Worker 退出。 */
export async function runSilk(
    mode: "encode" | "decode",
    data: Buffer,
    sampleRate: number,
    signal?: AbortSignal,
): Promise<SilkResult> {
    checkMediaSignal(signal);
    const source = import.meta.url.endsWith(".ts");
    try {
        const worker = new Worker(
            new URL(source ? "../silk-worker.mts" : "./silk-worker.mjs", import.meta.url),
            {
                execArgv: source ? ["--experimental-strip-types"] : [],
                workerData: { mode, data, sampleRate },
                transferList: data.buffer instanceof ArrayBuffer ? [data.buffer] : [],
            },
        );
        return await new Promise<SilkResult>((done, reject) => {
            let result: SilkResult | undefined;
            let failure: unknown;
            const stop = (error: MediaError): void => {
                failure = error;
                worker.terminate().catch(reject);
            };
            const abort = (): void =>
                stop(new MediaError("媒体操作已取消", { cause: signal?.reason }));
            const timer = setTimeout(
                () => stop(new MediaError("SILK 编解码超时")),
                MAX_SILK_WORK_MS,
            );
            signal?.addEventListener("abort", abort, { once: true });
            worker.once("message", (message: SilkResult) => {
                result = message;
            });
            worker.once("error", (error) => {
                failure ??= error;
            });
            worker.once("exit", (code) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                if (failure !== undefined) reject(failure);
                else if (code !== 0 || result === undefined)
                    reject(new MediaError(`SILK Worker 退出: ${code}`));
                else done(result);
            });
            if (signal?.aborted) abort();
        });
    } catch (error) {
        if (error instanceof MediaError) throw error;
        throw new MediaError("SILK 编解码失败", { cause: error });
    }
}
