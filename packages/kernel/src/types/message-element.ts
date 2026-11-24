/**
 * canonical 消息元素模型（协议无关，ADR-008 延伸）
 *
 * 描述 QQ 消息的事实结构，是各协议翻译层的公共中间表示。
 *
 * 本文件只做**类型声明**（无 `node:fs` / `infra` 运行时依赖）；运行时转换函数
 * （`picLocalCandidates` / `toCanonicalElements` / `toSendElements`）在
 * `codec/message-element.ts`，经 `codec/index.ts` 对外。
 */

/** 协议无关的规范消息元素。 */
export type CanonicalElement =
    | { type: "text"; text: string }
    | { type: "at"; target: string; display?: string }
    | {
          type: "image";
          path: string;
          url?: string;
          /** 图片像素尺寸（协议层探测后填充；缺省时 kernel 读文件头兜底）。 */
          size?: { width: number; height: number };
          /** 图片 MIME（如 image/png；缺省时 kernel 按扩展名/文件头推断 picType）。 */
          mime?: string;
      }
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
