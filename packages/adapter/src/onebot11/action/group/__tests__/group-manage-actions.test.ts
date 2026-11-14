/**
 * 群管动作测试：set_group_ban / set_group_whole_ban / set_group_kick /
 * set_group_admin / set_group_card / set_group_name / set_group_leave。
 *
 * 锁定行为：user_id（uin）→ uid 参数映射、zod 缺省值（duration=30 / enable=true /
 * card="" / is_dismiss=false）、kick 的拉黑与理由透传、解析失败错误映射。
 */
import { NTGroupMemberRole } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stubConverters } from "../../__tests__/test-support.js";
import {
    SetGroupAdminAction,
    SetGroupBanAction,
    SetGroupCardAction,
    SetGroupKickAction,
    SetGroupLeaveAction,
    SetGroupNameAction,
    SetGroupWholeBanAction,
} from "../manage.js";

describe("set_group_ban", () => {
    it("duration 缺省 30 → setMemberShutUp({uid, duration:30})", async () => {
        const { uinToUid } = stubConverters();
        const groupApi = {
            uinToUid,
            setMemberShutUp: vi.fn(async () => undefined),
        };
        const action = new SetGroupBanAction(groupApi as never);
        const result = await action.handle({ group_id: 808, user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(groupApi.setMemberShutUp).toHaveBeenCalledWith("808", [
            { uid: "u90001", duration: 30 },
        ]);
    });

    it("duration=0（解除禁言）原样透传", async () => {
        const { uinToUid } = stubConverters();
        const groupApi = {
            uinToUid,
            setMemberShutUp: vi.fn(async () => undefined),
        };
        const action = new SetGroupBanAction(groupApi as never);
        await action.handle({ group_id: 808, user_id: 90001, duration: 0 });
        expect(groupApi.setMemberShutUp).toHaveBeenCalledWith("808", [
            { uid: "u90001", duration: 0 },
        ]);
    });

    it("uin 解析失败 → retcode 105 INVALID_PARAM", async () => {
        const groupApi = {
            uinToUid: vi.fn(async () => new Map<string, string>()),
            setMemberShutUp: vi.fn(async () => undefined),
        };
        const action = new SetGroupBanAction(groupApi as never);
        const result = await action.handle({ group_id: 808, user_id: 11111 });
        expect(result.retcode).toBe(105);
        expect(groupApi.setMemberShutUp).not.toHaveBeenCalled();
    });
});

describe("set_group_whole_ban", () => {
    it("enable 缺省 true → setGroupShutUp(group, true)", async () => {
        const groupApi = { setGroupShutUp: vi.fn(async () => undefined) };
        const action = new SetGroupWholeBanAction(groupApi as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(0);
        expect(groupApi.setGroupShutUp).toHaveBeenCalledWith("808", true);
    });

    it("enable=false 显式解除全员禁言", async () => {
        const groupApi = { setGroupShutUp: vi.fn(async () => undefined) };
        const action = new SetGroupWholeBanAction(groupApi as never);
        await action.handle({ group_id: 808, enable: false });
        expect(groupApi.setGroupShutUp).toHaveBeenCalledWith("808", false);
    });
});

describe("set_group_kick", () => {
    it("参数映射：拉黑与理由缺省（false / 空串）", async () => {
        const groupApi = {
            uinToUid: stubConverters().uinToUid,
            kickMember: vi.fn(async () => undefined),
        };
        const action = new SetGroupKickAction(groupApi as never);
        const result = await action.handle({ group_id: 808, user_id: 90002 });
        expect(result.retcode).toBe(0);
        expect(groupApi.kickMember).toHaveBeenCalledWith("808", ["u90002"], false, "");
    });

    it("reject_add_request / kick_reason 透传", async () => {
        const groupApi = {
            uinToUid: stubConverters().uinToUid,
            kickMember: vi.fn(async () => undefined),
        };
        const action = new SetGroupKickAction(groupApi as never);
        await action.handle({
            group_id: 808,
            user_id: 90002,
            reject_add_request: true,
            kick_reason: "违规",
        });
        expect(groupApi.kickMember).toHaveBeenCalledWith("808", ["u90002"], true, "违规");
    });

    it("uin 解析失败 → retcode 105", async () => {
        const groupApi = {
            uinToUid: vi.fn(async () => new Map<string, string>()),
            kickMember: vi.fn(async () => undefined),
        };
        const action = new SetGroupKickAction(groupApi as never);
        const result = await action.handle({ group_id: 808, user_id: 11111 });
        expect(result.retcode).toBe(105);
    });
});

describe("set_group_admin", () => {
    it("enable 缺省 true → setMemberRole ADMIN", async () => {
        const groupApi = {
            uinToUid: stubConverters().uinToUid,
            setMemberRole: vi.fn(),
        };
        const action = new SetGroupAdminAction(groupApi as never);
        const result = await action.handle({ group_id: 808, user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(groupApi.setMemberRole).toHaveBeenCalledWith(
            "808",
            "u90001",
            NTGroupMemberRole.ADMIN,
        );
    });

    it("enable=false → setMemberRole MEMBER（取消管理员）", async () => {
        const groupApi = {
            uinToUid: stubConverters().uinToUid,
            setMemberRole: vi.fn(),
        };
        const action = new SetGroupAdminAction(groupApi as never);
        await action.handle({ group_id: 808, user_id: 90001, enable: false });
        expect(groupApi.setMemberRole).toHaveBeenCalledWith(
            "808",
            "u90001",
            NTGroupMemberRole.MEMBER,
        );
    });
});

describe("set_group_card", () => {
    it("card 缺省空串 → setMemberCardName（清名片）", async () => {
        const groupApi = {
            uinToUid: stubConverters().uinToUid,
            setMemberCardName: vi.fn(),
        };
        const action = new SetGroupCardAction(groupApi as never);
        const result = await action.handle({ group_id: 808, user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(groupApi.setMemberCardName).toHaveBeenCalledWith("808", "u90001", "");
    });

    it("card 显式传入 → 原样透传", async () => {
        const groupApi = {
            uinToUid: stubConverters().uinToUid,
            setMemberCardName: vi.fn(),
        };
        const action = new SetGroupCardAction(groupApi as never);
        await action.handle({ group_id: 808, user_id: 90001, card: "新名片" });
        expect(groupApi.setMemberCardName).toHaveBeenCalledWith("808", "u90001", "新名片");
    });
});

describe("set_group_name / set_group_leave", () => {
    it("set_group_name → modifyGroupName(group, name)", async () => {
        const groupApi = { modifyGroupName: vi.fn(async () => undefined) };
        const action = new SetGroupNameAction(groupApi as never);
        const result = await action.handle({ group_id: 808, group_name: "新群名" });
        expect(result.retcode).toBe(0);
        expect(groupApi.modifyGroupName).toHaveBeenCalledWith("808", "新群名");
    });

    it("set_group_leave 缺省 is_dismiss=false → quitGroup(group, false)", async () => {
        const groupApi = { quitGroup: vi.fn(async () => undefined) };
        const action = new SetGroupLeaveAction(groupApi as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(0);
        expect(groupApi.quitGroup).toHaveBeenCalledWith("808", false);
    });

    it("set_group_leave is_dismiss=true → 解散群", async () => {
        const groupApi = { quitGroup: vi.fn(async () => undefined) };
        const action = new SetGroupLeaveAction(groupApi as never);
        await action.handle({ group_id: 808, is_dismiss: true });
        expect(groupApi.quitGroup).toHaveBeenCalledWith("808", true);
    });

    it("set_group_name 缺 group_name → retcode 400", async () => {
        const action = new SetGroupNameAction({ modifyGroupName: vi.fn() } as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(400);
    });
});
