/**
 * helper/element/element.test.ts：parseElements / renderElements 单测。
 *
 * 锁定解析语法（XML 风格 + 容错）：
 *  - 标签/自闭合/嵌套/无值属性/单双引号属性/数字与命名实体
 *  - 注释跳过（含未闭合终止）、非法标签与未配对标签按文本保留、</> 非法结束标签
 *  - 文本规范化（含换行的首尾连续空白忽略，中间空白与纯空白保留）
 * 锁定渲染：文本转义（& < >）、属性转义（& " < >）、无值属性、空元素自闭合、递归子元素。
 */
import { describe, expect, it } from "vitest";
import type { SatoriElement } from "../element.js";
import { parseElements, renderElements } from "../element.js";

describe("parseElements 基础", () => {
    it("纯文本 → 单个 text 元素", () => {
        expect(parseElements("你好")).toEqual([{ type: "text", text: "你好" }]);
    });

    it("空字符串 → 空数组", () => {
        expect(parseElements("")).toEqual([]);
    });

    it('自闭合标签：<at id="123"/>', () => {
        expect(parseElements('<at id="123"/>')).toEqual([{ type: "at", attrs: { id: "123" } }]);
    });

    it("开闭标签与嵌套子元素", () => {
        expect(parseElements("<b>粗体</b>")).toEqual([
            { type: "b", attrs: {}, children: [{ type: "text", text: "粗体" }] },
        ]);
        expect(parseElements('<message forward id="f1"><at id="1"/>文本</message>')).toEqual([
            {
                type: "message",
                attrs: { forward: "", id: "f1" },
                children: [
                    { type: "at", attrs: { id: "1" } },
                    { type: "text", text: "文本" },
                ],
            },
        ]);
    });

    it("标签间的文本累积（文本在标签前后拼接）", () => {
        expect(parseElements('a<at id="1"/>b')).toEqual([
            { type: "text", text: "a" },
            { type: "at", attrs: { id: "1" } },
            { type: "text", text: "b" },
        ]);
    });

    it("多个根级元素顺序保持", () => {
        expect(parseElements('<at id="1"/><at id="2"/>')).toEqual([
            { type: "at", attrs: { id: "1" } },
            { type: "at", attrs: { id: "2" } },
        ]);
    });
});

describe("parseElements 属性", () => {
    it("无值属性（布尔属性）→ 空串值", () => {
        expect(parseElements("<message forward/>")).toEqual([
            { type: "message", attrs: { forward: "" } },
        ]);
    });

    it("单引号与双引号属性等价", () => {
        expect(parseElements("<at id='42'/>")).toEqual([{ type: "at", attrs: { id: "42" } }]);
    });

    it("无引号属性值（到空白或 > 为止；'/' 计入值）", () => {
        // 无引号值扫描只认空白与 > 结束：'<at id=42/>' 的 '/' 落入值内（实现现状）
        expect(parseElements("<at id=42/>")).toEqual([{ type: "at", attrs: { id: "42/" } }]);
        expect(parseElements("<at id=42 >")).toEqual([{ type: "at", attrs: { id: "42" } }]);
    });

    it("属性值内命名实体解码（&quot; &amp; &#39;）", () => {
        expect(parseElements('<at id="a&quot;b&amp;c"/>')).toEqual([
            { type: "at", attrs: { id: 'a"b&c' } },
        ]);
        expect(parseElements("<at id='x&#39;y'/>")).toEqual([{ type: "at", attrs: { id: "x'y" } }]);
    });

    it("属性值内数字/十六进制实体解码", () => {
        expect(parseElements('<at id="&#65;&#x42;"/>')).toEqual([
            { type: "at", attrs: { id: "AB" } },
        ]);
    });

    it("未识别实体原样保留", () => {
        expect(parseElements('<at id="&nope;"/>')).toEqual([
            { type: "at", attrs: { id: "&nope;" } },
        ]);
    });

    it("属性名支持命名空间冒号 / 连字符 / 下划线", () => {
        expect(parseElements('<el xml:lang="zh" data-x="1" under_score="v"/>')).toEqual([
            { type: "el", attrs: { "xml:lang": "zh", "data-x": "1", under_score: "v" } },
        ]);
    });
});

describe("parseElements 容错", () => {
    it("注释不渲染（跳到 --> 之后）", () => {
        expect(parseElements("a<!-- 隐藏内容 -->b")).toEqual([{ type: "text", text: "ab" }]);
        expect(parseElements("<!-- 全注释 -->")).toEqual([]);
    });

    it("未闭合注释：终止解析（已累积文本保留）", () => {
        expect(parseElements("abc<!-- 没有结束")).toEqual([{ type: "text", text: "abc" }]);
    });

    it("非法标签（< 后无合法名）：< 按文本保留", () => {
        expect(parseElements("a< b")).toEqual([{ type: "text", text: "a< b" }]);
        expect(parseElements("<1/>")).toEqual([{ type: "text", text: "<1/>" }]);
    });

    it("非法结束标签 </>：< 按文本保留并继续", () => {
        expect(parseElements("a</>b")).toEqual([{ type: "text", text: "a</>b" }]);
    });

    it("未配对结束标签：原样当文本", () => {
        expect(parseElements("a</at>b")).toEqual([{ type: "text", text: "a</at>b" }]);
    });

    it("合法名但无 > 的起始标签：按元素收尾（宽容，属性到串尾）", () => {
        expect(parseElements("a<at id")).toEqual([
            { type: "text", text: "a" },
            { type: "at", attrs: { id: "" } },
        ]);
    });

    it("多余结束标签不吞文本（栈顶类型不符时按文本）", () => {
        expect(parseElements("<b>x</at>y</b>")).toEqual([
            {
                type: "b",
                attrs: {},
                children: [{ type: "text", text: "x</at>y" }],
            },
        ]);
    });

    it("未闭合元素：文本落在栈顶元素内（宽容）", () => {
        expect(parseElements("<b>未闭合")).toEqual([
            { type: "b", attrs: {}, children: [{ type: "text", text: "未闭合" }] },
        ]);
    });

    it("无文本内容的未闭合元素：不产生 children 字段", () => {
        expect(parseElements("<b>")).toEqual([{ type: "b", attrs: {} }]);
    });
});

describe("parseElements 文本规范化", () => {
    it("首尾含换行的连续空白被忽略", () => {
        expect(parseElements("\n  你好  \n")).toEqual([{ type: "text", text: "你好" }]);
        expect(parseElements('\r\n\t<at id="1"/>')).toEqual([{ type: "at", attrs: { id: "1" } }]);
    });

    it("不含换行的首尾空白保留", () => {
        expect(parseElements("  你好  ")).toEqual([{ type: "text", text: "  你好  " }]);
    });

    it("中间空白保留", () => {
        expect(parseElements("你好\n\n世界")).toEqual([{ type: "text", text: "你好\n\n世界" }]);
    });

    it("纯空白文本（不含换行）保留", () => {
        expect(parseElements("   ")).toEqual([{ type: "text", text: "   " }]);
    });
});

describe("renderElements", () => {
    it("文本转义：& < >", () => {
        expect(renderElements([{ type: "text", text: "a&b<c>d" }])).toBe("a&amp;b&lt;c&gt;d");
    });

    it("空元素：自闭合（无子元素）", () => {
        expect(renderElements([{ type: "at", attrs: { id: "1" } }])).toBe('<at id="1"/>');
        expect(renderElements([{ type: "br" }])).toBe("<br/>");
    });

    it("有子元素：展开为开闭标签并递归渲染", () => {
        expect(
            renderElements([{ type: "b", attrs: {}, children: [{ type: "text", text: "粗&体" }] }]),
        ).toBe("<b>粗&amp;体</b>");
    });

    it('属性值转义：& " < >；无值属性只写键名', () => {
        expect(renderElements([{ type: "img", attrs: { src: 'a?x=1&y="2"<z>' } }])).toBe(
            '<img src="a?x=1&amp;y=&quot;2&quot;&lt;z&gt;"/>',
        );
        expect(renderElements([{ type: "message", attrs: { forward: "" } }])).toBe(
            "<message forward/>",
        );
    });

    it("text 元素缺 text 字段：按空串渲染", () => {
        expect(renderElements([{ type: "text" } as unknown as SatoriElement])).toBe("");
    });

    it("往返：parse → render 对简单消息可还原语义（转义规范化后）", () => {
        const source = '<at id="1"/>你好';
        expect(renderElements(parseElements(source))).toBe(source);
    });
});

describe("parseElements 补充分支", () => {
    it("结束标签无 >（串尾截断）：按文本保留并终止", () => {
        expect(parseElements("x</at")).toEqual([{ type: "text", text: "x</at" }]);
    });

    it("十六进制实体大写 X 前缀（&#X41;）同样解码", () => {
        expect(parseElements('<at id="&#X41;"/>')).toEqual([{ type: "at", attrs: { id: "A" } }]);
    });

    it("十六进制实体小写 x 前缀", () => {
        expect(parseElements('<at id="&#x1F600;"/>')).toEqual([
            { type: "at", attrs: { id: "\u{1F600}" } },
        ]);
    });
});

describe("renderElements 补充分支", () => {
    it("显式空 children 数组：仍渲染为自闭合", () => {
        expect(renderElements([{ type: "b", attrs: {}, children: [] }])).toBe("<b/>");
    });
});
