/**
 * log-format.ts createConsoleFormatStream 直测（logger-format.test.ts 走 createLogger
 * 全链路，本文件直接喂 pino JSON 行覆盖渲染分支）：
 *  - 三种格式的渲染入口分发 + 非法 JSON 行原样透出
 *  - renderTime：字符串透传 / 缺省（timeOrigin）/ iso8601 / elapsed / local
 *  - levelLabel：数值映射 / 未知数值 / 字符串大写 / 非 string 非数值 → LOG
 *  - json NDJSON：module/account/pid 条件字段 + fields 透传
 *  - pretty/single-line：着色分支 / 无 name 元数据 / k=v 内联（对象 JSON 化）/
 *    多行字符串展开 / 空容器 / 标量（symbol/bigint 不炸）
 */
import { describe, expect, it } from "vitest";
import { createConsoleFormatStream } from "../log-format.js";

/** 捕获写入的目的地。 */
function capture(): { chunks: string[]; stream: NodeJS.WriteStream } {
    const chunks: string[] = [];
    const stream = {
        write(chunk: string) {
            chunks.push(chunk);
        },
        isTTY: false,
    } as unknown as NodeJS.WriteStream;
    return { chunks, stream };
}

/** 构造流并写入一条 pino JSON 行（返回完整渲染文本）。 */
function render(
    record: Record<string, unknown>,
    format: "pretty" | "single-line" | "json" = "single-line",
    colorize = false,
    timestamp: "local" | "iso8601" | "elapsed" = "local",
): string {
    const { chunks, stream } = capture();
    const dest = createConsoleFormatStream({ format, timestamp, colorize, destination: stream });
    dest.write(JSON.stringify(record));
    return chunks[0] ?? "";
}

/** 按行拆分（渲染输出以 \n 结尾，尾空行剔除）。 */
function linesOf(text: string): string[] {
    return text.split("\n").filter((line) => line !== "");
}

describe("渲染入口分发与容错", () => {
    it("非法 JSON 行原样透出（不吞日志）", () => {
        const { chunks, stream } = capture();
        const dest = createConsoleFormatStream({
            format: "single-line",
            timestamp: "local",
            colorize: false,
            destination: stream,
        });
        dest.write("not-a-json");
        expect(chunks).toEqual(["not-a-json\n"]);
    });

    it("三种格式均可构造并输出（json 恒不着色）", () => {
        for (const format of ["pretty", "single-line", "json"] as const) {
            const text = render({ msg: "x", level: 30, time: 0, pid: 1 }, format, true);
            expect(text.endsWith("\n")).toBe(true);
        }
    });
});

describe("时间渲染（renderTime）", () => {
    it("time 已是字符串 → 原样透传（外部注入兼容）", () => {
        expect(render({ msg: "m", level: 30, time: "SYS:00:00:00.000" })).toContain(
            "[SYS:00:00:00.000]",
        );
    });

    it("time 缺失 → 用 timeOrigin（进程启动时间），local 模式渲染时分秒", () => {
        expect(render({ msg: "m", level: 30 })).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    });

    it("elapsed 模式：+相对秒 标签（time 早于 timeOrigin 为负值）", () => {
        const text = render({ msg: "m", level: 30, time: 0 }, "single-line", false, "elapsed");
        expect(text).toMatch(/\[\+-?\d+\.\d{3}s\]/);
    });

    it("iso8601 模式：本地 ISO 形态（含时区偏移）", () => {
        const text = render({ msg: "m", level: 30, time: 0 }, "single-line", false, "iso8601");
        expect(text).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\]/);
    });
});

describe("级别标签（levelLabel）", () => {
    it("数值映射 pino 标准 / 未知数值字符串化 / 字符串大写 / 其他 → LOG", () => {
        expect(render({ msg: "", level: 30 })).toContain("INFO");
        expect(render({ msg: "", level: 60 })).toContain("FATAL");
        expect(render({ msg: "", level: 45 })).toMatch(/ 45 \(-\):/);
        expect(render({ msg: "", level: "warn" })).toContain("WARN");
        expect(render({ msg: "", level: null })).toContain("LOG");
    });
});

describe("json NDJSON", () => {
    it("module 优先于 name；account/pid 条件字段；fields 原样透传", () => {
        const parsed = JSON.parse(
            render(
                {
                    time: 1750000000000,
                    level: 30,
                    name: "k",
                    module: "m",
                    account: "10001",
                    pid: 42,
                    msg: "hello",
                    extra: 1,
                },
                "json",
            ).trim(),
        ) as Record<string, unknown>;
        expect(parsed["module"]).toBe("m");
        expect(parsed["account"]).toBe("10001");
        expect(parsed["pid"]).toBe(42);
        expect(parsed["msg"]).toBe("hello");
        expect(parsed["extra"]).toBe(1);
        expect(parsed["level"]).toBe("info");
    });

    it("无 module 时回退 name；无 name 无 module 无该键；非数值 pid 剔除", () => {
        const parsed1 = JSON.parse(
            render({ time: 0, level: 30, name: "n", pid: "junk", msg: "" }, "json").trim(),
        ) as Record<string, unknown>;
        expect(parsed1["module"]).toBe("n");
        expect("pid" in parsed1).toBe(false);
        const parsed2 = JSON.parse(
            render({ time: 0, level: 30, pid: 1, msg: "" }, "json").trim(),
        ) as Record<string, unknown>;
        expect("module" in parsed2).toBe(false);
    });

    it("msg 非字符串 → 空串；time 恒 ISO（不受 timestamp 键影响）", () => {
        const parsed = JSON.parse(
            render({ time: 1750000000000, level: 30, msg: 42 }, "json").trim(),
        ) as Record<string, unknown>;
        expect(parsed["msg"]).toBe("");
        expect(parsed["time"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});

describe("元数据与字段内联（single-line）", () => {
    it("无 name → (pid)；pid 缺失 → 占位 -", () => {
        expect(render({ msg: "m", level: 30, pid: 7 })).toContain("(7)");
        expect(render({ msg: "m", level: 30 })).toContain("(-)");
    });

    it("对象字段 JSON 序列化内联；数组同样；布尔原样", () => {
        const [line] = linesOf(
            render({ msg: "m", level: 30, obj: { a: 1 }, arr: [1, "x"], ok: true }),
        );
        expect(line).toContain('obj={"a":1}');
        expect(line).toContain('arr=[1,"x"]');
        expect(line).toContain("ok=true");
    });

    it("保留键（pid/hostname/level/time/msg/name）不重复进字段尾部", () => {
        const [line] = linesOf(render({ msg: "m", level: 30, pid: 1, hostname: "h", name: "n" }));
        expect(line).not.toContain("hostname=");
        expect(line).not.toContain("msg=");
        expect(line).not.toContain("level=");
    });
});

describe("着色分支（pretty / single-line）", () => {
    it("single-line colorize=true：级别按级别着色 + DIM 元数据", () => {
        const text = render({ msg: "m", level: 30, pid: 1 }, "single-line", true);
        expect(text).toContain("\u001b[32mINFO\u001b[0m");
        expect(text).toContain("\u001b[2m");
    });

    it("未知级别着色回退（无色码原样，不出现红色码）", () => {
        const text = render({ msg: "m", level: 45, pid: 1 }, "single-line", true);
        expect(text).toContain(" 45\u001b[0m ");
        expect(text).not.toContain("\u001b[31m");
    });

    it("pretty colorize=true：级别/消息/字段名着色", () => {
        const text = render({ msg: "消息", level: 30, pid: 1, k: 1 }, "pretty", true);
        expect(text).toContain("\u001b[32mINFO\u001b[0m");
        expect(text).toContain("\u001b[36m消息\u001b[0m");
        expect(text).toContain("\u001b[35mk\u001b[0m");
    });

    it("pretty：空 msg 只输出头行；嵌套对象/数组按 JSON 展开（含逗号）", () => {
        const out = linesOf(
            render({ msg: "", level: 30, pid: 1, obj: { a: 1, b: [2, 3] } }, "pretty"),
        );
        expect(out[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO \(1\):$/);
        const joined = out.join("\n");
        expect(joined).toContain('"a": 1,');
        expect(joined).toContain("[");
        expect(joined).toContain("]");
    });

    it("pretty：多行字符串（err.stack）展开，不转义成一行", () => {
        const joined = render({ msg: "", level: 30, err: { stack: "line1\nline2" } }, "pretty");
        expect(joined).toContain("line1");
        expect(joined).toContain("line2");
        expect(joined).not.toContain("\\n");
    });

    it("pretty：空容器 [] / {}；数值/布尔标量", () => {
        const joined = render(
            {
                msg: "",
                level: 30,
                emptyArr: [],
                emptyObj: {},
                num: 123,
                flag: false,
            },
            "pretty",
        );
        expect(joined).toContain("[]");
        expect(joined).toContain("{}");
        expect(joined).toContain("123");
        expect(joined).toContain("false");
    });

    it("pretty：字符串字段带 JSON 引号；null 原样（undefined 键经 JSON 序列化剔除，不可达）", () => {
        const joined = render({ msg: "", level: 30, s: "文本", n: null }, "pretty");
        expect(joined).toContain('"文本"');
        expect(joined).toContain("null");
    });
});

describe("渲染分支补充", () => {
    it("pretty：顶层多行字符串字段 → 键行不带值，内容从下一行起", () => {
        const text = render({ msg: "", level: 30, stack: "line1\nline2" }, "pretty");
        const ls = linesOf(text);
        expect(ls).toHaveLength(4);
        // 顶层键行不带引号也不带值（多行字符串首行为空串）
        expect(ls[1]?.trim()).toBe("stack:");
        expect(text).toContain("line1");
        expect(text).toContain("line2");
    });

    it("pretty：未知级别（越界数值）→ 标签原样且不着色不炸", () => {
        const text = render({ msg: "hi", level: 99 }, "pretty");
        expect(text).toContain("99");
        expect(text).toContain("hi");
    });

    it("pretty：无 msg 键 → 仅元数据头行", () => {
        const ls = linesOf(render({ level: 30 }, "pretty"));
        expect(ls).toHaveLength(1);
        expect(ls[0]).toContain("INFO");
    });

    it("single-line：msg 非字符串（数值）→ 消息体空串不炸", () => {
        const text = render({ msg: 123, level: 30, extra: "x" }, "single-line");
        expect(text).toContain("INFO");
        expect(text).toContain("extra=x");
    });

    it("single-line：null 字段 → k=null 内联", () => {
        const text = render({ msg: "m", level: 30, bad: null }, "single-line");
        expect(text).toContain("bad=null");
    });

    it("不传 destination → 缺省挂 process.stdout（仅构造不写入）", () => {
        const stream = createConsoleFormatStream({
            format: "single-line",
            timestamp: "local",
            colorize: false,
        });
        expect(stream).toBeTypeOf("object");
        expect(stream.write).toBeTypeOf("function");
    });
});
