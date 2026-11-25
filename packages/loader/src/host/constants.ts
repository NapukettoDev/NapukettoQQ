/**
 * constants.ts：host 层运行时常量（2026-11-25 从 types.ts 拆出）。
 *
 * 为什么单独成文件：`host/types.ts` 必须是**纯类型**文件（0 运行时导出）——
 * 它同时被 host / lifecycle / boot 类型面引用，运行时值会把「纯类型层」变成
 * 运行期依赖节点（目录级循环的温床）。协议键、URL 化正则、QR 标记等常量只在
 * 装配与适配层使用，放这里。
 */

/** Windows 反斜杠（file:// URL 化时替换）。 */
export const BACKSLASH_RE = /\\/g;

/** adapter 入口 index.mjs 后缀（子路径导出替换用）。 */
export const INDEX_MJS_RE = /index\.mjs$/;

/**
 * 协议键（账号内配置段名 = adapter 子路径名，2026-11-18 表驱动单一来源）：
 * 协议段提取、子路径校验与装配顺序都从这里派生，避免四协议各写一遍。
 */
export const PROTOCOL_KEYS = ["onebot11", "satori", "kurobot", "milky"] as const;

/** 协议键字面量联合。 */
export type ProtocolKey = (typeof PROTOCOL_KEYS)[number];

/**
 * QR 透出标记行前缀（loader bootstrap-core 非 IPC 模式输出 stdout，
 * cli 解析后终端渲染二维码；loader 与 apps/cli 共享单一来源）。
 */
export const QR_LINE_PREFIX = "NAPUTO_QR ";
