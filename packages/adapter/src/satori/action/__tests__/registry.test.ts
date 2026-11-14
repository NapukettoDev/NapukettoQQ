/**
 * satori/action 注册表单测：createSatoriActionRegistry 与登录/未实现动作。
 *
 * 锁定：
 *  - 注册表完整性：22 个已实现动作 + 13 个 501 动作，全部可 get 到
 *  - NotImplementedAction.run → SatoriActionError(501)（schema 接受任意对象）
 *  - LoginGetAction → toLogin（sn=0 / 在线）
 *  - SatoriActionError 状态码语义（base-action 的 run 错误包装契约）
 */
import { describe, expect, it } from "vitest";
import { ActionRegistry } from "../../../core/framework/action-registry.js";
import { SatoriActionError } from "../base-action.js";
import { createSatoriActionRegistry, type SatoriActionRegistry } from "../index.js";
import { LoginGetAction } from "../login.js";
import { NotImplementedAction } from "../not-implemented.js";
import { stubSatoriApi } from "./test-support.js";

/** 22 个已实现动作（与 docs/protocols/satori.md §3 对表）。 */
const IMPLEMENTED = [
    "message.create",
    "message.get",
    "message.list",
    "message.delete",
    "channel.get",
    "channel.list",
    "user.get",
    "user.channel.create",
    "guild.get",
    "guild.list",
    "guild.approve",
    "guild.member.get",
    "guild.member.list",
    "guild.member.kick",
    "guild.member.mute",
    "guild.member.approve",
    "friend.list",
    "friend.delete",
    "friend.approve",
    "login.get",
    "reaction.create",
    "reaction.delete",
] as const;

/** 13 个 501 动作。 */
const NOT_IMPLEMENTED = [
    "message.update",
    "channel.create",
    "channel.update",
    "channel.delete",
    "channel.mute",
    "guild.member.role.set",
    "guild.member.role.unset",
    "guild.role.list",
    "guild.role.create",
    "guild.role.update",
    "guild.role.delete",
    "reaction.clear",
    "reaction.list",
] as const;

describe("createSatoriActionRegistry", () => {
    it("全部 35 个动作已注册（22 实现 + 13 未实现）", () => {
        const registry: SatoriActionRegistry = createSatoriActionRegistry({
            api: stubSatoriApi() as never,
        });
        const names = registry.names;
        for (const name of IMPLEMENTED) {
            expect(names).toContain(name);
        }
        for (const name of NOT_IMPLEMENTED) {
            expect(names).toContain(name);
        }
        expect(names).toHaveLength(IMPLEMENTED.length + NOT_IMPLEMENTED.length);
    });

    it("get 返回的动作 name 与注册名一致", () => {
        const registry = createSatoriActionRegistry({ api: stubSatoriApi() as never });
        for (const name of IMPLEMENTED) {
            expect(registry.get(name)?.name).toBe(name);
        }
    });

    it("未注册名（格式正确的 resource.method）→ undefined（transport 404）", () => {
        const registry = createSatoriActionRegistry({ api: stubSatoriApi() as never });
        expect(registry.get("message.rename")).toBeUndefined();
    });
});

describe("NotImplementedAction", () => {
    it("run → SatoriActionError(501)，文案含动作名", async () => {
        const action = new NotImplementedAction("channel.create");
        const err = await action.run({ anything: 1 }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SatoriActionError);
        expect((err as SatoriActionError).status).toBe(501);
        expect((err as SatoriActionError).message).toBe("平台不支持该操作: channel.create");
    });

    it("schema 接受任意对象（passthrough）", async () => {
        const action = new NotImplementedAction("reaction.list");
        const err = await action.run({ x: [1, 2, 3] }).catch((e: unknown) => e);
        expect((err as SatoriActionError).status).toBe(501);
    });

    it("registry 里的 501 动作 run 全部抛 501（表驱动）", async () => {
        const registry = createSatoriActionRegistry({ api: stubSatoriApi() as never });
        for (const name of NOT_IMPLEMENTED) {
            const action = registry.get(name);
            expect(action).toBeDefined();
            const err = await action?.run({}).catch((e: unknown) => e);
            expect((err as SatoriActionError).status).toBe(501);
        }
    });
});

describe("LoginGetAction", () => {
    it("返回 login（sn=0，在线，平台 qq）", async () => {
        const api = stubSatoriApi();
        const action = new LoginGetAction({ self: api.self });
        const login = await action.run({});
        expect(login).toEqual({
            sn: 0,
            platform: "qq",
            user: { id: "10001", name: "机器人" },
            status: 1,
            adapter: "napuketto",
            features: expect.any(Array),
        });
    });

    it("多余参数被 schema 剥离，不报错", async () => {
        const api = stubSatoriApi();
        const action = new LoginGetAction({ self: api.self });
        await expect(action.run({ junk: 1 })).resolves.toHaveProperty("sn", 0);
    });
});

describe("ActionRegistry 泛型契约（SatoriActionRegistry 类型面）", () => {
    it("构造的注册表就是 core 泛型 ActionRegistry 实例", () => {
        const registry = createSatoriActionRegistry({ api: stubSatoriApi() as never });
        expect(registry).toBeInstanceOf(ActionRegistry);
    });
});
