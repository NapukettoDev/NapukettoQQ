/**
 * lines.test.ts：子进程输出逐行切分（forwardLines）单测。
 *
 * 覆盖：跨 chunk 拼行、CRLF 归一、UTF-8 多字节跨 chunk、空行保留、EOF 无换行
 * 末行、单行缓冲上限截断（含分块无换行场景）与解绑函数。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { forwardLines, MAX_LINE_LENGTH } from "../../src/runtime/lines.js";

/** 冲刷流事件队列（PassThrough 的 data 事件在下一 tick 派发）。 */
function flush(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

/** 建流 + 收集行；maxLineLength 缺省时用模块常量。 */
function collect(maxLineLength?: number): {
    input: PassThrough;
    lines: string[];
    dispose: () => void;
} {
    const input = new PassThrough();
    const lines: string[] = [];
    const dispose = forwardLines(input, (line) => lines.push(line), maxLineLength);
    return { input, lines, dispose };
}

describe("forwardLines 逐行切分", () => {
    it("跨 chunk 拼行，换行后逐行回调", async () => {
        const { input, lines } = collect();
        input.write("hel");
        input.write("lo\nwor");
        input.write("ld\n");
        await flush();
        expect(lines).toEqual(["hello", "world"]);
    });

    it("CRLF 归一为单行（去掉 \\r）", async () => {
        const { input, lines } = collect();
        input.write("a\r\nb\n");
        await flush();
        expect(lines).toEqual(["a", "b"]);
    });

    it("空行保留（与 readline 行为一致）", async () => {
        const { input, lines } = collect();
        input.write("\n\n");
        await flush();
        expect(lines).toEqual(["", ""]);
    });

    it("UTF-8 多字节字符跨 chunk 正确解码", async () => {
        const { input, lines } = collect();
        const bytes = Buffer.from("你好\n");
        input.write(bytes.subarray(0, 1));
        input.write(bytes.subarray(1, 4));
        input.write(bytes.subarray(4));
        await flush();
        expect(lines).toEqual(["你好"]);
    });

    it("EOF 无换行的末行也回调", async () => {
        const { input, lines } = collect();
        input.write("tail");
        input.end();
        await flush();
        expect(lines).toEqual(["tail"]);
    });

    it("dispose 后不再转发", async () => {
        const { input, lines, dispose } = collect();
        dispose();
        input.write("after\n");
        await flush();
        expect(lines).toEqual([]);
    });
});

describe("forwardLines 无换行超长行防护", () => {
    it("常量上限为 64 KiB（正常日志行足够宽松）", () => {
        expect(MAX_LINE_LENGTH).toBe(64 * 1024);
    });

    it("超长行截断到上限并补标记，后续行照常转发", async () => {
        const { input, lines } = collect(8);
        input.write("1234567890abcdef\nnext\n");
        await flush();
        expect(lines).toEqual(["12345678…[truncated]", "next"]);
    });

    it("分块且始终无换行：只保留上限前缀，EOF 时输出截断行", async () => {
        const { input, lines } = collect(5);
        input.write("12345678");
        input.write("90");
        input.end();
        await flush();
        expect(lines).toEqual(["12345…[truncated]"]);
    });

    it("恰好等于上限的行不截断", async () => {
        const { input, lines } = collect(5);
        input.write("12345\n");
        await flush();
        expect(lines).toEqual(["12345"]);
    });
});
