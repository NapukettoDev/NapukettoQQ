/**
 * state.test.ts：引导进程共享状态与消息遍历工具单测（`host/runtime/state.ts`）。
 */
import { describe, expect, it } from "vitest";
import { createState, forEachRawMessage } from "../../../src/host/runtime/state.js";

describe("forEachRawMessage（onRecvMsg 参数逐条处理）", () => {
    it("数组：逐条回调，null/非对象项过滤", () => {
        const seen: unknown[] = [];
        forEachRawMessage([null, "str", { msgId: "1" }, { msgId: "2" }], (m) => seen.push(m));
        expect(seen).toEqual([{ msgId: "1" }, { msgId: "2" }]);
    });

    it("单条对象（兼容非数组回调参数）→ 包装后处理", () => {
        const seen: unknown[] = [];
        forEachRawMessage({ msgId: "solo" }, (m) => seen.push(m));
        expect(seen).toEqual([{ msgId: "solo" }]);
    });

    it("无效单条（null / 非对象）→ 不回调", () => {
        const seen: unknown[] = [];
        forEachRawMessage(null, (m) => seen.push(m));
        forEachRawMessage(42, (m) => seen.push(m));
        expect(seen).toHaveLength(0);
    });
});

describe("createState", () => {
    it("初始状态：无 wrapper / QQ 实例，未引导", () => {
        expect(createState()).toEqual({
            wrapperExports: null,
            qqSession: null,
            qqLoginService: null,
            bootstrapped: false,
        });
    });
});
