/**
 * types.ts 测试：isWsOpen 判定。
 *
 * isWsOpen 是协议层判 readyState 的唯一入口（协议层不出现魔法数字、
 * 不直接依赖 ws 常量），锁定 OPEN=1 判定语义。
 */
import { describe, expect, it } from "vitest";
import { isWsOpen, type WsSocket } from "../types.js";

/** 构造只带 readyState 的最小连接桩（isWsOpen 只读该字段）。 */
function stubSocket(readyState: number): WsSocket {
    return { readyState } as unknown as WsSocket;
}

describe("isWsOpen", () => {
    it("readyState = 1（OPEN）→ true", () => {
        expect(isWsOpen(stubSocket(1))).toBe(true);
    });

    it("readyState = 0（CONNECTING）→ false", () => {
        expect(isWsOpen(stubSocket(0))).toBe(false);
    });

    it("readyState = 2（CLOSING）→ false", () => {
        expect(isWsOpen(stubSocket(2))).toBe(false);
    });

    it("readyState = 3（CLOSED）→ false", () => {
        expect(isWsOpen(stubSocket(3))).toBe(false);
    });
});
