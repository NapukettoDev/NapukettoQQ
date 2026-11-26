/**
 * Satori 消息元素解析/渲染（协议 v1，自研实现，规范参考 satori.chat/zh-CN/protocol/message.html）
 *
 * - parseElements：XML 风格字符串 → 元素树（注释/转义/无值属性/未配对标签容错）
 * - renderElements：元素树 → 字符串（消息 content 序列化）
 *
 * canonical ↔ Satori 双向转换不在本文件：收方向（canonical → Satori）在
 * canonical.ts，发方向（Satori → canonical）在 element-convert.ts，调用方直引。
 *
 * 语法要点（对齐规范）：
 * - 转义：&quot; &amp; &lt; &gt; &#39; &#x27; 与十进制/十六进制数字实体
 * - 注释 <!-- --> 不渲染
 * - 无值属性（key）与 key="value" / key='value' 均合法
 * - 未配对的标签视为文本内容的一部分
 * - 文本内容前后包含换行符的连续空白会被忽略
 */
import { readTag, readTagName } from "./parse-tag.js";

/** Satori 消息元素（与规范 satori-parse 形状一致；type="text" 为文本节点）。 */
export interface SatoriElement {
    type: string;
    attrs?: Record<string, string>;
    children?: SatoriElement[];
    text?: string;
}

/** 文本转义映射（& < >）。 */
const TEXT_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
};

/** 文本转义正则（& < >）。 */
const TEXT_ESCAPE_RE = /[&<>]/g;

/** 文本转义（& < >）。 */
function encodeText(input: string): string {
    return input.replace(TEXT_ESCAPE_RE, (ch) => TEXT_ESCAPES[ch] ?? ch);
}

/** 属性值转义映射（& " < >）。 */
const ATTR_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    '"': "&quot;",
    "<": "&lt;",
    ">": "&gt;",
};

/** 属性值转义正则（& " < >）。 */
const ATTR_ESCAPE_RE = /[&"<>]/g;

/** 属性值转义（& " < >）。 */
function encodeAttr(input: string): string {
    return input.replace(ATTR_ESCAPE_RE, (ch) => ATTR_ESCAPES[ch] ?? ch);
}

/** 行首连续空白。 */
const LEADING_WS_RE = /^\s+/;
/** 行尾连续空白。 */
const TRAILING_WS_RE = /\s+$/;
/** 换行符。 */
const NEWLINE_RE = /[\r\n]/;

/**
 * 文本规范化：开头/结尾的「包含换行符的连续空白」被忽略（规范），
 * 中间的空白与不含换行的首尾空白保留。
 */
function normalizeText(raw: string): string {
    const leading = LEADING_WS_RE.exec(raw);
    const trailing = TRAILING_WS_RE.exec(raw);
    let out = raw;
    if (leading !== null && NEWLINE_RE.test(leading[0])) {
        out = out.slice(leading[0].length);
    }
    if (trailing !== null && NEWLINE_RE.test(trailing[0])) {
        out = out.slice(0, -trailing[0].length);
    }
    return out;
}

/** 解析状态（挂载根 / 标签栈 / 文本缓冲）。 */
interface ParseState {
    readonly root: SatoriElement[];
    readonly stack: SatoriElement[];
    text: string;
}

/** 当前挂载数组（栈顶元素 children 或根数组）。 */
function mountPoint(state: ParseState): SatoriElement[] {
    const top = state.stack[state.stack.length - 1];
    if (top === undefined) {
        return state.root;
    }
    top.children ??= [];
    return top.children;
}

/** 归一化文本落位到当前挂载点。 */
function pushText(state: ParseState): void {
    const normalized = normalizeText(state.text);
    state.text = "";
    if (normalized !== "") {
        mountPoint(state).push({ type: "text", text: normalized });
    }
}

/**
 * 结束标签：匹配栈顶则闭合，否则按文本保留。
 * @returns 下一个解析位置；-1 = 终止解析。
 */
function closeTag(state: ParseState, source: string, lt: number, slashPos: number): number {
    const { name, end } = readTagName(source, slashPos + 1);
    if (name === "") {
        // 非法结束标签（</> 等）：< 按文本保留
        state.text += "<";
        return lt + 1;
    }
    const gt = source.indexOf(">", end);
    if (gt === -1) {
        state.text += source.slice(lt);
        return -1;
    }
    const top = state.stack[state.stack.length - 1];
    if (top !== undefined && top.type === name) {
        // 闭合前的文本推入该元素
        pushText(state);
        state.stack.pop();
    } else {
        // 未配对：原样当文本
        state.text += source.slice(lt, gt + 1);
    }
    return gt + 1;
}

/**
 * 解析 Satori 消息字符串 → 元素树。
 * 容错：未配对标签/非法标签按文本保留；解析不抛错（消息内容宽容）。
 */
export function parseElements(source: string): SatoriElement[] {
    const state: ParseState = { root: [], stack: [], text: "" };
    let i = 0;
    while (i < source.length) {
        const lt = source.indexOf("<", i);
        if (lt === -1) {
            state.text += source.slice(i);
            break;
        }
        state.text += source.slice(i, lt);
        i = lt + 1;
        // 注释：不渲染
        if (source.startsWith("!--", i)) {
            const end = source.indexOf("-->", i);
            if (end === -1) {
                break;
            }
            i = end + 3;
            continue;
        }
        // 结束标签
        if (source.startsWith("/", i)) {
            const next = closeTag(state, source, lt, i);
            if (next === -1) {
                break;
            }
            i = next;
            continue;
        }
        // 起始 / 自闭合标签
        const tag = readTag(source, i);
        if (tag.name === "") {
            state.text += "<";
            continue;
        }
        pushText(state);
        const el: SatoriElement = { type: tag.name, attrs: tag.attrs };
        mountPoint(state).push(el);
        if (!tag.selfClosing) {
            state.stack.push(el);
        }
        i = tag.end;
    }
    pushText(state);
    return state.root;
}

/** 元素树 → Satori 消息字符串。 */
export function renderElements(elements: SatoriElement[]): string {
    let out = "";
    for (const el of elements) {
        if (el.type === "text") {
            out += encodeText(el.text ?? "");
            continue;
        }
        out += renderElement(el);
    }
    return out;
}

/** 渲染单个元素（含子元素递归）。 */
function renderElement(el: SatoriElement): string {
    let attrs = "";
    for (const [key, value] of Object.entries(el.attrs ?? {})) {
        if (value === "") {
            // 无值属性（forward 等布尔属性）
            attrs += ` ${key}`;
        } else {
            attrs += ` ${key}="${encodeAttr(value)}"`;
        }
    }
    const children = el.children ?? [];
    if (children.length === 0) {
        return `<${el.type}${attrs}/>`;
    }
    const inner = renderElements(children);
    return `<${el.type}${attrs}>${inner}</${el.type}>`;
}
