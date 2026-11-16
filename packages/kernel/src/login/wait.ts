/**
 * 等待/延迟工具兼容桥接（实现已下沉至 `infra/wait.ts`）
 *
 * 保留本文件仅为兼容既有导入坐标与单测（`login/__tests__/wait.test.ts`）。
 */
export { sleep, waitFor } from "../infra/wait.js";
