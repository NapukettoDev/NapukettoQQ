/**
 * Milky P1 动作测试：群通知 / 精华列表 / 群文件实体映射 + schema -400 + 注册表面
 *
 * kernel apis 桩：groupNotifyApi / webApi / richMediaApi / uidToUin。
 * 锁定：通知类型→实体五变体映射（uid→uin）、客户端分页（limit/next）、
 * 精华 msg_content 近似翻译、群文件/文件夹实体字段、注册表 42 动作名齐。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { GroupNotifyMsgStatus, GroupNotifyMsgType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { MilkyApi } from "../api.js";
import { MessageSeqIndex } from "../helper/seq-index.js";
import type { GroupNotificationEntity } from "../types.js";
import { createMilkyActionRegistry } from "./index.js";

/** 通知桩（user1/user2 固定 uid，经 uidToUin 桩转 uin）。 */
function notify(type: GroupNotifyMsgType): GroupNotify {
    return {
        seq: "88001",
        type,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        group: { groupCode: "10001", groupName: "群" },
        user1: { uid: "uid-20002", nickName: "甲" },
        user2: { uid: "uid-30003", nickName: "乙" },
        postscript: "求入",
    };
}

/** 构造 MilkyApi（P1 依赖桩）。 */
function makeApi(stubs: { notifies?: GroupNotify[]; essence?: unknown[]; files?: unknown[] }): {
    api: MilkyApi;
    registry: ReturnType<typeof createMilkyActionRegistry>;
} {
    const api = new MilkyApi(
        {
            msgApi: {},
            groupApi: {
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(
                    async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("uid-", "")])),
                ),
            },
            friendApi: {},
            profileApi: {},
            profileLikeApi: {},
            ticketApi: {},
            webApi: {
                getEssenceMsgList: vi.fn(async () => stubs.essence ?? []),
            },
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => stubs.notifies ?? []),
            },
            richMediaApi: {
                getGroupFileList: vi.fn(async () => stubs.files ?? []),
            },
            self: { uin: "10000", nickname: "机器人", uid: "uid-10000" },
        } as unknown as ConstructorParameters<typeof MilkyApi>[0],
        new MessageSeqIndex(),
    );
    return { api, registry: createMilkyActionRegistry({ api }) };
}

describe("P1 注册表面", () => {
    it("49 动作名齐（P0 九个保持前缀）", () => {
        const { registry } = makeApi({});
        const names = registry.names;
        expect(names).toHaveLength(49);
        expect(names.slice(0, 9)).toEqual([
            "get_login_info",
            "get_impl_info",
            "send_private_message",
            "send_group_message",
            "get_message",
            "recall_private_message",
            "recall_group_message",
            "get_friend_list",
            "get_group_list",
        ]);
        expect(names).toContain("get_history_messages");
        expect(names).toContain("get_group_notifications");
        expect(names).toContain("create_group_folder");
        expect(names).toContain("get_csrf_token");
    });
});

describe("get_group_notifications", () => {
    it("通知类型 → 实体五变体映射（uid→uin 转换）", async () => {
        const { registry } = makeApi({
            notifies: [
                notify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS),
                notify(GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS),
                notify(GroupNotifyMsgType.SET_ADMIN),
                notify(GroupNotifyMsgType.KICK_MEMBER_NOTIFY_KICKED),
                notify(GroupNotifyMsgType.MEMBER_LEAVE_NOTIFY_ADMIN),
            ],
        });
        const result = await registry.get("get_group_notifications")?.handle({ limit: 20 });
        expect(result?.status).toBe("ok");
        const data = result?.data as
            | { notifications: GroupNotificationEntity[]; next_notification_seq: number | null }
            | undefined;
        const types = (data?.notifications ?? []).map((n) => n.type);
        expect(types).toEqual([
            "join_request",
            "invited_join_request",
            "admin_change",
            "kick",
            "quit",
        ]);
        const [join, invited, admin] = data?.notifications ?? [];
        expect(join).toMatchObject({
            initiator_id: 20002,
            notification_seq: 88001,
            comment: "求入",
            operator_id: null,
        });
        expect(invited).toMatchObject({ initiator_id: 20002, target_user_id: 30003 });
        expect(admin).toMatchObject({ target_user_id: 20002, is_set: true, operator_id: 30003 });
    });

    it("start_notification_seq 客户端过滤 + limit 截断出 next", async () => {
        const { registry } = makeApi({
            notifies: [
                notify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS),
                notify(GroupNotifyMsgType.MEMBER_LEAVE_NOTIFY_ADMIN),
            ],
        });
        // 全量 2 条；limit=1 → 1 条 + next = 88001
        const result = await registry.get("get_group_notifications")?.handle({ limit: 1 });
        const data = result?.data as
            | { notifications: unknown[]; next_notification_seq: number | null }
            | undefined;
        expect(data?.notifications).toHaveLength(1);
        expect(data?.next_notification_seq).toBe(88001);
        // start=88002 → 全部（seq < 88002）；limit 缺省 20 → 无 next
        const all = await registry
            .get("get_group_notifications")
            ?.handle({ start_notification_seq: 88002 });
        const allData = all?.data as
            | { notifications: unknown[]; next_notification_seq: number | null }
            | undefined;
        expect(allData?.notifications).toHaveLength(2);
        expect(allData?.next_notification_seq).toBeNull();
    });
});

describe("get_group_essence_messages", () => {
    it("msg_content 近似翻译（text/image）+ 客户端分页", async () => {
        const { registry } = makeApi({
            essence: [
                {
                    msg_seq: 1300,
                    msg_random: 1,
                    sender_uin: "20002",
                    sender_nick: "甲",
                    add_digest_uin: "10000",
                    add_digest_nick: "机器人",
                    add_digest_time: 1760000000,
                    msg_content: [
                        { msg_type: 1, text: "精华文本" },
                        { msg_type: 2, image_url: "https://img.example/1.png" },
                    ],
                },
            ],
        });
        const result = await registry
            .get("get_group_essence_messages")
            ?.handle({ group_id: 10001, page_index: 0, page_size: 20 });
        const essenceData = result?.data as
            | { messages: Record<string, unknown>[]; is_end: boolean }
            | undefined;
        expect(essenceData?.is_end).toBe(true);
        const [msg] = essenceData?.messages ?? [];
        expect(msg).toMatchObject({
            group_id: 10001,
            message_seq: 1300,
            sender_id: 20002,
            sender_name: "甲",
            operator_id: 10000,
            operator_name: "机器人",
        });
        expect(msg?.["segments"]).toEqual([
            { type: "text", data: { text: "精华文本" } },
            {
                type: "image",
                data: {
                    resource_id: "https://img.example/1.png",
                    temp_url: "https://img.example/1.png",
                    width: 0,
                    height: 0,
                    summary: "",
                    sub_type: "normal",
                },
            },
        ]);
    });
});

describe("get_group_files", () => {
    it("文件/文件夹实体字段映射", async () => {
        const { registry } = makeApi({
            files: [
                {
                    fileInfo: {
                        fileId: "f1",
                        fileName: "a.zip",
                        fileSize: "2048",
                        parent: "",
                        uploadTime: 1760000000,
                        uploaderUin: "20002",
                    },
                },
                {
                    folderInfo: {
                        folderId: "d1",
                        folderName: "资料",
                        folderUid: "",
                        createTime: 1760000000,
                        modifyTime: 1760000001,
                        totalFileCount: 3,
                    },
                },
            ],
        });
        const result = await registry.get("get_group_files")?.handle({ group_id: 10001 });
        const fileData = result?.data as { files: unknown[]; folders: unknown[] } | undefined;
        expect(fileData?.files).toEqual([
            {
                group_id: 10001,
                file_id: "f1",
                file_name: "a.zip",
                parent_folder_id: "",
                file_size: 2048,
                uploaded_time: 1760000000,
                expire_time: null,
                uploader_id: 20002,
                downloaded_times: 0,
            },
        ]);
        expect(fileData?.folders).toEqual([
            {
                group_id: 10001,
                folder_id: "d1",
                parent_folder_id: "",
                folder_name: "资料",
                created_time: 1760000000,
                last_modified_time: 1760000001,
                creator_id: 0,
                file_count: 3,
            },
        ]);
    });
});

describe("P1 动作 schema", () => {
    it("accept_group_request：notification_type 非法 → -400", async () => {
        const { registry } = makeApi({});
        const result = await registry.get("accept_group_request")?.handle({
            notification_seq: 1,
            notification_type: "bogus",
            group_id: 10001,
        });
        expect(result?.retcode).toBe(-400);
    });

    it("send_group_message_reaction：缺 reaction → -400", async () => {
        const { registry } = makeApi({});
        const result = await registry.get("send_group_message_reaction")?.handle({
            group_id: 10001,
            message_seq: 1,
        });
        expect(result?.retcode).toBe(-400);
    });

    it("create_group_folder：空 folder_name → -400", async () => {
        const { registry } = makeApi({});
        const result = await registry
            .get("create_group_folder")
            ?.handle({ group_id: 10001, folder_name: "" });
        expect(result?.retcode).toBe(-400);
    });

    it("get_history_messages：缺 message_scene → -400", async () => {
        const { registry } = makeApi({});
        const result = await registry
            .get("get_history_messages")
            ?.handle({ peer_id: 10001, limit: 20 });
        expect(result?.retcode).toBe(-400);
    });
});
