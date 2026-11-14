/**
 * Milky 动作注册表面测试
 *
 * 锁定：前九动作名齐、全量 64 动作名齐、
 * get_impl_info 版本面、schema 解析失败 retcode=-400。
 */
import { describe, expect, it } from "vitest";
import { buildMilkyApi, registryOf } from "./test-support.js";

describe("createMilkyActionRegistry", () => {
    it("前九动作名齐（注册顺序 = 领域工厂顺序）", () => {
        const registry = registryOf(buildMilkyApi());
        expect(registry.names.slice(0, 9)).toEqual([
            "get_login_info",
            "get_impl_info",
            "send_private_message",
            "send_group_message",
            "get_message",
            "get_history_messages",
            "get_forwarded_messages",
            "recall_private_message",
            "recall_group_message",
        ]);
    });

    it("get_impl_info：milky_version=1.3 + impl_name=napukettoqq", async () => {
        const registry = registryOf(buildMilkyApi());
        const result = await registry.get("get_impl_info")?.handle({});
        expect(result?.status).toBe("ok");
        expect(result?.data).toMatchObject({
            impl_name: "napukettoqq",
            qq_protocol_type: "windows",
            milky_version: "1.3",
        });
    });

    it("参数解析失败 → retcode=-400", async () => {
        const registry = registryOf(buildMilkyApi());
        const result = await registry
            .get("send_group_message")
            ?.handle({ group_id: "not-a-number" });
        expect(result?.retcode).toBe(-400);
        expect(result?.status).toBe("failed");
    });
});

describe("注册表面", () => {
    it("64 动作名齐", () => {
        const registry = registryOf(buildMilkyApi());
        const names = registry.names;
        expect(names).toHaveLength(64);
        expect(names.slice(0, 9)).toEqual([
            "get_login_info",
            "get_impl_info",
            "send_private_message",
            "send_group_message",
            "get_message",
            "get_history_messages",
            "get_forwarded_messages",
            "recall_private_message",
            "recall_group_message",
        ]);
        expect(names).toContain("get_history_messages");
        expect(names).toContain("get_group_notifications");
        expect(names).toContain("create_group_folder");
        expect(names).toContain("get_csrf_token");
        expect(names).toContain("send_friend_nudge");
        expect(names).toContain("send_group_nudge");
        expect(names).toContain("get_peer_pins");
        expect(names).toContain("set_peer_pin");
        expect(names).toContain("get_group_announcements");
        expect(names).toContain("send_group_announcement");
        expect(names).toContain("delete_group_announcement");
        expect(names).toContain("set_group_avatar");
        expect(names).toContain("set_group_member_special_title");
        expect(names).toContain("get_custom_face_url_list");
        expect(names).toContain("get_resource_temp_url");
        expect(names).toContain("upload_private_file");
        expect(names).toContain("upload_group_file");
        expect(names).toContain("get_group_file_download_url");
        expect(names).toContain("rename_group_folder");
    });
});
