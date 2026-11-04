/**
 * helper/config.test.ts：satoriConfigSchema 单测。
 *
 * 锁定：空输入默认值（httpServers/wsServers 空数组、端口 5500/5501）、
 * 服务器实例字段解析、token/cacheDir 可选透传、非法输入拒绝。
 */
import { describe, expect, it } from "vitest";
import { satoriConfigSchema } from "../config.js";

describe("satoriConfigSchema", () => {
    it("空输入：默认空服务器列表（不启用任何传输）", () => {
        expect(satoriConfigSchema.parse({})).toEqual({
            httpServers: [],
            wsServers: [],
        });
    });

    it("token / cacheDir 可选透传", () => {
        const parsed = satoriConfigSchema.parse({ token: "t", cacheDir: "/tmp/cache" });
        expect(parsed.token).toBe("t");
        expect(parsed.cacheDir).toBe("/tmp/cache");
    });

    it("httpServers 实例：enabled 缺省 false，端口默认 5500", () => {
        const parsed = satoriConfigSchema.parse({ httpServers: [{}] });
        expect(parsed.httpServers).toEqual([{ enabled: false, host: "127.0.0.1", port: 5500 }]);
    });

    it("wsServers 实例：端口默认 5501，实例 token 覆盖全局", () => {
        const parsed = satoriConfigSchema.parse({ wsServers: [{ enabled: true, token: "x" }] });
        expect(parsed.wsServers).toEqual([
            { enabled: true, host: "127.0.0.1", port: 5501, token: "x" },
        ]);
    });

    it("显式端口 / host 覆盖默认", () => {
        const parsed = satoriConfigSchema.parse({
            httpServers: [{ enabled: true, port: 8800, host: "0.0.0.0" }],
        });
        expect(parsed.httpServers[0]).toEqual({ enabled: true, host: "0.0.0.0", port: 8800 });
    });

    it("非法输入：port 非数字拒绝；未知键剥离（zod 默认）", () => {
        expect(satoriConfigSchema.safeParse({ httpServers: [{ port: "x" }] }).success).toBe(false);
        const parsed = satoriConfigSchema.parse({ unknownKey: 1 });
        expect("unknownKey" in parsed).toBe(false);
    });
});
