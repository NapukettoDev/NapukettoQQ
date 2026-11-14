/**
 * Satori 标签读取（元素名 / 属性解析，从 element.ts 拆分，FTA 优化）
 *
 * - decodeEntity/decodeEntities：命名/十进制/十六进制实体解码（属性值用）
 * - readTagName：读取元素名（小写字母/数字/连字符，以字母开头）
 * - readTagAttrs / readAttr / skipSpaces：标签属性区解析（无值属性 / 引号值 / 无引号值）
 * - readTag：完整标签（名 + 属性 + 自闭合指示）
 */

/** 命名实体（规范规定的四个 + apos 宽容）。 */
const NAMED_ENTITIES: Record<string, string> = {
    quot: '"',
    amp: "&",
    lt: "<",
    gt: ">",
    apos: "'",
};

/** 解码单个实体（命名/十进制/十六进制）。 */
function decodeEntity(body: string): string {
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) {
        return named;
    }
    if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        if (Number.isInteger(code)) {
            return String.fromCodePoint(code);
        }
    }
    if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        if (Number.isInteger(code)) {
            return String.fromCodePoint(code);
        }
    }
    // 未识别实体原样保留
    return `&${body};`;
}

/** 解码字符串中的全部实体。 */
const ENTITY_RE = /&([^;]+);/g;

/** 解码字符串中的全部实体。 */
function decodeEntities(input: string): string {
    return input.replace(ENTITY_RE, (_full, body: string) => decodeEntity(body));
}

/** 元素名：小写字母/数字/连字符，以字母开头（规范）。 */
const NAME_RE = /^[a-z][a-z0-9-]*/i;

/** 读取元素名（pos 起）；未匹配返回空名。 */
export function readTagName(source: string, pos: number): { name: string; end: number } {
    const rest = source.slice(pos);
    const m = NAME_RE.exec(rest);
    if (m === null) {
        return { name: "", end: pos };
    }
    return { name: m[0], end: pos + m[0].length };
}

/** 空白字符。 */
const SPACE_RE = /\s/;

/** 跳过空白；返回下一个非空白位置。 */
function skipSpaces(source: string, start: number): number {
    let i = start;
    while (i < source.length && SPACE_RE.test(source.charAt(i))) {
        i += 1;
    }
    return i;
}

/** 属性名（字母数字 / 冒号（命名空间）/ 连字符 / 下划线）。 */
const ATTR_NAME_RE = /^[a-zA-Z0-9:_-]+/;
/** 无引号属性值的结束字符（空白 / >）。 */
const ATTR_VALUE_END_RE = /[\s>]/;

/** 读取单个属性（名 / = / 值 / 无值属性），更新 attrs，返回下一个位置。 */
function readAttr(source: string, start: number, attrs: Record<string, string>): number {
    // 属性名（字母数字 / 冒号（命名空间）/ 连字符 / 下划线）
    const keyMatch = ATTR_NAME_RE.exec(source.slice(start));
    if (keyMatch === null) {
        return start + 1;
    }
    const key = keyMatch[0];
    let i = skipSpaces(source, start + key.length);
    if (source.charAt(i) !== "=") {
        // 无值属性
        attrs[key] = "";
        return i;
    }
    i = skipSpaces(source, i + 1);
    const quote = source.charAt(i);
    if (quote === '"' || quote === "'") {
        i += 1;
        const valueStart = i;
        while (i < source.length && source.charAt(i) !== quote) {
            i += 1;
        }
        attrs[key] = decodeEntities(source.slice(valueStart, i));
        if (i < source.length) {
            i += 1; // 跳过结束引号
        }
    } else {
        // 无引号值（到空白或 > 为止）
        const valueStart = i;
        while (i < source.length && !ATTR_VALUE_END_RE.test(source.charAt(i))) {
            i += 1;
        }
        attrs[key] = decodeEntities(source.slice(valueStart, i));
    }
    return i;
}

/** 读取标签属性区（到 > 或 /> 为止），返回属性表与闭合指示、结束位置。 */
function readTagAttrs(
    source: string,
    start: number,
): { attrs: Record<string, string>; selfClosing: boolean; end: number } {
    const attrs: Record<string, string> = {};
    let i = start;
    let selfClosing = false;
    while (i < source.length) {
        const ch = source.charAt(i);
        if (ch === ">") {
            i += 1;
            break;
        }
        if (ch === "/") {
            if (source.charAt(i + 1) === ">") {
                selfClosing = true;
                i += 2;
                break;
            }
            i += 1;
            continue;
        }
        if (SPACE_RE.test(ch)) {
            i += 1;
            continue;
        }
        i = readAttr(source, i, attrs);
    }
    return { attrs, selfClosing, end: i };
}

/** 读取完整标签（元素名 + 属性 + 闭合指示），返回属性表与结束位置。 */
export function readTag(
    source: string,
    pos: number,
): { name: string; attrs: Record<string, string>; selfClosing: boolean; end: number } {
    const { name, end } = readTagName(source, pos);
    if (name === "") {
        return { name: "", attrs: {}, selfClosing: false, end: pos };
    }
    const { attrs, selfClosing, end: attrEnd } = readTagAttrs(source, end);
    return { name, attrs, selfClosing, end: attrEnd };
}
