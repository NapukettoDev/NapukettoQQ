/**
 * cqcode.ts 基线测试（CQ 码编解码纯函数，fallow 0% 覆盖）
 *
 * 锁定：
 *  - escapeCqText / escapeCqParam / unescapeCqText 转义规则
 *  - encodeCqCode：undefined 参数省略、空参数无逗号
 *  - parseCqMessage：文本与 CQ 码混合解析（文本反转义）
 *  - serializeCqParts：parseCqMessage 的逆操作
 */
import { describe, expect, it } from "vitest";
import {
    encodeCqCode,
    escapeCqParam,
    escapeCqText,
    parseCqMessage,
    serializeCqParts,
    unescapeCqText,
} from "./cqcode.js";

describe("CQ 码转义", () => {
    it("escapeCqText：& [ ] 转义（& 优先避免二次转义）", () => {
        expect(escapeCqText("a&b[c]d")).toBe("a&amp;b&#91;c&#93;d");
    });

    it("escapeCqParam：额外转义逗号", () => {
        expect(escapeCqParam("a,b")).toBe("a&#44;b");
    });

    it("unescapeCqText：逆操作（&amp; 最后解）", () => {
        expect(unescapeCqText("a&#44;b&#93;&#91;&amp;")).toBe("a,b][&");
    });

    it("escape/unescape 往返一致", () => {
        for (const s of ["plain", "a&b[c]d,e", "中文 & 符号"]) {
            expect(unescapeCqText(escapeCqText(s))).toBe(s);
        }
    });
});

describe("encodeCqCode", () => {
    it("无参数 → [CQ:type]", () => {
        expect(encodeCqCode("text", {})).toBe("[CQ:text]");
    });

    it("有参数 → [CQ:type,k=v,...]", () => {
        expect(encodeCqCode("at", { qq: "u1", name: "小明" })).toBe("[CQ:at,qq=u1,name=小明]");
    });

    it("undefined 参数自动省略", () => {
        expect(encodeCqCode("image", { file: "/a.png", url: undefined })).toBe(
            "[CQ:image,file=/a.png]",
        );
    });

    it("参数值转义", () => {
        expect(encodeCqCode("text", { text: "a,b" })).toBe("[CQ:text,text=a&#44;b]");
    });
});

describe("parseCqMessage", () => {
    it("纯文本 → 单文本片段（已反转义）", () => {
        expect(parseCqMessage("你好&amp;")).toEqual(["你好&"]);
    });

    it("单个 CQ 码 → CqCode 对象", () => {
        expect(parseCqMessage("[CQ:at,qq=u1]")).toEqual([{ type: "at", params: { qq: "u1" } }]);
    });

    it("文本 + CQ 码混合 → 混合数组", () => {
        expect(parseCqMessage("hi[CQ:face,id=127]bye")).toEqual([
            "hi",
            { type: "face", params: { id: "127" } },
            "bye",
        ]);
    });

    it("CQ 码参数反转义（&#44; → ,）", () => {
        expect(parseCqMessage("[CQ:text,text=a&#44;b]")).toEqual([
            { type: "text", params: { text: "a,b" } },
        ]);
    });

    it("连续 CQ 码", () => {
        expect(parseCqMessage("[CQ:a][CQ:b,x=1]")).toEqual([
            { type: "a", params: {} },
            { type: "b", params: { x: "1" } },
        ]);
    });

    it("无闭合 ] → 剩余整体按纯文本（对抗输入不回溯）", () => {
        expect(parseCqMessage("[CQ:")).toEqual(["[CQ:"]);
        expect(parseCqMessage("hi[CQ:at")).toEqual(["hi[CQ:at"]);
        expect(parseCqMessage("[CQ:[CQ:[CQ:")).toEqual(["[CQ:[CQ:[CQ:"]);
    });

    it("嵌套 [CQ: 前缀 → 外层吞到第一个 ]", () => {
        expect(parseCqMessage("[CQ:a[CQ:b]")).toEqual([{ type: "a[CQ:b", params: {} }]);
    });

    it("空串 → 空数组", () => {
        expect(parseCqMessage("")).toEqual([]);
    });
});

describe("serializeCqParts（parseCqMessage 逆操作）", () => {
    it("混合片段 → 消息文本", () => {
        const parts = parseCqMessage("hi[CQ:face,id=127]bye");
        expect(serializeCqParts(parts)).toBe("hi[CQ:face,id=127]bye");
    });

    it("纯文本片段转义后序列化", () => {
        expect(serializeCqParts(["a&b"])).toBe("a&amp;b");
    });

    it("往返一致：parse → serialize → 原消息", () => {
        const msg = "你好[CQ:at,qq=u1,name=小明]再见[CQ:text,text=a&#44;b]";
        expect(serializeCqParts(parseCqMessage(msg))).toBe(msg);
    });
});
