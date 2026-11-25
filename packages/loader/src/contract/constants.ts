/**
 * constants.ts：跨进程契约常量（协议键 / 二维码标记行）。
 *
 * 分层：`contract/` 是父子进程共享的契约层，只允许内部互引（`native-noise.ts →
 * ipc-schema.ts`），不依赖 `shared/` 之外的任何目录。file:// URL 化用的正则属
 * `host/runtime/module-loader.ts` 的实现细节，已内联到该文件，不再对外暴露。
 */

/**
 * 协议键（账号内配置段名 = adapter 子路径名，2026-11-18 表驱动单一来源）：
 * 协议段提取、子路径校验与装配顺序都从这里派生，避免四协议各写一遍。
 */
export const PROTOCOL_KEYS = ["onebot11", "satori", "kurobot", "milky"] as const;

/** 协议键字面量联合。 */
export type ProtocolKey = (typeof PROTOCOL_KEYS)[number];

/**
 * QR 透出标记行前缀（loader bootstrap/core 非 IPC 模式输出 stdout，
 * cli 解析后终端渲染二维码；loader 与 apps/cli 共享单一来源）。
 */
export const QR_LINE_PREFIX = "NAPUTO_QR ";
