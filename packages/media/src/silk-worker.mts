import { parentPort, workerData } from "node:worker_threads";
import { decode, encode } from "silk-wasm";

const job = workerData as {
    mode: "encode" | "decode";
    data: Uint8Array;
    sampleRate: number;
};
const result = await (job.mode === "encode" ? encode : decode)(job.data, job.sampleRate);
const buffer = result.data.buffer;
parentPort?.postMessage(result, buffer instanceof ArrayBuffer ? [buffer] : []);
