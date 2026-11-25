/**
 * native-noise.ts：wrapper 原生噪音行判定（cli 转发与 koishi IPC 共享单一来源）——原生 printf 直写 fd，JS 只能逐行过滤。
 * 过滤：MMKV 刷屏行（`loaded`/`loading` 两种拼写）、标准 node 缺腾讯私有符号的加载警告、Chromium 原生 ERROR/WARNING/INFO 行。
 * FATAL 不在过滤表——崩溃现场仍透传；只处理整行噪音，插进 JSON 协议行中间的撕裂由脏行诊断兜底（见 ipc/sender.ts）。
 */
import { IPC_VERSION } from "./ipc-schema.js";

const NATIVE_NOISE =
    /<MMKV|<MemoryFile_Win32|<MMKV_IO|loadSymbolFromShell|getNodeGetJsListApi|get symbol failed|loaded \[mmkv|loadFromFile> loading \[mmkv|^\[(?:\d+:\d+:)?\d{4}\/\d{6}\.\d{3}:(?:ERROR|WARNING|INFO):/i;

/** IPC 协议行前缀（encodeIpcMessage 走 JSON.stringify 无空白，前缀恒定）。 */
const IPC_LINE_PREFIX = `{"v":${IPC_VERSION}`;

/**
 * 判定一行子进程输出是否为 wrapper 原生噪音（命中即整行静默丢弃，不进协议解析）。
 *
 * IPC 协议行构造性豁免：载荷可能嵌入噪音样文本（如用户消息含 `<MMKV>` 字样），
 * 以协议前缀开头的行永不判噪——过滤与协议必须无交集，防误滤丢消息事件。
 */
export function isNativeNoiseLine(line: string): boolean {
    if (line.startsWith(IPC_LINE_PREFIX)) {
        return false;
    }
    return NATIVE_NOISE.test(line);
}
