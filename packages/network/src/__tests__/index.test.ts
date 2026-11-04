/**
 * index.ts 包门面测试：锁定 re-export 面（协议无关传输原语全量导出）。
 */
import { describe, expect, it } from "vitest";
import * as network from "../index.js";

describe("network 包门面", () => {
    it("导出全部运行时符号（类 / 函数 / 常量）", () => {
        expect(network.EventBroadcaster).toBeDefined();
        expect(network.HttpClient).toBeDefined();
        expect(network.HttpServer).toBeDefined();
        expect(network.WsClient).toBeDefined();
        expect(network.WsServer).toBeDefined();
        expect(network.createSseResponse).toBeDefined();
        expect(network.isWsOpen).toBeDefined();
        expect(network.DEFAULT_MAX_BODY_BYTES).toBeDefined();
        expect(network.DEFAULT_MAX_PAYLOAD_BYTES).toBeDefined();
    });

    it("常量值与源模块一致", () => {
        expect(network.DEFAULT_MAX_BODY_BYTES).toBe(16 * 1024 * 1024);
        expect(network.DEFAULT_MAX_PAYLOAD_BYTES).toBe(32 * 1024 * 1024);
    });

    it("类可实例化（门面 re-export 未破坏构造签名）", () => {
        expect(typeof network.WsClient).toBe("function");
        expect(typeof network.WsServer).toBe("function");
        expect(typeof network.HttpServer).toBe("function");
        expect(typeof network.HttpClient).toBe("function");
        expect(typeof network.EventBroadcaster).toBe("function");
        expect(new network.EventBroadcaster().size).toBe(0);
    });
});
