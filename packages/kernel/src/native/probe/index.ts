/**
 * native/probe：运行时反射探测子系统（L1 防腐层子域），探测 QQ wrapper.node 的
 * session / engine / service 结构，产出类型层所需的实体 JSON 形状。
 * probe.ts（一次性 dump）与 probe-listener.ts（长驻回调录制）是入口；不被 wrapper 反向重导出。
 */

/** @internal 运行时反射探测工具 */
export { probeRuntime } from "./probe.js";
export type { ListenerRecordEvent, ListenerRecordingResult } from "./probe-listener.js";
/** @internal 运行时反射探测工具 */
export { createRecordingListener, startListenerRecording } from "./probe-listener.js";
