/**
 * P2 批次二 kernel 出口测试：RecentContactApi / MsgApi（nudge / 置顶 / 收藏表情）
 * / GroupApi（公告 / 头衔 / 群头像）/ RichMediaApi（renameGroupFolder /
 * getGroupFileDownloadUrl）
 *
 * mock session/service，不依赖真实 wrapper。锁定：参数形状透传、宽松 result
 * 解包（result 数字非 0 抛错）、公告图片两步链（uploadGroupBulletinPic → picId）。
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import type { NodeIQQNTWrapperSession, Peer } from "../../types/index.js";
import { ChatType } from "../../types/index.js";
import { GroupApi } from "../group.js";
import { MsgApi } from "../msg.js";
import { RecentContactApi } from "../recent-contact.js";
import { RichMediaApi } from "../richmedia.js";

const groupPeer: Peer = { chatType: ChatType.GROUP, peerUid: "10001" };
const friendPeer: Peer = { chatType: ChatType.C2C, peerUid: "uid-20002" };

describe("RecentContactApi", () => {
    it("getRecentContactService 空 → INVALID_STATE", () => {
        const session = { getRecentContactService: () => null };
        expect(() => new RecentContactApi(session as unknown as NodeIQQNTWrapperSession)).toThrow(
            /getRecentContactService\(\) 返回空/,
        );
    });

    it("getPinnedContacts：isTop 过滤 + 场景归类（temp 不产出）", async () => {
        const service = {
            getRecentContactList: vi.fn(async () => ({
                result: [
                    { peerUid: "30003", chatType: ChatType.GROUP, isTop: true },
                    { peerUid: "uid-20002", chatType: ChatType.C2C, isTop: true },
                    { peerUid: "40004", chatType: ChatType.GROUP, isTop: false },
                    { peerUid: "uid-x", chatType: 9, isTop: true },
                ],
            })),
        };
        const api = new RecentContactApi({
            getRecentContactService: () => service,
        } as unknown as NodeIQQNTWrapperSession);
        await expect(api.getPinnedContacts()).resolves.toEqual([
            { peerUid: "30003", scene: "group" },
            { peerUid: "uid-20002", scene: "friend" },
        ]);
    });

    it("getPinnedContacts：嵌套 result.contacts 形状兼容", async () => {
        const service = {
            getRecentContactList: vi.fn(async () => ({
                result: 0,
                contacts: [{ peerUid: "30003", chatType: ChatType.GROUP, isTop: true }],
            })),
        };
        const api = new RecentContactApi({
            getRecentContactService: () => service,
        } as unknown as NodeIQQNTWrapperSession);
        await expect(api.getPinnedContacts()).resolves.toEqual([
            { peerUid: "30003", scene: "group" },
        ]);
    });

    it("result 数字非 0 抛错；service 异常包装 UNKNOWN", async () => {
        const fail = {
            getRecentContactList: vi.fn(async () => ({ result: -1, errMsg: "bad" })),
        };
        const api = new RecentContactApi({
            getRecentContactService: () => fail,
        } as unknown as NodeIQQNTWrapperSession);
        await expect(api.getPinnedContacts()).rejects.toBeInstanceOf(KernelError);

        const boom = {
            getRecentContactList: vi.fn(async () => {
                throw new Error("boom");
            }),
        };
        const api2 = new RecentContactApi({
            getRecentContactService: () => boom,
        } as unknown as NodeIQQNTWrapperSession);
        await expect(api2.getPinnedContacts()).rejects.toMatchObject({ code: "UNKNOWN" });
    });
});

describe("MsgApi 批次二出口", () => {
    function makeApi(overrides: Record<string, unknown> = {}): MsgApi {
        const service = {
            generateMsgUniqueId: vi.fn(() => "msgid-1"),
            sendMsg: vi.fn(async () => ({ result: 0 })),
            ...overrides,
        };
        return new MsgApi({
            getMsgService: () => service,
        } as unknown as NodeIQQNTWrapperSession);
    }

    it("sendNudge：群场景带 confId；好友场景不带", async () => {
        const sendNudge = vi.fn(async () => null);
        const api = makeApi({ sendNudge });
        await api.sendNudge(groupPeer, { receiverUid: "uid-20002", callerUid: "uid-10000" });
        expect(sendNudge).toHaveBeenCalledWith({
            receiverUid: "uid-20002",
            callerUid: "uid-10000",
            confId: "10001",
        });
        await api.sendNudge(friendPeer, { receiverUid: "uid-20002", callerUid: "uid-10000" });
        expect(sendNudge).toHaveBeenLastCalledWith({
            receiverUid: "uid-20002",
            callerUid: "uid-10000",
        });
    });

    it("sendNudge 原生异常 → UNKNOWN KernelError", async () => {
        const api = makeApi({
            sendNudge: vi.fn(async () => {
                throw new Error("boom");
            }),
        });
        await expect(
            api.sendNudge(groupPeer, { receiverUid: "r", callerUid: "c" }),
        ).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("setContactTop：参数透传", async () => {
        const setContactLocalTop = vi.fn(async () => null);
        const api = makeApi({ setContactLocalTop });
        await api.setContactTop(groupPeer, true);
        expect(setContactLocalTop).toHaveBeenCalledWith(groupPeer, true);
    });

    it("queryFavEmojis：url/imageUrl 兜底提取；非数组 → []", async () => {
        const api = makeApi({
            queryFavEmojiByDesc: vi.fn(async () => ({
                result: 0,
                emojiInfoList: [
                    { url: "https://a/1" },
                    { imageUrl: "https://a/2" },
                    { noUrl: true },
                ],
            })),
        });
        await expect(api.queryFavEmojis()).resolves.toEqual(["https://a/1", "https://a/2"]);
        const api2 = makeApi({
            queryFavEmojiByDesc: vi.fn(async () => ({ result: 0, emojiInfoList: "junk" })),
        });
        await expect(api2.queryFavEmojis()).resolves.toEqual([]);
    });
});

describe("GroupApi 批次二出口", () => {
    function makeApi(overrides: Record<string, unknown> = {}): GroupApi {
        const service = {
            getGroupBulletin: vi.fn(async () => ({ result: 0, bulletins: [] })),
            publishGroupBulletin: vi.fn(async () => null),
            uploadGroupBulletinPic: vi.fn(async () => ({ result: 0, picId: "pic-1" })),
            deleteGroupBulletin: vi.fn(async () => null),
            setIdentityTitleInfo: vi.fn(async () => null),
            setHeader: vi.fn(async () => null),
            ...overrides,
        };
        return new GroupApi({
            getGroupService: () => service,
            getMsgService: () => ({
                getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [] })),
            }),
        } as unknown as NodeIQQNTWrapperSession);
    }

    it("getGroupAnnouncements：bulletins 数组宽松提取", async () => {
        const api = makeApi({
            getGroupBulletin: vi.fn(async () => ({
                result: [{ announcementId: "a1", content: "公告" }],
            })),
        });
        await expect(api.getGroupAnnouncements("10001")).resolves.toEqual([
            { announcementId: "a1", content: "公告" },
        ]);
    });

    it("publishGroupAnnouncement：纯文本单步；带图两步（picId 注入）", async () => {
        const publishGroupBulletin = vi.fn(async () => null);
        const api = makeApi({ publishGroupBulletin });
        await api.publishGroupAnnouncement("10001", "公告");
        expect(publishGroupBulletin).toHaveBeenCalledWith({ groupCode: "10001", content: "公告" });

        const publish2 = vi.fn(async () => null);
        const api2 = makeApi({ publishGroupBulletin: publish2 });
        await api2.publishGroupAnnouncement("10001", "公告", "/tmp/a.png");
        expect(publish2).toHaveBeenCalledWith({
            groupCode: "10001",
            content: "公告",
            picId: "pic-1",
        });
    });

    it("setMemberSpecialTitle / setGroupAvatar / deleteGroupAnnouncement 参数透传", async () => {
        const setIdentityTitleInfo = vi.fn(async () => null);
        const setHeader = vi.fn(async () => null);
        const deleteGroupBulletin = vi.fn(async () => null);
        const api = makeApi({ setIdentityTitleInfo, setHeader, deleteGroupBulletin });
        await api.setMemberSpecialTitle("10001", "uid-20002", "头衔");
        expect(setIdentityTitleInfo).toHaveBeenCalledWith("10001", "uid-20002", "头衔");
        await api.setGroupAvatar("10001", "/tmp/g.png");
        expect(setHeader).toHaveBeenCalledWith("10001", "/tmp/g.png");
        await api.deleteGroupAnnouncement("10001", "a1");
        expect(deleteGroupBulletin).toHaveBeenCalledWith("10001", "a1");
    });

    it("宽松 result 非 0 抛错", async () => {
        const api = makeApi({ setHeader: vi.fn(async () => ({ result: 1, errMsg: "bad" })) });
        await expect(api.setGroupAvatar("10001", "/tmp/g.png")).rejects.toBeInstanceOf(KernelError);
    });
});

describe("RichMediaApi 批次二出口", () => {
    function makeApi(service: Record<string, unknown>): RichMediaApi {
        return new RichMediaApi({
            getRichMediaService: () => service,
        } as unknown as NodeIQQNTWrapperSession);
    }

    it("renameGroupFolder：镜像 renameGroupFile 五参形态", async () => {
        const renameGroupFolder = vi.fn(async () => null);
        const api = makeApi({ renameGroupFolder });
        await api.renameGroupFolder("10001", "fd1", "新名");
        expect(renameGroupFolder).toHaveBeenCalledWith("10001", 102, "fd1", "新名", "");
    });

    it("getGroupFileDownloadUrl：命中取 url；无 url / 未命中 NOT_FOUND", async () => {
        const api = makeApi({
            getGroupFileList: vi.fn(async () => ({
                result: [
                    { fileInfo: { fileId: "f1", fileName: "a", url: "https://dl/x" } },
                    { fileInfo: { fileId: "f2", fileName: "b" } },
                ],
            })),
        });
        await expect(api.getGroupFileDownloadUrl("10001", "f1")).resolves.toBe("https://dl/x");
        await expect(api.getGroupFileDownloadUrl("10001", "f2")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await expect(api.getGroupFileDownloadUrl("10001", "f3")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });
});
