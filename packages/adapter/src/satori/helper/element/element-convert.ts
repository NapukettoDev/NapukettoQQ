/**
 * 发方向转换：Satori 元素 → kernel canonical（从 element.ts 拆分，FTA 优化）
 *
 * - satoriToCanonicalElements：Satori 元素树 → kernel canonical（at uin→uid + 资源下载/转码）
 * - parseContentToCanonical：消息 content 字符串 → canonical（message.create 用）
 *
 * 收方向（canonical → Satori）在 canonical.ts；解析/渲染（parseElements / renderElements）
 * 留在 element.ts；资源处理（http 下载 / silk 转码 / internal 路径）在 asset.ts；
 * 媒体元素转换器（img/audio/video/file）在 media-convert.ts。
 * 本文件只做发方向元素映射。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { SatoriElement } from "./element.js";
import { parseElements } from "./element.js";
import type { SatoriToCanonicalDeps } from "./media-convert.js";
import { MEDIA_CONVERTERS } from "./media-convert.js";

export type { SatoriToCanonicalDeps } from "./media-convert.js";

/** 发方向：Satori 元素树 → kernel canonical（at uin→uid + 资源下载/转码）。 */
export async function satoriToCanonicalElements(
    elements: SatoriElement[],
    deps: SatoriToCanonicalDeps,
): Promise<CanonicalElement[]> {
    // 预收集 at uin → 批量转换
    const atUins: string[] = [];
    const collectAt = (list: SatoriElement[]): void => {
        for (const el of list) {
            const id = el.attrs?.["id"];
            if (el.type === "at" && id !== undefined && id !== "all") {
                atUins.push(id);
            }
            if (el.children !== undefined) {
                collectAt(el.children);
            }
        }
    };
    collectAt(elements);
    let uinToUidMap = new Map<string, string>();
    if (atUins.length > 0) {
        try {
            uinToUidMap = await deps.uinToUid([...new Set(atUins)]);
        } catch {
            // uin 解析失败：at 原样（uin），由 kernel 发送时兜底
        }
    }
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        out.push(...(await elementToCanonical(el, deps, uinToUidMap)));
    }
    return out;
}

/** Satori at → canonical at（uin → uid，name → display）。 */
function atToCanonical(el: SatoriElement, uinToUidMap: Map<string, string>): CanonicalElement[] {
    const id = el.attrs?.["id"] ?? "";
    if (id === "all") {
        return [{ type: "at", target: "all" }];
    }
    if (id === "") {
        return [];
    }
    const target = uinToUidMap.get(id) ?? id;
    const display = el.attrs?.["name"];
    const base: CanonicalElement = { type: "at", target };
    if (display !== undefined && display !== "") {
        return [{ ...base, display }];
    }
    return [base];
}

/** Satori message：forward 属性 → canonical forward；否则展开子元素。 */
async function messageToCanonical(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
    uinToUidMap: Map<string, string>,
): Promise<CanonicalElement[]> {
    if (el.attrs?.["forward"] !== undefined) {
        const id = el.attrs?.["id"] ?? "";
        return id === "" ? [] : [{ type: "forward", messageIds: [id] }];
    }
    // 普通 message 元素：展开子元素
    return flattenChildren(el.children, deps, uinToUidMap);
}

/** 元素转换器（type → 转换逻辑；修饰/排版元素无表项，fallback 展开子元素）。 */
type ElementConverter = (
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
    uinToUidMap: Map<string, string>,
) => Promise<CanonicalElement[]>;

/** 元素 type → 转换器（未知/修饰/排版类型走 fallback，不在此表）。 */
const ELEMENT_CONVERTERS: Record<string, ElementConverter> = {
    text: async (el) => {
        const text = el.text ?? "";
        return text === "" ? [] : [{ type: "text", text }];
    },
    at: async (el, _deps, uinToUidMap) => atToCanonical(el, uinToUidMap),
    emoji: async (el) => {
        const id = el.attrs?.["id"] ?? "";
        return id === "" ? [] : [{ type: "face", id }];
    },
    quote: async (el) => {
        const id = el.attrs?.["id"] ?? "";
        return id === "" ? [] : [{ type: "reply", messageId: id }];
    },
    message: async (el, deps, uinToUidMap) => messageToCanonical(el, deps, uinToUidMap),
    br: async () => [{ type: "text", text: "\n" }],
    // QQ 不支持：忽略（button 交互第一版不做）
    author: async () => [],
    sharp: async () => [],
    a: async () => [],
    button: async () => [],
    // 媒体元素（img/audio/video/file）：独立文件 media-convert.ts
    ...MEDIA_CONVERTERS,
};

/** 单个元素 → canonical（修饰/排版元素展开子元素）。 */
async function elementToCanonical(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
    uinToUidMap: Map<string, string>,
): Promise<CanonicalElement[]> {
    const converter = ELEMENT_CONVERTERS[el.type];
    if (converter !== undefined) {
        return converter(el, deps, uinToUidMap);
    }
    // 修饰（b/i/u/s/code 等）/排版（p）元素：展开子元素
    return flattenChildren(el.children, deps, uinToUidMap);
}

/** 展开子元素为 canonical（递归）。 */
async function flattenChildren(
    children: SatoriElement[] | undefined,
    deps: SatoriToCanonicalDeps,
    uinToUidMap: Map<string, string>,
): Promise<CanonicalElement[]> {
    const out: CanonicalElement[] = [];
    for (const child of children ?? []) {
        out.push(...(await elementToCanonical(child, deps, uinToUidMap)));
    }
    return out;
}

/** 解析消息 content 字符串 → canonical（message.create 用）。 */
export async function parseContentToCanonical(
    content: string,
    deps: SatoriToCanonicalDeps,
): Promise<CanonicalElement[]> {
    const elements = parseElements(content);
    return satoriToCanonicalElements(elements, deps);
}
