/**
 * 收方向转换：kernel canonical → Satori 元素（从 element-convert.ts 拆分，FTA 优化）
 *
 * canonicalToSatoriElements：纯函数映射，宽容忽略 unknown（json/xml 无法表达）。
 * at 目标为 uid 时经 uidToUin 批量转换（异步，失败原样 uid）。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { SatoriElement } from "./element.js";

/** 收方向依赖（at uid 解析）。 */
export interface CanonicalToSatoriDeps {
    /** uid → uin（at 目标显示用；未提供原样返回 uid）。 */
    uidToUin?: (uids: string[]) => Promise<Map<string, string>>;
}

/** 收集 at uid → 批量 uidToUin（失败不阻塞，at 原样 uid）。 */
async function resolveAtUids(
    elements: CanonicalElement[],
    uidToUin: CanonicalToSatoriDeps["uidToUin"],
): Promise<Map<string, string>> {
    const atUids: string[] = [];
    for (const el of elements) {
        if (el.type === "at" && el.target !== "all") {
            atUids.push(el.target);
        }
    }
    if (atUids.length === 0 || uidToUin === undefined) {
        return new Map();
    }
    try {
        return await uidToUin([...new Set(atUids)]);
    } catch {
        // uid 解析失败：at 原样（uid），不阻塞事件翻译
        return new Map();
    }
}

/** canonical at → Satori at（uid → uin，name = display）。 */
function atToSatori(
    el: Extract<CanonicalElement, { type: "at" }>,
    uinMap: Map<string, string>,
): SatoriElement {
    if (el.target === "all") {
        return { type: "at", attrs: { id: "all" } };
    }
    const attrs: Record<string, string> = {
        id: uinMap.get(el.target) ?? el.target,
    };
    if (el.display !== undefined && el.display !== "") {
        attrs["name"] = el.display;
    }
    return { type: "at", attrs };
}

/** canonical file → Satori file（title = name）。 */
function fileToSatori(el: Extract<CanonicalElement, { type: "file" }>): SatoriElement {
    const attrs: Record<string, string> = { src: el.path };
    if (el.name !== undefined && el.name !== "") {
        attrs["title"] = el.name;
    }
    return { type: "file", attrs };
}

/** canonical forward → Satori message（取首个消息 id）。 */
function forwardToSatori(el: Extract<CanonicalElement, { type: "forward" }>): SatoriElement | null {
    const first = el.messageIds[0];
    if (first === undefined || first === "") {
        return null;
    }
    return { type: "message", attrs: { forward: "", id: first } };
}

/** 单个 canonical → Satori（null = 宽容忽略，如 json/xml/unknown）。 */
function canonicalToSatori(
    el: CanonicalElement,
    uinMap: Map<string, string>,
): SatoriElement | null {
    switch (el.type) {
        case "text":
            return el.text === "" ? null : { type: "text", text: el.text };
        case "at":
            return atToSatori(el, uinMap);
        case "image":
            return { type: "img", attrs: { src: el.url ?? el.path } };
        case "face":
            return { type: "emoji", attrs: { id: el.id } };
        case "voice":
            return { type: "audio", attrs: { src: el.path } };
        case "video":
            return { type: "video", attrs: { src: el.url ?? el.path } };
        case "file":
            return fileToSatori(el);
        case "reply":
            return { type: "quote", attrs: { id: el.messageId } };
        case "forward":
            return forwardToSatori(el);
        case "json":
        case "xml":
        case "unknown":
            // 无法表达：忽略（宽容）
            return null;
    }
}

/**
 * 收方向：kernel canonical 元素 → Satori 元素树（纯函数映射，宽容忽略 unknown）。
 * at 目标为 uid 时经 uidToUin 转换（异步）；无转换器时原样。
 */
export async function canonicalToSatoriElements(
    elements: CanonicalElement[],
    deps: CanonicalToSatoriDeps = {},
): Promise<SatoriElement[]> {
    const uinMap = await resolveAtUids(elements, deps.uidToUin);
    const out: SatoriElement[] = [];
    for (const el of elements) {
        const converted = canonicalToSatori(el, uinMap);
        if (converted !== null) {
            out.push(converted);
        }
    }
    return out;
}
