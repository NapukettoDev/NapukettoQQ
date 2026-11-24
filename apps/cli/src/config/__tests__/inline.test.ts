/**
 * inline.test.ts：内联配置（NAPUKETTO_CONFIG_JSON）宽松读取口径单测。
 *
 * 覆盖（补充 source.test.ts 之外的边角）：isInlineConfigActive 与
 * readInlineConfigSection（logger 读 [log] 段路径）：坏文档不阻塞（返回
 * undefined）、合法文档取段、键缺失、数组建档、空串回退。
 */
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inlineConfigEnvName, isInlineConfigActive, readInlineConfigSection } from "../inline.js";

beforeEach(() => {
    delete process.env["NAPUKETTO_CONFIG_JSON"];
});

afterEach(() => {
    delete process.env["NAPUKETTO_CONFIG_JSON"];
});

describe("inlineConfigEnvName（来源日志键名）", () => {
    it("未设置 / 纯空白 → undefined", () => {
        expect(inlineConfigEnvName()).toBeUndefined();
        process.env["NAPUKETTO_CONFIG_JSON"] = "   ";
        expect(inlineConfigEnvName()).toBeUndefined();
    });

    it("规范键生效 → 输出规范键名", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = '{"accounts":[]}';
        expect(inlineConfigEnvName()).toBe("NAPUKETTO_CONFIG_JSON");
    });

    it("已废弃旧前缀键（NAPKETTO_* / NAPUTO_*）不再生效", () => {
        process.env["NAPKETTO_CONFIG_JSON"] = '{"accounts":[]}';
        process.env["NAPUTO_CONFIG_JSON"] = '{"accounts":[]}';
        try {
            expect(inlineConfigEnvName()).toBeUndefined();
            expect(isInlineConfigActive()).toBe(false);
        } finally {
            delete process.env["NAPKETTO_CONFIG_JSON"];
            delete process.env["NAPUTO_CONFIG_JSON"];
        }
    });
});

describe("isInlineConfigActive", () => {
    it("未设置 / 空串 → false（回退文件形态）", () => {
        expect(isInlineConfigActive()).toBe(false);
        process.env["NAPUKETTO_CONFIG_JSON"] = "   ";
        expect(isInlineConfigActive()).toBe(false);
    });

    it("非空文本 → true（即使 JSON 非法，主配置路径再严格报错）", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = "{bad json";
        expect(isInlineConfigActive()).toBe(true);
    });
});

describe("readInlineConfigSection（宽松口径，logger 读 [log] 段）", () => {
    it("未设置 → undefined", () => {
        expect(readInlineConfigSection("log")).toBeUndefined();
    });

    it("合法文档 → 返回对应段对象", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = '{"log":{"level":"warn"},"other":1}';
        expect(readInlineConfigSection("log")).toEqual({ level: "warn" });
    });

    it("键缺失 → undefined（不抛错）", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = '{"accounts":[{"qq":"10086"}]}';
        expect(readInlineConfigSection("log")).toBeUndefined();
    });

    it("JSON 解析失败 → undefined（坏文档不阻塞启动）", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = "not-json";
        expect(readInlineConfigSection("log")).toBeUndefined();
    });

    it("文档为数组（非对象）→ undefined", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = "[1,2,3]";
        expect(readInlineConfigSection("log")).toBeUndefined();
    });

    it("文档为原始值 → undefined", () => {
        process.env["NAPUKETTO_CONFIG_JSON"] = '"just a string"';
        expect(readInlineConfigSection("log")).toBeUndefined();
    });
});
