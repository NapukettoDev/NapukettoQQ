/**
 * core/framework/action-registry.test.ts：动作注册表单测（OB11 / Satori 共用泛型）。
 *
 * 锁定：register / get / has / names 与重复注册覆盖语义。
 */
import { describe, expect, it } from "vitest";
import { ActionRegistry } from "../action-registry.js";

/** 最小动作形状（只需 name）。 */
interface NamedAction {
    name: string;
}

/** 构造最小动作。 */
function makeAction(name: string): NamedAction {
    return { name };
}

describe("ActionRegistry", () => {
    it("register + get：按 name 取回动作", () => {
        const registry = new ActionRegistry<NamedAction>();
        const action = makeAction("get_msg");
        registry.register(action);
        expect(registry.get("get_msg")).toBe(action);
    });

    it("get 未注册动作：返回 undefined", () => {
        const registry = new ActionRegistry<NamedAction>();
        expect(registry.get("nope")).toBeUndefined();
    });

    it("has：已注册 true / 未注册 false", () => {
        const registry = new ActionRegistry<NamedAction>();
        registry.register(makeAction("send_msg"));
        expect(registry.has("send_msg")).toBe(true);
        expect(registry.has("send_private_msg")).toBe(false);
    });

    it("names：按注册顺序返回全部动作名", () => {
        const registry = new ActionRegistry<NamedAction>();
        registry.register(makeAction("a"));
        registry.register(makeAction("b"));
        registry.register(makeAction("c"));
        expect(registry.names).toEqual(["a", "b", "c"]);
    });

    it("重复注册同名动作：覆盖旧动作", () => {
        const registry = new ActionRegistry<NamedAction>();
        const first = makeAction("dup");
        const second = makeAction("dup");
        registry.register(first);
        registry.register(second);
        expect(registry.get("dup")).toBe(second);
        expect(registry.names).toEqual(["dup"]);
    });
});
