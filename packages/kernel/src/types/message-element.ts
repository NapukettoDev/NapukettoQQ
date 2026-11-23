/**
 * canonical 消息元素模型（协议无关，ADR-008 延伸）
 *
 * 描述 QQ 消息的事实结构，是各协议翻译层的公共中间表示。
 *
 * 2026-11：运行时转换函数（picLocalCandidates / toCanonicalElements /
 * toSendElements）已下沉至 `../codec/message-element.ts`——类型层保持纯声明，
 * 不再 import `node:fs` 与 `../infra/**` 运行时值；本文件末行保留桥接重导出，
 * 既有导入坐标（含单测）零破坏。
 */

/** 协议无关的规范消息元素。 */
export type CanonicalElement =
    | { type: "text"; text: string }
    | { type: "at"; target: string; display?: string }
    | { type: "image"; path: string; url?: string; size?: { width: number; height: number } }
    | { type: "face"; id: string }
    | { type: "voice"; path: string; durationMs?: number; url?: string }
    | {
          type: "video";
          path: string;
          url?: string;
          thumbPath?: string;
          width?: number;
          height?: number;
          durationSec?: number;
      }
    | { type: "file"; path: string; name?: string; size?: number }
    | { type: "reply"; messageId: string; senderUid?: string; senderUin?: string }
    | { type: "forward"; messageIds: string[] }
    | { type: "json"; raw: unknown }
    | { type: "xml"; raw: unknown }
    | { type: "unknown"; raw: unknown };

/**
 * 兼容桥接：运行时转换实现在 codec 层（既有导入坐标不变）。
 *
 * 只桥接历史上从本文件导出的两个转换函数；`picLocalCandidates` 由
 * `types/index.js` 直接转发 codec（本文件不再转发，避免无消费方的死导出）。
 */
export { toCanonicalElements, toSendElements } from "../codec/message-element.js";
