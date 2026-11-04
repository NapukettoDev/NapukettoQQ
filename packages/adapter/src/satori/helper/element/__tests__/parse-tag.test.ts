/**
 * helper/element/parse-tag.test.ts：标签读取原语单测（readTagName / readTag）。
 *
 * 锁定：元素名规则（字母开头 + 数字/连字符）、属性区解析（引号/无引号/
 * 无值属性/实体解码）、自闭合指示、非法名返回空。
 */
import { describe, expect, it } from "vitest";
import { readTag, readTagName } from "../parse-tag.js";

describe("readTagName", () => {
    it("小写字母开头的名字", () => {
        expect(readTagName("at id", 0)).toEqual({ name: "at", end: 2 });
    });

    it("名字含数字与连字符；大写字母开头也接受", () => {
        expect(readTagName("guild-member-2 x", 0)).toEqual({ name: "guild-member-2", end: 14 });
        expect(readTagName("At", 0)).toEqual({ name: "At", end: 2 });
    });

    it("非字母开头（数字/符号）：空名 + 原位置", () => {
        expect(readTagName("1abc", 0)).toEqual({ name: "", end: 0 });
        expect(readTagName("<x", 0)).toEqual({ name: "", end: 0 });
    });

    it("pos 偏移生效（从串中间读取）", () => {
        expect(readTagName("x<at", 2)).toEqual({ name: "at", end: 4 });
    });

    it("空串 / 越界 pos：空名", () => {
        expect(readTagName("", 0)).toEqual({ name: "", end: 0 });
        expect(readTagName("ab", 5)).toEqual({ name: "", end: 5 });
    });
});

describe("readTag", () => {
    it("完整自闭合标签：名 + 属性 + selfClosing", () => {
        expect(readTag('at id="1"/>', 0)).toEqual({
            name: "at",
            attrs: { id: "1" },
            selfClosing: true,
            end: 11,
        });
    });

    it("普通闭合标签：selfClosing=false，end 指向 > 之后", () => {
        expect(readTag('at id="1">', 0)).toEqual({
            name: "at",
            attrs: { id: "1" },
            selfClosing: false,
            end: 10,
        });
    });

    it("无属性标签", () => {
        expect(readTag("br>", 0)).toEqual({ name: "br", attrs: {}, selfClosing: false, end: 3 });
    });

    it("非法名：空名 + 原位置返回", () => {
        expect(readTag("123>", 0)).toEqual({ name: "", attrs: {}, selfClosing: false, end: 0 });
    });

    it("多属性 + 无值属性 + 单双引号混用", () => {
        const tag = readTag("message forward id=\"f1\" nick='n'>", 0);
        expect(tag.name).toBe("message");
        expect(tag.attrs).toEqual({ forward: "", id: "f1", nick: "n" });
        expect(tag.selfClosing).toBe(false);
    });

    it("实体在属性值内解码", () => {
        expect(readTag('img src="a&amp;b">', 0).attrs["src"]).toBe("a&b");
    });

    it("孤立 '/'（非 />）被跳过不产生属性", () => {
        const tag = readTag("at x=1 / >", 0);
        expect(tag.attrs).toEqual({ x: "1" });
    });
});

describe("readTag 边界补充分支", () => {
    it("未闭合引号（串尾无结束引号）：值到串尾", () => {
        expect(readTag('at id="unclosed', 0)).toEqual({
            name: "at",
            attrs: { id: "unclosed" },
            selfClosing: false,
            end: 15,
        });
    });

    it("属性名非法字符：跳过该字符继续", () => {
        expect(readTag("at ?x=1>", 0)).toEqual({
            name: "at",
            attrs: { x: "1" },
            selfClosing: false,
            end: 8,
        });
    });
});
