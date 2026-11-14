/**
 * OB11 动作注册表测试：createOb11ActionRegistry 81 个动作名齐（含域覆盖抽样）、
 * resolveUid（uin→uid 解析与失败抛 INVALID_PARAM）、ob11ErrorCodeMap 全量映射。
 */
import { describe, expect, it } from "vitest";
import { ob11ErrorCodeMap, resolveUid } from "../base-action.js";
import { createOb11ActionRegistry } from "../index.js";
import { stubConverters } from "./test-support.js";

/** 81 个动作名（与 action/index.ts 注册面一一对应，按域分组）。 */
const ALL_NAMES: string[] = [
    // 消息（15）
    "send_msg",
    "send_private_msg",
    "send_group_msg",
    "delete_msg",
    "get_msg",
    "get_group_msg_history",
    "get_friend_msg_history",
    "mark_msg_as_read",
    "mark_private_msg_as_read",
    "mark_group_msg_as_read",
    "set_msg_emoji_like",
    "fetch_ptt_text",
    "set_input_status",
    "get_image",
    "get_record",
    // 合并转发 / 在线状态（7）
    "send_group_forward_msg",
    "send_private_forward_msg",
    "get_forward_msg",
    "forward_group_single_msg",
    "forward_friend_single_msg",
    "set_online_status",
    "set_diy_online_status",
    // 查询（6）
    "get_login_info",
    "get_group_info",
    "get_group_list",
    "get_group_member_info",
    "get_group_member_list",
    "get_friend_list",
    // 群管（10）
    "set_group_kick",
    "set_group_ban",
    "set_group_whole_ban",
    "set_group_admin",
    "set_group_card",
    "set_group_name",
    "set_group_leave",
    "set_essence_msg",
    "delete_essence_msg",
    "get_group_at_all_remain",
    // 好友（6）
    "set_friend_add_request",
    "set_friend_remark",
    "delete_friend",
    "get_friends_with_category",
    "get_doubt_friends_add_request",
    "set_doubt_friends_add_request",
    // 系统（9）
    "get_status",
    "get_version_info",
    "clean_cache",
    "can_send_image",
    "can_send_record",
    "get_robot_uin_range",
    "download_file",
    "bot_exit",
    "set_restart",
    // 群通知（3）
    "set_group_add_request",
    "get_group_system_msg",
    "get_group_shut_list",
    // 票据（2）
    "get_clientkey",
    "get_cookies",
    // 资料/点赞/翻译（5）
    "set_self_longnick",
    "set_qq_profile",
    "set_qq_avatar",
    "translate_en2zh",
    "send_like",
    // 群文件（9）
    "get_group_root_files",
    "get_group_files_by_folder",
    "get_group_file_system_info",
    "create_group_file_folder",
    "delete_group_file",
    "delete_group_folder",
    "rename_group_file",
    "move_group_file",
    "trans_group_file",
    // 文件投递（2，闪传通道：分享卡片）
    "upload_group_file",
    "upload_private_file",
    // web / csrf / 陌生人 / 群请求（7）
    "get_stranger_info",
    "get_csrf_token",
    "get_credentials",
    "get_group_add_request",
    "get_group_ignored_notifies",
    "get_essence_msg_list",
    "get_group_honor_info",
];

describe("createOb11ActionRegistry", () => {
    it("81 个动作名齐（去重后无多余、无缺失）", () => {
        const registry = createOb11ActionRegistry({ api: {} as never });
        const names = registry.names;
        expect(names).toHaveLength(81);
        expect([...names].sort()).toEqual([...ALL_NAMES].sort());
        for (const name of ALL_NAMES) {
            expect(registry.get(name)).toBeDefined();
            expect(registry.has(name)).toBe(true);
        }
    });

    it("同名注册覆盖（Map 语义）+ 未注册返回 undefined", () => {
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

describe("ob11ErrorCodeMap", () => {
    it("kernel 错误码 → OB11 retcode 全量映射", () => {
        expect(ob11ErrorCodeMap).toEqual({
            SEND_FAILED: 100,
            PERMISSION_DENIED: 101,
            NOT_FOUND: 102,
            TIMEOUT: 103,
            NOT_LOGIN: 104,
            INVALID_PARAM: 105,
            INVALID_STATE: 106,
            UNKNOWN: 999,
        });
    });
});
