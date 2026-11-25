/**
 * OB11 动作注册表测试：未注册动作的查询语义、resolveUid（uin→uid 解析与
 * 失败抛 INVALID_PARAM）。
 *
 * 2026-11-18：删除 81 个动作名的硬编码清单——改名需双改，且逐名 `get/has`
 * 断言与 adapter.test.ts 的动作分发覆盖重复。注册面完整性由 tsc（域工厂返回值
 * 类型）与 transport 层分发测试守卫。
 */
import { describe, expect, it } from "vitest";
import { resolveUid } from "../../../src/onebot11/action/base-action.js";
import { createOb11ActionRegistry } from "../../../src/onebot11/action/index.js";
import { stubConverters } from "./test-support.js";

describe("createOb11ActionRegistry", () => {
    it("未注册动作 → get undefined / has false", () => {
        const registry = createOb11ActionRegistry({ api: {} as never });
        expect(registry.get("no_such_action")).toBeUndefined();
        expect(registry.has("no_such_action")).toBe(false);
    });
});

describe("resolveUid", () => {
    it("映射命中 → 返回 uid", async () => {
        const { uinToUid } = stubConverters();
        expect(await resolveUid("90001", uinToUid)).toBe("u90001");
    });

    it("映射未命中 → 抛 KernelError INVALID_PARAM", async () => {
        await expect(resolveUid("11111", stubConverters().uinToUid)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });
});
