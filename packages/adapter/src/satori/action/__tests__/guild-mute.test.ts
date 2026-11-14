/**
 * guild-mute.test.ts：guild.member.mute 动作单测（Satori 毫秒 → kernel setMemberShutUp 秒）。
 */
import type { GroupApi } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../core/__tests__/stub.js";
import type { GuildActionDeps } from "../guild.js";
import { GuildMemberMuteAction } from "../guild.js";

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

describe("GuildMemberMuteAction", () => {
    it("duration 毫秒 → 秒（禁言对应成员）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = new GuildMemberMuteAction(makeDeps(setMemberShutUp));

        await action.run({ guild_id: "10001", user_id: "123", duration: 60_000 });

        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid_123", duration: 60 }]);
    });

    it("duration 0 → 解除禁言（0 秒）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = new GuildMemberMuteAction(makeDeps(setMemberShutUp));

        await action.run({ guild_id: "10001", user_id: "123", duration: 0 });

        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid_123", duration: 0 }]);
    });

    it("不足 1 秒 → 向下取整为 0（解除禁言）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const action = new GuildMemberMuteAction(makeDeps(setMemberShutUp));

        await action.run({ guild_id: "10001", user_id: "123", duration: 999 });

        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid_123", duration: 0 }]);
    });
});
