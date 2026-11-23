/**
 * guild-mute.test.ts：guild.member.mute 动作单测（Satori 毫秒 → kernel setMemberShutUp 秒）。
 */
import type { GroupApi } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../internal/__tests__/stub.js";
import type { GuildActionDeps } from "../guild.js";
import { createGuildActions } from "../guild.js";
import { satoriActionOf } from "./test-support.js";

/** mute 动作最小依赖（groupApi.setMemberShutUp + uinToUid）。 */
function makeDeps(setMemberShutUp: GroupApi["setMemberShutUp"]): GuildActionDeps {
    return stub<GuildActionDeps>({
        groupApi: stub<GroupApi>({ setMemberShutUp }),
        uinToUid: async (uins: string[]) => {
            const map = new Map<string, string>();
            for (const uin of uins) {
                map.set(uin, `uid_${uin}`);
            }
            return map;
        },
    });
}

/** 构造 mute 动作（工厂产物按名取出）。 */
function actionOf(setMemberShutUp: GroupApi["setMemberShutUp"]) {
    return satoriActionOf<void>(createGuildActions(makeDeps(setMemberShutUp)), "guild.member.mute");
}

describe("guild.member.mute", () => {
    it("duration 毫秒 → 秒（禁言对应成员）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = actionOf(setMemberShutUp);

        await action.run({ guild_id: "10001", user_id: "123", duration: 60_000 });

        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid_123", duration: 60 }]);
    });

    it("duration 0 → 解除禁言（0 秒）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = actionOf(setMemberShutUp);

        await action.run({ guild_id: "10001", user_id: "123", duration: 0 });

        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid_123", duration: 0 }]);
    });

    it("正时长不足 1 秒时传 1 秒，保留 0 的解除语义", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = actionOf(setMemberShutUp);

        await action.run({ guild_id: "10001", user_id: "123", duration: 999 });

        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid_123", duration: 1 }]);
    });

    it("负时长不进入禁言调用", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = actionOf(setMemberShutUp);
        await expect(
            action.run({ guild_id: "10001", user_id: "123", duration: -1 }),
        ).rejects.toMatchObject({ status: 400 });
        expect(setMemberShutUp).not.toHaveBeenCalled();
    });
});
