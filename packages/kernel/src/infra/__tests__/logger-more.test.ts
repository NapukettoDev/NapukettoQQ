/**
 * logger.ts createLogger 分支补充（logger-format.test.ts 之外）：
 *  - 目的地校验：console=false 且无 file → INVALID_PARAM
 *  - 纯文件模式：恒 JSON 行 + 数值时间；fileLevel 独立设级
 *  - 格式自动：TTY → pretty + 缺省着色；pipe → single-line 不着色
 *  - redact 内置 + 追加路径；base 字段保留（pid + 自定义）
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";

const tmpDirs: string[] = [];
afterAll(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function captureStream(isTty = false): { lines: string[]; stream: NodeJS.WriteStream } {
    const lines: string[] = [];
    const stream = {
        write(chunk: string) {
            lines.push(chunk);
        },
        isTTY: isTty,
    } as unknown as NodeJS.WriteStream;
    return { lines, stream };
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

function tmpFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "nk-test-logger-"));
    tmpDirs.push(dir);
    return join(dir, name);
}

describe("目的地校验", () => {
    it("console=false 且未配置 file → INVALID_PARAM（无处可写）", () => {
        expect(() => createLogger({ console: false })).toThrow(/logger 至少需要一个输出目标/);
    });
});

describe("纯文件模式", () => {
    it("console=false + file：文件为 JSON 行 + 数值时间戳；父目录自动创建", async () => {
        const file = tmpFile("deep/nested/app.log");
        const logger = createLogger({ console: false, file, level: "info" });
        logger.info({ k: 1 }, "文件行");
        await settle();
        const raw = readFileSync(file, "utf8");
        const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
        expect(parsed["k"]).toBe(1);
        expect(parsed["msg"]).toBe("文件行");
        expect(typeof parsed["time"]).toBe("number");
    });

    it("fileLevel 低于控制台级别：info 只进文件不进控制台", async () => {
        const file = tmpFile("lv.log");
        const { lines, stream } = captureStream();
        const logger = createLogger({
            level: "warn",
            fileLevel: "debug",
            file,
            destination: stream,
        });
        logger.info("只进文件");
        logger.warn("两边都进");
        await settle();
        const fileRaw = readFileSync(file, "utf8");
        expect(fileRaw).toContain("只进文件");
        expect(fileRaw).toContain("两边都进");
        expect(lines.join("")).toContain("两边都进");
        expect(lines.join("")).not.toContain("只进文件");
    });

    it("fileLevel 未设置时跟随 level（warn 文件不收 info）", async () => {
        const file = tmpFile("follow.log");
        const logger = createLogger({ console: false, file, level: "warn" });
        logger.info("不该落盘");
        await settle();
        expect(readFileSync(file, "utf8")).not.toContain("不该落盘");
    });
});

describe("格式自动（TTY 探测）", () => {
    it("isTTY=true 且未显式指定 → pretty + 缺省着色", async () => {
        const { lines, stream } = captureStream(true);
        const logger = createLogger({ destination: stream });
        logger.info("tty 行");
        await settle();
        const text = lines.join("");
        expect(text).toContain("\u001b["); // pretty 头部 DIM
        expect(text).toContain("\u001b[36mtty 行\u001b[0m"); // 消息青色
    });

    it("isTTY=false → single-line 且不着色（pipe 形态）", async () => {
        const { lines, stream } = captureStream(false);
        const logger = createLogger({ destination: stream });
        logger.info("pipe 行");
        await settle();
        const text = lines.join("");
        expect(text).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO/);
        expect(text).not.toContain("\u001b[");
    });

    it("显式 format 覆盖 TTY 探测（TTY 上强制 single-line 也不着色）", async () => {
        const { lines, stream } = captureStream(true);
        const logger = createLogger({
            destination: stream,
            format: "single-line",
            colorize: false,
        });
        logger.info("强制");
        await settle();
        expect(lines.join("")).not.toContain("\u001b[");
    });
});

describe("redact", () => {
    it("内置路径（token/cookie 等）不输出；追加路径同样生效", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            destination: stream,
            format: "single-line",
            redact: ["mySecret"],
        });
        logger.info(
            { token: "sekrit-token", cookie: "sekrit-cookie", mySecret: "sekrit-s", ok: 1 },
            "带敏感字段",
        );
        await settle();
        const text = lines.join("");
        expect(text).not.toContain("sekrit-token");
        expect(text).not.toContain("sekrit-cookie");
        expect(text).not.toContain("sekrit-s");
        expect(text).toContain("[Redacted]");
        expect(text).toContain("ok=1");
    });
});

describe("base 字段", () => {
    it("自定义 base 保留（name 进元数据头），pid 恒注入", async () => {
        const { lines, stream } = captureStream();
        const logger = createLogger({
            destination: stream,
            format: "single-line",
            base: { name: "kernel", service: "svc" },
        });
        logger.info("base 行");
        await settle();
        const text = lines.join("");
        expect(text).toContain("(kernel/");
        expect(text).toContain("service=svc");
    });
});
