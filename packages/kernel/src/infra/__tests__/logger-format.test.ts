/**
 * createLogger 格式与级别测试（2026-10-25 日志可配置化）。
 *
 * 覆盖：single-line k=v 渲染 / json NDJSON 契约（time/level/module/account）/
 * 级别过滤 / 控制台与文件分级 / elapsed 时间标签 / colorize 关闭无 ANSI。
 * 时间戳单调钟（免 Date 篡改）以行为验证：篡改 Date.now 后记录时间仍前进。
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

/** 等待渲染流落盘（pino-pretty/结构化流可能异步 flush）。 */
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
