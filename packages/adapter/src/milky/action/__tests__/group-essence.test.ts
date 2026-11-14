/**
 * Milky 群精华与表态域动作测试（group-essence.ts，域对齐重组）
 *
 * 锁定：精华 seq→msgId 反查（NOT_FOUND）、msg_content 近似翻译（text/image）与
 * 客户端分页、空文本空图片跳过、表情表态 reaction_type 映射（face→1/emoji→2）
 * 与 is_add 缺省、reaction 空串 -400。
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { actionOf, buildMilkyApi, groupRegistry, registryOf } from "./test-support.js";

describe("精华消息（set / list）", () => {
    it("set_group_essence_message：seq→msgId 反查后 addGroupEssence（is_set 缺省）", async () => {
        const addGroupEssence = vi.fn(async () => undefined);
        const api = buildMilkyApi({ groupApi: { addGroupEssence } });
        // 预登记 seq 索引（chatType GROUP + peerUid 10001 + seq 150）
        api.seqIndex.record({
            msgId: "m-150",
            msgSeq: "150",
            msgTime: "1760000000000",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "20002",
            senderUid: "uid-20002",
            elements: [],
        } as never);
        const registry = registryOf(api);
        const res = await actionOf(registry, "set_group_essence_message").handle({
            group_id: 10001,
            message_seq: 150,
        });
        expect(res.status).toBe("ok");
        expect(addGroupEssence).toHaveBeenCalledWith("10001", "m-150");
    });

    it("set_group_essence_message：is_set=false → removeGroupEssence", async () => {
        const removeGroupEssence = vi.fn(async () => undefined);
        const api = buildMilkyApi({ groupApi: { removeGroupEssence } });
        api.seqIndex.record({
            msgId: "m-9",
            msgSeq: "9",
            msgTime: "1760000000000",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "20002",
            senderUid: "uid-20002",
            elements: [],
        } as never);
        const registry = registryOf(api);
        await actionOf(registry, "set_group_essence_message").handle({
            group_id: 10001,
            message_seq: 9,
            is_set: false,
        });
        expect(removeGroupEssence).toHaveBeenCalledWith("10001", "m-9");
    });

    it("seq 反查未命中（近段扫描也无）→ NOT_FOUND", async () => {
        const fetchMessages = vi.fn(async () => []);
        const registry = groupRegistry({ msgApi: { fetchMessages } });
        const res = await actionOf(registry, "set_group_essence_message").handle({
            group_id: 10001,
            message_seq: 999,
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("消息 999 不存在");
    });

    it("get_group_essence_messages：客户端分页 + is_end 判定", async () => {
        const essenceItem = () => ({
            msg_seq: 1,
            msg_random: 0,
            sender_uin: "20002",
            sender_nick: "甲",
            add_digest_uin: "10000",
            add_digest_nick: "机器人",
            add_digest_time: 1760000000,
            msg_content: [],
        });
        const getEssenceMsgList = vi.fn(async () => [essenceItem(), essenceItem(), essenceItem()]);
        const registry = groupRegistry({ webApi: { getEssenceMsgList } });
        const page = await actionOf(registry, "get_group_essence_messages").handle({
            group_id: 10001,
            page_index: 1,
            page_size: 2,
        });
        const pageData = page.data as { messages: unknown[]; is_end: boolean };
        expect(pageData.messages).toHaveLength(1);
        expect(pageData.is_end).toBe(true);
        const first = await actionOf(registry, "get_group_essence_messages").handle({
            group_id: 10001,
            page_index: 0,
            page_size: 2,
        });
        const firstData = first.data as { messages: unknown[]; is_end: boolean };
        expect(firstData.messages).toHaveLength(2);
        expect(firstData.is_end).toBe(false);
    });

    it("get_group_essence_messages：空文本空图片的 msg_content 跳过", async () => {
        const getEssenceMsgList = vi.fn(async () => [
            {
                msg_seq: 5,
                sender_uin: "",
                sender_nick: "n",
                add_digest_uin: "x",
                add_digest_nick: "op",
                add_digest_time: 0,
                msg_content: [
                    { msg_type: 1, text: "" },
                    { msg_type: 2, image_url: "" },
                ],
            },
        ]);
        const registry = groupRegistry({ webApi: { getEssenceMsgList } });
        const res = await actionOf(registry, "get_group_essence_messages").handle({
            group_id: 10001,
            page_index: 0,
            page_size: 10,
        });
        const data = res.data as {
            messages: Array<{ sender_id: number; operator_id: number; segments: unknown[] }>;
        };
        expect(data.messages[0]?.segments).toEqual([]);
        expect(data.messages[0]?.sender_id).toBe(0);
        expect(data.messages[0]?.operator_id).toBe(0);
    });
});

describe("get_group_essence_messages（补充：近似翻译 + 分页）", () => {
    it("msg_content 近似翻译（text/image）+ 客户端分页", async () => {
        const registry = groupRegistry({
            webApi: {
                getEssenceMsgList: vi.fn(async () => [
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
                ]),
            },
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

describe("send_group_message_reaction", () => {
    it("face + is_add 缺省：emojiType=1 / like=true", async () => {
        const setMsgEmojiLike = vi.fn(async () => undefined);
        const registry = groupRegistry({ msgApi: { setMsgEmojiLike } });
        const res = await actionOf(registry, "send_group_message_reaction").handle({
            group_id: 10001,
            message_seq: 150,
            reaction: "76",
        });
        expect(res.status).toBe("ok");
        expect(setMsgEmojiLike).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { msgSeq: "150", emojiId: "76", emojiType: "1", like: true },
        );
    });

    it("emoji + is_add=false：emojiType=2 / like=false", async () => {
        const setMsgEmojiLike = vi.fn(async () => undefined);
        const registry = groupRegistry({ msgApi: { setMsgEmojiLike } });
        await actionOf(registry, "send_group_message_reaction").handle({
            group_id: 10001,
            message_seq: 150,
            reaction: "5",
            reaction_type: "emoji",
            is_add: false,
        });
        expect(setMsgEmojiLike).toHaveBeenCalledWith(expect.anything(), {
            msgSeq: "150",
            emojiId: "5",
            emojiType: "2",
            like: false,
        });
    });

    it("reaction 空串 → -400", async () => {
        const registry = groupRegistry({});
        const res = await actionOf(registry, "send_group_message_reaction").handle({
            group_id: 10001,
            message_seq: 1,
            reaction: "",
        });
        expect(res.retcode).toBe(-400);
    });

    it("缺 reaction → -400（schema 补测）", async () => {
        const registry = groupRegistry({});
        const result = await registry.get("send_group_message_reaction")?.handle({
            group_id: 10001,
            message_seq: 1,
        });
        expect(result?.retcode).toBe(-400);
    });
});
