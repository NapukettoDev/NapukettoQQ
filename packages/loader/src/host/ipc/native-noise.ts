/**
 * native-noise.ts：wrapper 原生噪音行判定（cli 转发与 koishi IPC 两条路径共享单一来源）。
 *
 * wrapper.node 加载后原生 printf 直写 fd 的 C++ 日志，JS 层无法拦截，只能在消费端
 * 逐行过滤：
 *  - `<MMKV` / `<MemoryFile_Win32` / `<MMKV_IO`：MMKV 存储库刷屏（每次初始化打 ~6 行）
 *  - `loadSymbolFromShell` / `getNodeGetJsListApi` / `get symbol failed`：
 *    标准 node 无腾讯私有符号（NodeContextifyContextMetrics 等），GetProcAddress
 *    失败的加载警告（无害，纯噪音）
 *  - `loaded [mmkv.*] with N key-values`：MMKV 初始化完成行（野生日志，风格三，
 *    无统一前缀/时间戳，过滤）
 *  - `:N::loadFromFile> loading [mmkv.*] with crc`：MMKV 载入变体行
 *    （2026-10-25 补：`loading` 拼写与 `loaded` 并存，此前漏过滤外泄到宿主控制台）
 *  - Chromium 原生日志行 `[MMDD/HHMMSS.mmm:LEVEL:file.cc(line)]`（可选 `PID:TID:`
 *    前缀变体）：QQNT 原生层把内部进度也标 ERROR 级写 stderr——QUIC 建链/关链、
 *    session stats 报告等，每次 spawn 稳定刷屏 70+ 行（2026-11-05 补，与 koishi
 *    适配器 transport 本地判定同款，后续适配器可改回 import 共享）。FATAL 不在
 *    过滤表——崩溃现场仍透传
 *
 * 边界：只处理「整条」噪音行；原生输出插进 JSON 协议行字节中间的撕裂不归这里管
 * （IPC 路径由 status 重播与脏行诊断兜底，见 ipc-sender.ts / koishi 插件 client）。
 */
import { IPC_VERSION } from "./ipc-types.js";

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
