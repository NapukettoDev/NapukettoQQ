/**
 * Milky 消息操作域动作测试（message-ops.ts，域对齐重组，自
 * p3-message.test.ts / p1-message.test.ts / p2-batch2.test.ts 操作用例归并）
 *
 * 锁定：recall_* 的 seq 反查（命中撤回 / 未命中 NOT_FOUND / 负 seq -400）、
 * mark_message_as_read（seq 仅兼容 schema）、get_custom_face_url_list、
 * get_resource_temp_url 链接形态判定、upload_private_file 闪传通道
 * （peer 为好友 uid、file_id = fileSetId、失败透传、file_uri 空串 -400）。
 */
import { join } from "node:path";
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { actionOf, buildMilkyApi, indexableMsg, messageApi, registryOf } from "./test-support.js";

/** 可索引的原始消息（群聊文本；msgSeq 可覆写）。 */
function opIndexableMsg(seq: string, msgId = "m-idx") {
    return { ...indexableMsg(seq, msgId) };
}

describe("recall_private_message / recall_group_message", () => {
    it("群撤回：seq 索引命中 → recallMessage(peer, [msgId])", async () => {
        const recallMessage = vi.fn(async () => undefined);
        const api = buildMilkyApi({ msgApi: { recallMessage } });
        api.seqIndex.record(opIndexableMsg("150") as never);
        const registry = registryOf(api);
        const res = await actionOf(registry, "recall_group_message").handle({
            group_id: 10001,
            message_seq: 150,
        });
        expect(res.status).toBe("ok");
        expect(recallMessage).toHaveBeenCalledWith({ chatType: ChatType.GROUP, peerUid: "10001" }, [
            "m-idx",
        ]);
    });

    it("私聊撤回：C2C peer 解析（uin→uid）后撤回", async () => {
        const recallMessage = vi.fn(async () => undefined);
        const api = buildMilkyApi({ msgApi: { recallMessage } });
        api.seqIndex.record({
            ...opIndexableMsg("7"),
            chatType: ChatType.C2C,
            peerUid: "uid-20002",
        } as never);
        const registry = registryOf(api);
        const res = await actionOf(registry, "recall_private_message").handle({
            user_id: 20002,
            message_seq: 7,
        });
        expect(res.status).toBe("ok");
        expect(recallMessage).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "uid-20002" },
            ["m-idx"],
        );
    });

    it("seq 反查未命中 → NOT_FOUND（-404）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "recall_group_message").handle({
            group_id: 10001,
            message_seq: 424242,
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("消息 424242 不存在");
    });

    it("负 message_seq → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "recall_group_message").handle({
            group_id: 10001,
            message_seq: -1,
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("mark_message_as_read / get_custom_face_url_list", () => {
    it("mark_message_as_read：peer 解析后 markRead（seq 仅 schema 兼容）", async () => {
        const markRead = vi.fn(async () => undefined);
        const registry = messageApi({ msgApi: { markRead } });
        const res = await actionOf(registry, "mark_message_as_read").handle({
            message_scene: "temp",
            peer_id: 20002,
            message_seq: 1,
        });
        expect(res.status).toBe("ok");
        expect(markRead).toHaveBeenCalledWith({
            chatType: ChatType.C2C_TEMP,
            peerUid: "uid-20002",
        });
    });

    it("get_custom_face_url_list：urls 透传", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_custom_face_url_list").handle({});
        expect(res.data).toEqual({ urls: ["https://face.example/1.png"] });
    });

    it("mark_message_as_read：scene 缺失 → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "mark_message_as_read").handle({
            peer_id: 10001,
            message_seq: 1,
        });
        expect(res.retcode).toBe(-400);
    });

    it("按会话标记已读（p1 补测：seq 仅兼容 schema）", async () => {
        const markRead = vi.fn(async () => undefined);
        const registry = messageApi({ msgApi: { markRead } });
        const res = await actionOf(registry, "mark_message_as_read").handle({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 101,
        });
        expect(res).toMatchObject({ status: "ok", data: {} });
        expect(markRead).toHaveBeenCalledWith({ chatType: ChatType.GROUP, peerUid: "10001" });
    });

    it("get_custom_face_url_list：urls 原样（补测）", async () => {
        const registry = messageApi({ msgApi: { queryFavEmojis: vi.fn(async () => ["u1"]) } });
        const res = await actionOf(registry, "get_custom_face_url_list").handle({});
        expect(res.data).toEqual({ urls: ["u1"] });
    });
});

describe("get_resource_temp_url", () => {
    it("http(s)/base64 形态原样返回", async () => {
        const registry = messageApi({});
        for (const id of ["http://a.example/x", "https://a.example/x.png", "base64://aGVsbG8="]) {
            const res = await actionOf(registry, "get_resource_temp_url").handle({
                resource_id: id,
            });
            expect(res.data, id).toEqual({ url: id });
        }
    });

    it("非链接形态 → NOT_FOUND（-404）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_resource_temp_url").handle({
            resource_id: "/local/path.png",
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("resource_id 非链接形态");
    });

    it("空 resource_id → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_resource_temp_url").handle({ resource_id: "" });
        expect(res.retcode).toBe(-400);
    });

    it("链接形态原样返回（补测）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_resource_temp_url").handle({
            resource_id: "https://multimedia.nt.qq.com/a",
        });
        expect(res.data).toEqual({ url: "https://multimedia.nt.qq.com/a" });
    });

    it("非链接形态 → NOT_FOUND（补测）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_resource_temp_url").handle({
            resource_id: "C:\\cache\\x.jpg",
        });
        expect(res.retcode).not.toBe(0);
    });
});

describe("upload_private_file（闪传通道）", () => {
    it("走闪传 sendFile：peer 为好友 uid、file_id = fileSetId", async () => {
        const sendFile = vi.fn(async () => ({
            fileSetId: "fs-abc",
            shareLink: "https://qfile.qq.com/q/ABC",
            fileCount: 1,
        }));
        const registry = messageApi({ flashTransferApi: { sendFile } });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: join("tmp", "a.bin"),
            file_name: "a.bin",
        });
        expect(res.data).toEqual({ file_id: "fs-abc" });
        expect(sendFile).toHaveBeenCalledWith(
            expect.objectContaining({ peerUid: "uid-20002" }),
            [expect.stringMatching(/a\.bin$/)],
            { name: "a.bin" },
        );
    });

    it("闪传抛错 → 动作失败（不静默假成功）", async () => {
        const registry = messageApi({
            flashTransferApi: {
                sendFile: vi.fn(async () => {
                    throw new Error("闪传上传超时");
                }),
            },
        });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "b.bin",
            file_name: "b.bin",
        });
        expect(res.status).not.toBe("ok");
    });

    it("file_uri 空串 → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "",
            file_name: "x",
        });
        expect(res.retcode).toBe(-400);
    });

    it("file:// 本地路径 → 闪传 sendFile（补测）", async () => {
        const sendFile = vi.fn(async () => ({
            fileSetId: "fs-priv",
            shareLink: "",
            fileCount: 1,
        }));
        const registry = messageApi({ flashTransferApi: { sendFile } });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "file:///C:/docs/a.zip",
            file_name: "a.zip",
        });
        expect(res.data).toEqual({ file_id: "fs-priv" });
        expect(sendFile).toHaveBeenCalledWith(
            expect.objectContaining({ peerUid: "uid-20002" }),
            [expect.stringMatching(/a\.zip$/)],
            { name: "a.zip" },
        );
    });

    it("闪传失败 → 错误透传（不再兜底成假 file_id， 补测）", async () => {
        const registry = messageApi({
            flashTransferApi: {
                sendFile: vi.fn(async () => {
                    throw new Error("闪传上传超时");
                }),
            },
        });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "file:///C:/a.zip",
            file_name: "a.zip",
        });
        expect(res.retcode).not.toBe(0);
    });
});
