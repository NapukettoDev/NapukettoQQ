/**
 * 消息映射纯函数（任务书 KUROBOT-PROMPT §1.2 QQ↔MC 映射；翻译层无副作用，ADR-008）
 *
 * QQ → MC：canonical elements 富文本降级为单行文本（无法表达的类型静默跳过，
 * 对齐 OB11 收向「无法表达静默跳过」惯例）。
 * MC → QQ：渲染模板占位符替换（{player}/{content}/{message}，MVP 纯文本）+
 * 1500 字符截断。
 */
import { type CanonicalElement, type RawMessage, toCanonicalElements } from "@napuketto/kernel";
import type { CommandResultBody } from "./schema.js";

/** 发往 QQ 文本的总长上限（超出截断追加 …(截断)；任务书对 command_result 规定，统一套用）。 */
export const MAX_GROUP_TEXT_LENGTH = 1500;

/** 截断追加的省略标记。 */
const TRUNCATE_SUFFIX = "…(截断)";

/** 超长截断（按 UTF-16 码元计，超限部分丢弃）。 */
export function truncateForGroup(text: string): string {
    if (text.length <= MAX_GROUP_TEXT_LENGTH) {
        return text;
    }
    return `${text.slice(0, MAX_GROUP_TEXT_LENGTH)}${TRUNCATE_SUFFIX}`;
}

/** QQ 群消息发送者显示名：sendMemberName ?? sendNickName（双空兜底 senderUin，schema min(1)）。 */
export function resolveSenderName(msg: RawMessage): string {
    const member = msg.sendMemberName;
    if (typeof member === "string" && member !== "") {
        return member;
    }
    const nick = msg.sendNickName;
    if (typeof nick === "string" && nick !== "") {
        return nick;
    }
    return String(msg.senderUin);
}

/** at 元素 → 文本占位（@全体成员 / @{display ?? uid}）。 */
function atToText(el: { target: string; display?: string }): string {
    if (el.target === "all") {
        return "@全体成员";
    }
    return `@${el.display ?? el.target}`;
}

/** canonical 元素序列 → 降级文本（text 原文、@、图片/表情/回复占位；空白返回 null = 不发）。 */
export function degradeElements(elements: CanonicalElement[]): string | null {
    const parts: string[] = [];
    for (const el of elements) {
        switch (el.type) {
            case "text":
                parts.push(el.text);
                break;
            case "at":
                parts.push(atToText(el));
                break;
            case "image":
                parts.push("[图片]");
                break;
            case "face":
                parts.push("[表情]");
                break;
            case "reply":
                parts.push("[回复]");
                break;
            default:
                // voice/video/file/forward/json/xml/unknown：无法表达，静默跳过
                break;
        }
    }
    const text = parts.join("").trim();
    return text === "" ? null : text;
}

/** RawMessage → 降级文本（便捷封装；null = 空消息不发）。 */
export function degradeMessage(msg: RawMessage): string | null {
    return degradeElements(toCanonicalElements(msg));
}

/** 渲染模板变量（player 必有；content = 聊天内容；message = 死亡消息）。 */
export interface TemplateVars {
    player: string;
    content?: string;
    message?: string;
}

/** 渲染模板：替换 {player}/{content}/{message} 占位符（未知占位符原样保留）。 */
export function renderTemplate(template: string, vars: TemplateVars): string {
    return template
        .replaceAll("{player}", vars.player)
        .replaceAll("{content}", vars.content ?? "")
        .replaceAll("{message}", vars.message ?? "");
}

/** death 事件 → 群文本（message 空串时以「死亡了」代入：Bukkit deathMessage null 兜底）。 */
export function renderDeathText(template: string, player: string, message: string): string {
    return renderTemplate(template, { player, message: message === "" ? "死亡了" : message });
}

/** command_result body → 群文本（ok 合并 output；error → 命令失败：{error}）。 */
export function renderCommandResult(body: CommandResultBody): string {
    if (!body.ok) {
        return `命令失败：${body.error}`;
    }
    const output = body.output ?? [];
    if (output.length === 0) {
        return "（命令执行成功，无输出）";
    }
    return output.join("\n");
}
