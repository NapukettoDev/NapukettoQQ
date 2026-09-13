/**
 * CQ 码编解码（OneBot 11 消息段序列化格式）
 *
 * 纯函数、无 OB11 类型依赖：本文件只处理「文本 ↔ CQ 码片段」的通用编解码，
 * segment 级别的映射在 data.ts（OB11Constructor）。
 *
 * 转义规则（OneBot 11 规范）：
 * - 纯文本：& → &amp;，[ → &#91;，] → &#93;
 * - 参数值：额外 , → &#44;
 */

/** 解析单个 CQ 码文本 → 结构化 CqCode。 */
function parseCqCode(raw: string): CqCode {
    const body = raw.slice("[CQ:".length, -1);
    const firstComma = body.indexOf(",");
    let type = body;
    if (firstComma !== -1) {
        type = body.slice(0, firstComma);
    }
    const params: Record<string, string> = {};
    if (firstComma !== -1) {
        for (const pair of body.slice(firstComma + 1).split(",")) {
            const eq = pair.indexOf("=");
            if (eq > 0) {
                params[pair.slice(0, eq)] = unescapeCqText(pair.slice(eq + 1));
            }
        }
    }
    return { type, params };
}

/** CQ 码片段（[CQ:type,key=value,...] 的结构化表示）。 */
export interface CqCode {
    type: string;
    params: Record<string, string>;
}

/** 转义纯文本（& [ ]；& 必须先转，避免二次转义）。 */
export function escapeCqText(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("[", "&#91;").replaceAll("]", "&#93;");
}

/** 转义 CQ 码参数值（& [ ] ,）。 */
export function escapeCqParam(value: string): string {
    return escapeCqText(value).replaceAll(",", "&#44;");
}

/** 反转义（&#44; &#93; &#91; &amp;；&amp; 必须最后解，避免二次转义误伤）。 */
export function unescapeCqText(text: string): string {
    return text
        .replaceAll("&#44;", ",")
        .replaceAll("&#93;", "]")
        .replaceAll("&#91;", "[")
        .replaceAll("&amp;", "&");
}

/** 编码单个 CQ 码（undefined 参数自动省略）。 */
export function encodeCqCode(
    type: string,
    params: Record<string, string | number | undefined>,
): string {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            pairs.push(`${key}=${escapeCqParam(String(value))}`);
        }
    }
    if (pairs.length === 0) {
        return `[CQ:${type}]`;
    }
    return `[CQ:${type},${pairs.join(",")}]`;
}

/**
 * 解析一条消息文本 → 文本片段与 CQ 码片段的混合数组（文本已反转义）。
 *
 * 手工 indexOf 扫描而非全局正则（/\[CQ:[^\]]*\]/g）：消息文本不可信，正则在
 * 「大量 [CQ: 前缀且无闭合 ]」的输入下每个起点都全量回扫，复杂度 O(n²)
 * （CodeQL polynomial-redos）。indexOf 语义等价：从 [CQ: 起到其后第一个 ]。
 */
export function parseCqMessage(text: string): Array<string | CqCode> {
    const parts: Array<string | CqCode> = [];
    let lastIndex = 0;
    let start = text.indexOf("[CQ:");
    while (start !== -1) {
        const end = text.indexOf("]", start);
        if (end === -1) {
            break; // 无闭合 ]：剩余内容整体按纯文本处理
        }
        if (start > lastIndex) {
            parts.push(unescapeCqText(text.slice(lastIndex, start)));
        }
        parts.push(parseCqCode(text.slice(start, end + 1)));
        lastIndex = end + 1;
        start = text.indexOf("[CQ:", lastIndex);
    }
    if (lastIndex < text.length) {
        parts.push(unescapeCqText(text.slice(lastIndex)));
    }
    return parts;
}

/** 将混合片段数组序列化回消息文本（parseCqMessage 的逆操作）。 */
export function serializeCqParts(parts: Array<string | CqCode>): string {
    let out = "";
    for (const part of parts) {
        if (typeof part === "string") {
            out += escapeCqText(part);
        } else {
            out += encodeCqCode(part.type, part.params);
        }
    }
    return out;
}
