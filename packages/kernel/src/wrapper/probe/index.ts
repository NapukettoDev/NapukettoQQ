/**
 * wrapper/probe：运行时反射探测子系统（从 wrapper/ 根拆分，2026-08-08 DDD 重组）
 *
 * 探测 QQ wrapper.node 的 session/engine/service 结构，产出类型层所需的
 * 实体 JSON 形状。probe.ts（probeRuntime，一次性 dump）与 probe-listener.ts
 * （startListenerRecording，长驻回调录制）是对外入口，其余为内部实现。
 */
export { probeRuntime } from "./probe.js";
export type { ListenerRecordEvent, ListenerRecordingResult } from "./probe-listener.js";
export { createRecordingListener, startListenerRecording } from "./probe-listener.js";
