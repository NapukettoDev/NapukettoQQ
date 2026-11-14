/**
 * Milky 群管理域动作测试（group-manage.ts，2026-11-14 域对齐重组）
 *
 * 锁定：群管动作的 uin→uid 与参数换算（admin role 3/2、禁言 duration 缺省、
 * kick reject_add_request）、群公告发布/删除（image_uri 落盘）、群头像/专属
 * 头衔、群戳一戳（self.uid 缺失报错）。
 */
import { join } from "node:path";
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { actionOf, groupRegistry } from "./test-support.js";

describe("群管动作（set_* / kick / quit）", () => {
    it("set_group_name：群号字符串化透传", async () => {
        const modifyGroupName = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { modifyGroupName } });
        const res = await actionOf(registry, "set_group_name").handle({
            group_id: 10001,
            new_group_name: "新群名",
        });
        expect(res.status).toBe("ok");
        expect(modifyGroupName).toHaveBeenCalledWith("10001", "新群名");
    });

    it("set_group_member_card：uin→uid + card 透传", async () => {
        const setMemberCardName = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberCardName } });
        await actionOf(registry, "set_group_member_card").handle({
            group_id: 10001,
            user_id: 20002,
            card: "新名片",
        });
        expect(setMemberCardName).toHaveBeenCalledWith("10001", "uid-20002", "新名片");
    });

    it("set_group_member_admin：is_set 缺省 → ADMIN(3)；false → MEMBER(2)", async () => {
        const setMemberRole = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberRole } });
        await actionOf(registry, "set_group_member_admin").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(setMemberRole).toHaveBeenLastCalledWith("10001", "uid-20002", 3);
        await actionOf(registry, "set_group_member_admin").handle({
            group_id: 10001,
            user_id: 20002,
            is_set: false,
        });
        expect(setMemberRole).toHaveBeenLastCalledWith("10001", "uid-20002", 2);
    });

    it("set_group_member_mute：duration 缺省 0（解除禁言）", async () => {
        const setMemberShutUp = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberShutUp } });
        await actionOf(registry, "set_group_member_mute").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(setMemberShutUp).toHaveBeenCalledWith("10001", [{ uid: "uid-20002", duration: 0 }]);
        await actionOf(registry, "set_group_member_mute").handle({
            group_id: 10001,
            user_id: 20002,
            duration: 600,
        });
        expect(setMemberShutUp).toHaveBeenLastCalledWith("10001", [
            { uid: "uid-20002", duration: 600 },
        ]);
    });

    it("set_group_whole_mute：is_mute 缺省 true；false → 解除", async () => {
        const setGroupShutUp = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setGroupShutUp } });
        await actionOf(registry, "set_group_whole_mute").handle({ group_id: 10001 });
        expect(setGroupShutUp).toHaveBeenLastCalledWith("10001", true);
        await actionOf(registry, "set_group_whole_mute").handle({
            group_id: 10001,
            is_mute: false,
        });
        expect(setGroupShutUp).toHaveBeenLastCalledWith("10001", false);
    });

    it("kick_group_member：reject_add_request 缺省 false；true 透传", async () => {
        const kickMember = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { kickMember } });
        await actionOf(registry, "kick_group_member").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(kickMember).toHaveBeenLastCalledWith("10001", ["uid-20002"], false);
        await actionOf(registry, "kick_group_member").handle({
            group_id: 10001,
            user_id: 20002,
            reject_add_request: true,
        });
        expect(kickMember).toHaveBeenLastCalledWith("10001", ["uid-20002"], true);
    });

    it("quit_group：退出群聊", async () => {
        const quitGroup = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { quitGroup } });
        const res = await actionOf(registry, "quit_group").handle({ group_id: 10001 });
        expect(res.status).toBe("ok");
        expect(quitGroup).toHaveBeenCalledWith("10001");
    });

    it("uin→uid 转换失败 → INVALID_PARAM（-400）", async () => {
        const registry = groupRegistry({
            groupApi: { uinToUid: vi.fn(async () => new Map()) },
        });
        const res = await actionOf(registry, "set_group_member_card").handle({
            group_id: 10001,
            user_id: 20002,
            card: "x",
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("不存在或 uin→uid 转换失败");
    });
});

describe("set_group_avatar / set_group_member_special_title", () => {
    it("set_group_avatar：裸路径 image_uri 原样透传", async () => {
        const setGroupAvatar = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setGroupAvatar } });
        const res = await actionOf(registry, "set_group_avatar").handle({
            group_id: 10001,
            image_uri: join("some", "avatar.png"),
        });
        expect(res.status).toBe("ok");
        expect(setGroupAvatar).toHaveBeenCalledWith("10001", join("some", "avatar.png"));
    });

    it("set_group_avatar：image_uri 展开 + 群号字符串（P2 批次二补测）", async () => {
        const setGroupAvatar = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setGroupAvatar } });
        await actionOf(registry, "set_group_avatar").handle({
            group_id: 10001,
            image_uri: "file:///C:/pic/g.png",
        });
        expect(setGroupAvatar).toHaveBeenCalledWith("10001", expect.stringMatching(/g\.png$/));
    });

    it("set_group_member_special_title：uin→uid + 头衔透传", async () => {
        const setMemberSpecialTitle = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberSpecialTitle } });
        await actionOf(registry, "set_group_member_special_title").handle({
            group_id: 10001,
            user_id: 20002,
            special_title: "头衔",
        });
        expect(setMemberSpecialTitle).toHaveBeenCalledWith("10001", "uid-20002", "头衔");
    });

    it("set_group_member_special_title：uin→uid 透传（P2 批次二补测）", async () => {
        const setMemberSpecialTitle = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { setMemberSpecialTitle } });
        await actionOf(registry, "set_group_member_special_title").handle({
            group_id: 10001,
            user_id: 20002,
            special_title: "头衔",
        });
        expect(setMemberSpecialTitle).toHaveBeenCalledWith("10001", "uid-20002", "头衔");
    });
});

describe("send_group_nudge", () => {
    it("uin→uid + confId=群号 peer + callerUid=self.uid", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = groupRegistry({ msgApi: { sendNudge } });
        const res = await actionOf(registry, "send_group_nudge").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.status).toBe("ok");
        expect(sendNudge).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { receiverUid: "uid-20002", callerUid: "uid-10000" },
        );
    });

    it("self.uid 缺失 → INVALID_PARAM（-400）", async () => {
        const registry = groupRegistry({ selfUid: "" });
        const res = await actionOf(registry, "send_group_nudge").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("登录身份缺 uid");
    });

    it("uin→uid + confId=群号 + callerUid=self.uid（P2 批次二补测）", async () => {
        const sendNudge = vi.fn(async () => null);
        const registry = groupRegistry({ msgApi: { sendNudge } });
        const res = await actionOf(registry, "send_group_nudge").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.retcode).toBe(0);
        expect(sendNudge).toHaveBeenCalledWith(expect.anything(), {
            receiverUid: "uid-20002",
            callerUid: "uid-10000",
        });
    });
});

describe("send_group_announcement / delete_group_announcement", () => {
    it("send_group_announcement：无图直发 publishGroupBulletin 链", async () => {
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { publishGroupAnnouncement } });
        const res = await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "正文",
        });
        expect(res.status).toBe("ok");
        expect(publishGroupAnnouncement).toHaveBeenCalledWith("10001", "正文", undefined);
    });

    it("send_group_announcement：file:// image_uri 展开本地路径后透传", async () => {
        const { pathToFileURL } = await import("node:url");
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { publishGroupAnnouncement } });
        const filePath = join("盘", "公告.png");
        const res = await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "带图公告",
            image_uri: pathToFileURL(filePath).href,
        });
        expect(res.status).toBe("ok");
        const [, , imageArg] = publishGroupAnnouncement.mock.calls[0] as unknown as [
            string,
            string,
            string,
        ];
        expect(imageArg.endsWith("公告.png")).toBe(true);
    });

    it("send_group_announcement：image_uri 空串视同无图", async () => {
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { publishGroupAnnouncement } });
        await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "正文",
            image_uri: "",
        });
        expect(publishGroupAnnouncement).toHaveBeenCalledWith("10001", "正文", undefined);
    });

    it("send_group_announcement：file:// image_uri 展开后进 kernel（P2 批次二补测）", async () => {
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({
            groupApi: { publishGroupAnnouncement },
        });
        await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "公告",
            image_uri: "file:///C:/pic/a.png",
        });
        expect(publishGroupAnnouncement).toHaveBeenCalledWith(
            "10001",
            "公告",
            expect.stringMatching(/[\\/]pic[\\/]a\.png$/),
        );
    });

    it("delete_group_announcement：id 透传", async () => {
        const deleteGroupAnnouncement = vi.fn(async () => undefined);
        const registry = groupRegistry({ groupApi: { deleteGroupAnnouncement } });
        await actionOf(registry, "delete_group_announcement").handle({
            group_id: 10001,
            announcement_id: "a1",
        });
        expect(deleteGroupAnnouncement).toHaveBeenCalledWith("10001", "a1");
    });

    it("公告 content 空串 → -400", async () => {
        const registry = groupRegistry({});
        const res = await actionOf(registry, "send_group_announcement").handle({
            group_id: 10001,
            content: "",
        });
        expect(res.retcode).toBe(-400);
    });
});
