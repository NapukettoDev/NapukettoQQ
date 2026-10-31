/**
 * Milky P2 批次二动作测试（§0.7）：nudge / peer_pins / 公告 / 头衔 / 群头像 /
 * 收藏表情 / resource 反查 / 上传 / download_url / rename_group_folder
 *
 * kernel apis 桩（ConstructorParameters 整体断言，message.test.ts 模式）。
 * 锁定：uid/uin 转换入参、file:// URI 展开、file_id 取 fileUuid 兜底 msgId、
 * resource_id 链接形态判定、置顶会话实体过滤（未命中跳过）。
 */
import { describe, expect, it, vi } from "vitest";
import { MilkyApi } from "../api.js";
import { MessageSeqIndex } from "../helper/seq-index.js";
import { createMilkyActionRegistry } from "./index.js";

/** 批次二依赖桩（其余 P0/P1 依赖空对象——注册表只需构造不调用）。 */
function makeApi(overrides: {
    msgApi?: Record<string, unknown>;
    groupApi?: Record<string, unknown>;
    richMediaApi?: Record<string, unknown>;
    recentContactApi?: Record<string, unknown>;
    friendApi?: Record<string, unknown>;
    groupCache?: Record<string, unknown>;
    selfUid?: string;
}): { api: MilkyApi; registry: ReturnType<typeof createMilkyActionRegistry> } {
    const api = new MilkyApi(
        {
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "msg-1" })),
                fetchMsgsByMsgId: vi.fn(async () => []),
                ...overrides.msgApi,
            },
            groupApi: {
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(
                    async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("uid-", "")])),
                ),
                ...overrides.groupApi,
            },
            friendApi: {
                getFriendList: vi.fn(async () => []),
                ...overrides.friendApi,
            },
            profileApi: {},
            profileLikeApi: {},
            ticketApi: {},
            webApi: {},
            groupNotifyApi: {},
            richMediaApi: { ...overrides.richMediaApi },
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => []),
                ...overrides.recentContactApi,
            },
            self: { uin: "10000", nickname: "机器人", uid: overrides.selfUid ?? "uid-10000" },
            ...(overrides.groupCache !== undefined ? { groupCache: overrides.groupCache } : {}),
        } as unknown as ConstructorParameters<typeof MilkyApi>[0],
        new MessageSeqIndex(),
    );
    return { api, registry: createMilkyActionRegistry({ api }) };
}

/** 从注册表取动作。 */
function action(registry: ReturnType<typeof createMilkyActionRegistry>, name: string) {
    const act = registry.get(name);
    if (act === undefined) {
        throw new Error(`动作未注册: ${name}`);
    }
    return act;
}

describe("nudge 发送", () => {
    it("send_group_nudge：uin→uid + confId=群号 + callerUid=self.uid", async () => {
        const sendNudge = vi.fn(async () => null);
        const { registry } = makeApi({ msgApi: { sendNudge } });
        const res = await action(registry, "send_group_nudge").handle({
            group_id: 10001,
            user_id: 20002,
        });
        expect(res.retcode).toBe(0);
        expect(sendNudge).toHaveBeenCalledWith(expect.anything(), {
            receiverUid: "uid-20002",
            callerUid: "uid-10000",
        });
    });

    it("send_friend_nudge is_self：receiver = 自己 uid（不查 uin）", async () => {
        const sendNudge = vi.fn(async () => null);
        const { registry } = makeApi({ msgApi: { sendNudge } });
        await action(registry, "send_friend_nudge").handle({ user_id: 20002, is_self: true });
        expect(sendNudge).toHaveBeenCalledTimes(1);
    });

    it("self.uid 缺失 → -400", async () => {
        const { registry } = makeApi({ selfUid: "" });
        const res = await action(registry, "send_friend_nudge").handle({ user_id: 20002 });
        expect(res.retcode).toBe(-400);
    });
});

describe("peer_pins", () => {
    it("get_peer_pins：置顶过滤 + 实体套用 + 未命中跳过", async () => {
        const { registry } = makeApi({
            recentContactApi: {
                getPinnedContacts: vi.fn(async () => [
                    { peerUid: "uid-20002", scene: "friend" },
                    { peerUid: "30003", scene: "group" },
                    { peerUid: "uid-stranger", scene: "friend" },
                ]),
            },
            friendApi: {
                getFriendList: vi.fn(async () => [
                    { uid: "uid-20002", uin: "20002", nickname: "甲", remark: "" },
                ]),
            },
            groupCache: {
                listGroupsRefreshed: vi.fn(async () => [
                    { groupCode: "30003", groupName: "群", memberCount: 3, maxMember: 500 },
                ]),
            },
        });
        const res = await action(registry, "get_peer_pins").handle({});
        expect(res.retcode).toBe(0);
        expect(res.data).toEqual({
            friends: [
                {
                    user_id: 20002,
                    nickname: "甲",
                    sex: "unknown",
                    qid: "",
                    remark: "",
                    category: { category_id: 0, category_name: "" },
                },
            ],
            groups: [
                {
                    group_id: 30003,
                    group_name: "群",
                    member_count: 3,
                    max_member_count: 500,
                    remark: "",
                    created_time: 0,
                    description: "",
                    question: "",
                    announcement: "",
                },
            ],
        });
    });

    it("set_peer_pin：is_pinned 缺省 true + 场景透传", async () => {
        const setContactTop = vi.fn(async () => null);
        const { registry } = makeApi({ msgApi: { setContactTop } });
        await action(registry, "set_peer_pin").handle({
            message_scene: "group",
            peer_id: 10001,
        });
        expect(setContactTop).toHaveBeenCalledWith({ chatType: 2, peerUid: "10001" }, true);
    });
});

describe("群公告 / 头衔 / 群头像", () => {
    it("get_group_announcements：bulletin 宽松映射 + senderUid→uin", async () => {
        const { registry } = makeApi({
            groupApi: {
                getGroupAnnouncements: vi.fn(async () => [
                    {
                        announcementId: "a1",
                        senderUid: "uid-20002",
                        publishTime: 100,
                        content: "公告",
                    },
                ]),
            },
        });
        const res = await action(registry, "get_group_announcements").handle({ group_id: 10001 });
        expect(res.data).toEqual({
            announcements: [
                {
                    group_id: 10001,
                    announcement_id: "a1",
                    user_id: 20002,
                    time: 100,
                    content: "公告",
                    image_url: null,
                },
            ],
        });
    });

    it("send_group_announcement：file:// image_uri 展开后进 kernel", async () => {
        const publishGroupAnnouncement = vi.fn(async () => undefined);
        const { registry } = makeApi({
            groupApi: { publishGroupAnnouncement },
        });
        await action(registry, "send_group_announcement").handle({
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

    it("set_group_member_special_title：uin→uid 透传", async () => {
        const setMemberSpecialTitle = vi.fn(async () => undefined);
        const { registry } = makeApi({ groupApi: { setMemberSpecialTitle } });
        await action(registry, "set_group_member_special_title").handle({
            group_id: 10001,
            user_id: 20002,
            special_title: "头衔",
        });
        expect(setMemberSpecialTitle).toHaveBeenCalledWith("10001", "uid-20002", "头衔");
    });

    it("set_group_avatar：image_uri 展开 + 群号字符串", async () => {
        const setGroupAvatar = vi.fn(async () => undefined);
        const { registry } = makeApi({ groupApi: { setGroupAvatar } });
        await action(registry, "set_group_avatar").handle({
            group_id: 10001,
            image_uri: "file:///C:/pic/g.png",
        });
        expect(setGroupAvatar).toHaveBeenCalledWith("10001", expect.stringMatching(/g\.png$/));
    });
});

describe("表情 / 资源反查", () => {
    it("get_custom_face_url_list：urls 原样", async () => {
        const { registry } = makeApi({ msgApi: { queryFavEmojis: vi.fn(async () => ["u1"]) } });
        const res = await action(registry, "get_custom_face_url_list").handle({});
        expect(res.data).toEqual({ urls: ["u1"] });
    });

    it("get_resource_temp_url：链接形态原样返回", async () => {
        const { registry } = makeApi({});
        const res = await action(registry, "get_resource_temp_url").handle({
            resource_id: "https://multimedia.nt.qq.com/a",
        });
        expect(res.data).toEqual({ url: "https://multimedia.nt.qq.com/a" });
    });

    it("get_resource_temp_url：非链接形态 → NOT_FOUND", async () => {
        const { registry } = makeApi({});
        const res = await action(registry, "get_resource_temp_url").handle({
            resource_id: "C:\\cache\\x.jpg",
        });
        expect(res.retcode).not.toBe(0);
    });
});

describe("文件上传 / 下载链接 / 文件夹改名", () => {
    it("upload_private_file：file:// 本地路径 → file 元素发送 → file_id 取 fileUuid", async () => {
        const sendMessage = vi.fn(async () => ({ msgId: "msg-9" }));
        const fetchMsgsByMsgId = vi.fn(async () => [
            { elements: [{ elementType: 3, fileElement: { fileUuid: "uuid-9" } }] },
        ]);
        const { registry } = makeApi({ msgApi: { sendMessage, fetchMsgsByMsgId } });
        const res = await action(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "file:///C:/docs/a.zip",
            file_name: "a.zip",
        });
        expect(res.data).toEqual({ file_id: "uuid-9" });
        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ peerUid: "uid-20002" }),
            [{ type: "file", path: expect.stringMatching(/a\.zip$/), name: "a.zip" }],
        );
    });

    it("upload_private_file：fileUuid 缺失兜底 msgId", async () => {
        const fetchMsgsByMsgId = vi.fn(async () => [{ elements: [{ elementType: 3 }] }]);
        const { registry } = makeApi({ msgApi: { fetchMsgsByMsgId } });
        const res = await action(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "file:///C:/a.zip",
            file_name: "a.zip",
        });
        expect(res.data).toEqual({ file_id: "msg-1" });
    });

    it("upload_group_file：群 peer + parent_folder_id 仅 schema 兼容", async () => {
        const sendMessage = vi.fn(async () => ({ msgId: "msg-g" }));
        const { registry } = makeApi({ msgApi: { sendMessage } });
        const res = await action(registry, "upload_group_file").handle({
            group_id: 10001,
            parent_folder_id: "/",
            file_uri: "file:///C:/a.zip",
            file_name: "a.zip",
        });
        expect(res.retcode).toBe(0);
        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ chatType: 2, peerUid: "10001" }),
            expect.any(Array),
        );
    });

    it("get_group_file_download_url：download_url 透传", async () => {
        const { registry } = makeApi({
            richMediaApi: {
                getGroupFileDownloadUrl: vi.fn(async () => "https://dl/x"),
            },
        });
        const res = await action(registry, "get_group_file_download_url").handle({
            group_id: 10001,
            file_id: "f1",
        });
        expect(res.data).toEqual({ download_url: "https://dl/x" });
    });

    it("rename_group_folder：参数透传", async () => {
        const renameGroupFolder = vi.fn(async () => undefined);
        const { registry } = makeApi({ richMediaApi: { renameGroupFolder } });
        await action(registry, "rename_group_folder").handle({
            group_id: 10001,
            folder_id: "fd1",
            new_folder_name: "新名",
        });
        expect(renameGroupFolder).toHaveBeenCalledWith("10001", "fd1", "新名");
    });
});
