/**
 * core/framework/transport-schema.test.ts：传输实例 schema 工厂单测。
 *
 * 锁定：createHttpServerSchema / createWsServerSchema 的默认值注入
 * （enabled=false / host=127.0.0.1 / port=defaultPort）、实例级 token 可选、
 * 非法输入被拒。
 */
import { describe, expect, it } from "vitest";
import { createHttpServerSchema, createWsServerSchema } from "../transport-schema.js";

describe("createHttpServerSchema", () => {
    it("空输入：应用默认端口与默认 host/enabled", () => {
        const schema = createHttpServerSchema(5500);
        expect(schema.parse({})).toEqual({
            enabled: false,
            host: "127.0.0.1",
            port: 5500,
        });
    });

    it("显式字段覆盖默认值；token 可选透传", () => {
        const schema = createHttpServerSchema(5500);
        const parsed = schema.parse({
            enabled: true,
            host: "0.0.0.0",
            port: 6600,
            token: "secret",
        });
        expect(parsed).toEqual({ enabled: true, host: "0.0.0.0", port: 6600, token: "secret" });
    });

    it("port 非整数：拒绝", () => {
        const schema = createHttpServerSchema(5500);
        expect(schema.safeParse({ port: 1.5 }).success).toBe(false);
    });
});

describe("createWsServerSchema", () => {
    it("空输入：应用默认端口（与 HTTP 工厂独立注入）", () => {
        const schema = createWsServerSchema(5501);
        expect(schema.parse({})).toEqual({
            enabled: false,
            host: "127.0.0.1",
            port: 5501,
        });
    });

    it("两个工厂互不影响（各自闭包默认端口）", () => {
        const http = createHttpServerSchema(5500);
        const ws = createWsServerSchema(5501);
        expect(http.parse({}).port).toBe(5500);
        expect(ws.parse({}).port).toBe(5501);
    });

    it("token 非字符串：拒绝", () => {
        const schema = createWsServerSchema(5501);
        expect(schema.safeParse({ token: 123 }).success).toBe(false);
    });
});
