/**
 * OB11 目标 Peer 解析 / 单条消息拉取——兼容桥接（实现已上移至 `../base-action.js`）
 *
 * 保留本文件仅为兼容既有导入坐标（`msg-ops.test.ts`）；生产代码一律从
 * `../base-action.js` 导入，避免 `system/ -> message/` 的跨子域依赖。
 */
export { fetchMsgById, resolveTargetPeer } from "../base-action.js";
