/**
 * createLogger 格式与级别测试（2026-10-25 日志可配置化；2026-11-03 pretty 自渲染）。
 *
 * 覆盖：pretty 多行布局/着色/err.stack 展开 / single-line k=v 渲染 / json NDJSON
 * 契约（time/level/module/account）/ 级别过滤 / 控制台与文件分级 / elapsed 时间标签 /
 * colorize 关闭无 ANSI。时间戳单调钟（免 Date 篡改）以行为验证：篡改 Date.now 后记录
 * 时间仍前进。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";

/** 捕获写入的目的地（isTTY=false → 缺省格式 single-line）。 */
function captureStream(): { lines: string[]; stream: NodeJS.WriteStream } {
    const lines: string[] = [];
    const stream = {
        write(chunk: string) {
            lines.push(chunk);
        },
        isTTY: false,
    } as unknown as NodeJS.WriteStream;
    return { lines, stream };
}

/** 等待渲染流落盘（渲染流同步写，留一拍给 multistream / 文件 sink）。 */
async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

const tmpDirs: string[] = [];
afterAll(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tmpFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "napuketto-log-test-"));
    tmpDirs.push(dir);
    return join(dir, name);
}

describe("createLogger single-line", () => {
    it("对象字段内联 k=v，一条记录一行", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            format: "single-line",
            destination: stream,
            base: { name: "cli", service: "cli" },
        });
        logger.info({ qq: "3567141148", restartCount: 0 }, "启动账号");
        await settle();
        expect(lines).toHaveLength(1);
        const line = lines[0] ?? "";
        expect(line).toMatch(/^\[[\d:.]+\] INFO \(cli\/\d+\): 启动账号 /);
        expect(line).toContain("qq=3567141148");
        expect(line).toContain("restartCount=0");
        expect(line).toContain("service=cli");
        expect(line.endsWith("\n")).toBe(true);
    });

    it("colorize=false 时无 ANSI 转义", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            format: "single-line",
            colorize: false,
            destination: stream,
        });
        logger.warn("告警行");
        await settle();
        expect(lines[0]).not.toContain("\u001b[");
    });

    it("elapsed 时间标签渲染 +SS.SSSs", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            format: "single-line",
            timestamp: "elapsed",
            destination: stream,
        });
        logger.info("相对时间");
        await settle();
        expect(lines[0]).toMatch(/^\[\+\d+\.\d{3}s\] INFO /);
    });
});

describe("createLogger pretty", () => {
    it("多行布局：头部 + 4 空格字段 + 嵌套按 JSON 展开", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            format: "pretty",
            colorize: false,
            destination: stream,
            base: { name: "cli" },
        });
        logger.info({ qq: "3567141148", nested: { retry: 3, list: [1, 2] } }, "启动账号");
        await settle();
        expect(lines).toHaveLength(1);
        const out = lines[0] ?? "";
        expect(out).toMatch(/^\[[\d:.]+\] INFO \(cli\/\d+\): 启动账号\n/);
        expect(out).toContain('\n    qq: "3567141148"\n');
        expect(out).toContain(
            '\n    nested: {\n      "retry": 3,\n      "list": [\n        1,\n        2\n      ]\n    }\n',
        );
        expect(out.endsWith("\n")).toBe(true);
    });

    it("err.stack 多行展开（不转义成一行 \\n）", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({ format: "pretty", colorize: false, destination: stream });
        logger.error({ err: new Error("boom") }, "失败");
        await settle();
        const out = lines[0] ?? "";
        // pino 的 err 序列化给出 {type, message, stack}；stack 换行后逐行缩进展开
        expect(out).toContain(
            '    err: {\n      "type": "Error",\n      "message": "boom",\n      "stack":\n          Error: boom\n',
        );
        expect(out).not.toContain("\\n");
    });

    it("colorize=true 时级别/消息/字段名着色，续行不着色", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({ format: "pretty", colorize: true, destination: stream });
        logger.info({ qq: "1" }, "启动账号");
        await settle();
        const out = lines[0] ?? "";
        expect(out).toContain("\u001b[32mINFO\u001b[0m"); // 级别绿
        expect(out).toContain("\u001b[36m启动账号\u001b[0m"); // 消息青
        expect(out).toContain("\u001b[35mqq\u001b[0m: "); // 字段名紫
    });

    it("elapsed 时间戳渲染为 +SS.SSSs（文件仍是数值时间）", async () => {
        const file = tmpFile("pretty-elapsed.log");
        const { lines, stream } = captureStream();
        const logger = createLogger({
            format: "pretty",
            timestamp: "elapsed",
            destination: stream,
            file,
        });
        logger.info("相对时间");
        await settle();
        expect(lines[0]).toMatch(/^\[\+\d+\.\d{3}s\] INFO /);
        const rec = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>;
        expect(typeof rec["time"]).toBe("number");
    });
});

describe("createLogger json", () => {
    it("NDJSON 契约：逐行可 parse，time/level/module/account/pid/msg 齐全", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            format: "json",
            destination: stream,
            base: { name: "loader", account: "3567141148" },
        });
        logger.info({ peerUin: "978515338" }, "接收 <- 群聊");
        await settle();
        expect(lines).toHaveLength(1);
        const rec = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
        expect(rec["level"]).toBe("info");
        expect(rec["module"]).toBe("loader");
        expect(rec["account"]).toBe("3567141148");
        expect(typeof rec["pid"]).toBe("number");
        expect(rec["msg"]).toBe("接收 <- 群聊");
        expect(rec["peerUin"]).toBe("978515338");
        // time 恒为 ISO8601 带本地偏移
        expect(String(rec["time"])).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
        );
    });

    it("child 的 module 字段优先于 name", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            level: "debug",
            format: "json",
            destination: stream,
            base: { name: "loader" },
        });
        logger.child({ module: "ob11" }).debug({ raw: "0a40" }, "校准");
        await settle();
        const rec = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
        expect(rec["module"]).toBe("ob11");
        expect(rec["level"]).toBe("debug");
        expect(rec["name"]).toBeUndefined();
    });
});

describe("createLogger 级别", () => {
    it("level=warn 过滤 info，warn 放行", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({ level: "warn", format: "single-line", destination: stream });
        logger.info("被过滤");
        logger.warn("保留");
        await settle();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("保留");
    });

    it("控制台 warn / 文件 debug 双级别：info 只落文件", async () => {
        const file = tmpFile("dual.log");
        const { lines, stream } = captureStream();
        const logger = createLogger({
            level: "warn",
            fileLevel: "debug",
            file,
            format: "single-line",
            destination: stream,
        });
        logger.info("只进文件");
        logger.warn("两边都进");
        await settle();
        expect(lines.filter((l) => l.includes("只进文件"))).toHaveLength(0);
        expect(lines.filter((l) => l.includes("两边都进"))).toHaveLength(1);
        const fileText = readFileSync(file, "utf8");
        expect(fileText).toContain("只进文件");
        expect(fileText).toContain("两边都进");
    });
});

describe("createLogger 时间源", () => {
    it("Date.now 被篡改后记录时间仍单调前进（单调钟）", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({ format: "json", destination: stream });
        logger.info("第一条");
        const realDateNow = Date.now;
        Date.now = () => 0;
        try {
            logger.info("第二条");
        } finally {
            Date.now = realDateNow;
        }
        await settle();
        const first = JSON.parse(lines[0] ?? "") as { time: string };
        const second = JSON.parse(lines[1] ?? "") as { time: string };
        // 篡改窗口内的记录不回退到假钟（Date.now()=0 → 1970），且不早于前一条
        expect(new Date(second.time).getFullYear()).toBeGreaterThan(2000);
        expect(new Date(second.time).getTime()).toBeGreaterThanOrEqual(
            new Date(first.time).getTime(),
        );
    });
});
