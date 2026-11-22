import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { kernelError } from "../errors.js";
import { redactLogLine } from "../log-redaction.js";
import { createLogger } from "../logger.js";

const SENSITIVE_KEYS = [
    "token",
    "access_token",
    "authorization",
    "cookie",
    "password",
    "secret",
    "ticket",
    "Authorization",
    "Cookie",
    "Set-Cookie",
    "cookies",
    "clientKey",
    "skey",
    "p_skey",
    "csrf_token",
    "bkn",
    "qrcodeUrl",
    "qr_code_url",
];

/** 全部使用虚构凭据；不同位置给不同值，避免一次替换掩盖其他泄漏。 */
function credentials(scope: string): Record<string, string> {
    return Object.fromEntries(SENSITIVE_KEYS.map((key) => [key, `fake-h03-${scope}-${key}`]));
}

function censored(): Record<string, string> {
    return Object.fromEntries(SENSITIVE_KEYS.map((key) => [key, "[Redacted]"]));
}

function capture(): { chunks: string[]; destination: NodeJS.WriteStream } {
    const chunks: string[] = [];
    // 只模拟 createLogger 所需的输出目的地面。
    const destination = { isTTY: false, write: (chunk: string) => chunks.push(chunk) };
    return { chunks, destination: destination as unknown as NodeJS.WriteStream };
}

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("createLogger 结构化凭据脱敏", () => {
    it("非法序列化结果抛类型化错误，诊断和 cause 不包含原始记录", () => {
        const malformed = '{"token":"fake-h03-malformed"';
        let failure: unknown;
        try {
            redactLogLine(malformed);
        } catch (err) {
            failure = err;
        }
        expect(failure).toMatchObject({
            name: "KernelError",
            code: "INVALID_STATE",
            message: "日志结构化脱敏失败",
        });
        expect(failure).not.toHaveProperty("cause");
    });

    it.each(["json", "single-line", "pretty"] as const)(
        "%s 控制台与 JSON 文件覆盖顶层、嵌套对象及账号/传输数组，并保留诊断字段",
        (format) => {
            const dir = mkdtempSync(join(tmpdir(), "napuketto-redaction-"));
            dirs.push(dir);
            const file = join(dir, "output.log");
            const { chunks, destination } = capture();
            const logger = createLogger({ format, colorize: false, destination, file });
            const payload = {
                ...credentials("root"),
                headers: { ...credentials("headers"), "content-type": "application/json" },
                config: {
                    ...credentials("config"),
                    accounts: [
                        {
                            qq: "10001",
                            onebot11: {
                                token: "fake-h03-global-ob11",
                                httpServers: [{ port: 3000, token: "fake-h03-instance-ob11" }],
                            },
                            milky: { token: "fake-h03-milky", port: 3001 },
                            satori: { token: "fake-h03-satori" },
                            kurobot: { token: "fake-h03-kurobot", url: "wss://example.invalid/ws" },
                        },
                    ],
                },
                state: "ready",
                retry: 2,
            };
            const before = structuredClone(payload);
            logger.info(payload, "protocol ready");

            for (const output of [chunks.join(""), readFileSync(file, "utf8")]) {
                expect(output).not.toContain("fake-h03-");
                expect(output).toContain("[Redacted]");
                expect(output).toContain("10001");
                expect(output).toContain("3000");
                expect(output).toContain("protocol ready");
                expect(output).toContain("ready");
            }
            const record: Record<string, unknown> = JSON.parse(readFileSync(file, "utf8"));
            expect(record).toMatchObject({
                ...censored(),
                headers: { ...censored(), "content-type": "application/json" },
                config: { ...censored(), accounts: [{ qq: "10001", milky: { port: 3001 } }] },
                state: "ready",
                retry: 2,
            });
            expect(payload).toEqual(before);
        },
    );

    it("base、child、孙级 child 与 setBindings 都不能绕过默认保护，附加路径仍生效", () => {
        const { chunks, destination } = capture();
        const base = { module: "kernel", config: credentials("base") };
        const logger = createLogger({
            format: "json",
            destination,
            base,
            redact: ["diagnostic.privateValue"],
        });
        const bindings = { module: "ob11", config: credentials("child") };
        const child = logger.child(bindings);
        child.setBindings({ session: { ...credentials("bindings"), id: 42 } });
        child.child({ headers: credentials("grandchild") }).info(
            {
                diagnostic: { privateValue: "fake-h03-custom-path", duration: 12 },
            },
            "child ready",
        );
        expect(chunks.join("")).not.toContain("fake-h03-");
        const record: Record<string, unknown> = JSON.parse(chunks[0] ?? "");
        expect(record).toMatchObject({
            module: "ob11",
            config: censored(),
            headers: censored(),
            session: { ...censored(), id: 42 },
            diagnostic: { privateValue: "[Redacted]", duration: 12 },
        });
        expect(base.config).toEqual(credentials("base"));
        expect(bindings.config).toEqual(credentials("child"));
        // child 的 pino 自定义 redact 配置也不得禁用内置保护。
        logger.child({ token: "fake-h03-child-override" }, { redact: [] }).info("override");
        expect(chunks.join("")).not.toContain("fake-h03-");
    });

    it("Error 自有字段、结构化 cause 与普通错误对象脱敏，同时保留类型/堆栈/错误码", () => {
        const { chunks, destination } = capture();
        const logger = createLogger({ format: "json", destination });
        const cause = Object.assign(new Error("upstream failed"), {
            request: { headers: credentials("cause") },
            code: "ECONNRESET",
        });
        const err = Object.assign(kernelError("request failed", "UNKNOWN", { cause }), {
            ...credentials("error"),
            config: credentials("error-config"),
        });
        logger.error(
            { err, error: { ...credentials("plain-error"), status: 503 } },
            "request failed",
        );
        logger.error(err);
        expect(chunks.join("")).not.toContain("fake-h03-");
        const record: Record<string, unknown> = JSON.parse(chunks[0] ?? "");
        expect(record).toMatchObject({
            err: {
                ...censored(),
                type: "KernelError",
                message: "request failed",
                code: "UNKNOWN",
                stack: expect.stringContaining("request failed"),
                config: censored(),
                cause: {
                    type: "Error",
                    message: "upstream failed",
                    code: "ECONNRESET",
                    stack: expect.stringContaining("upstream failed"),
                    request: { headers: censored() },
                },
            },
            error: { ...censored(), status: 503 },
        });
        expect(err).toMatchObject(credentials("error"));
        expect(cause.request.headers).toEqual(credentials("cause"));
    });

    it("序列化后的深层结构与 toJSON / child serializer 产物同样受保护", () => {
        const { chunks, destination } = capture();
        const logger = createLogger({ format: "json", destination });
        let deep: unknown = { ...credentials("deep"), status: "retained" };
        for (let i = 0; i < 40; i += 1) {
            deep = { entries: [deep] };
        }
        const child = logger.child(
            {},
            {
                serializers: {
                    custom: () => ({ ...credentials("serializer"), status: "serialized" }),
                },
            },
        );
        child.info({
            deep,
            custom: 1,
            value: { toJSON: () => ({ ...credentials("toJSON"), status: "converted" }) },
        });
        expect(chunks.join("")).not.toContain("fake-h03-");
        for (const diagnostic of ["retained", "serialized", "converted"]) {
            expect(chunks.join("")).toContain(diagnostic);
        }
    });
});
