/**
 * 精华/荣誉动作测试：get_essence_msg_list / set_essence_msg / delete_essence_msg /
 * get_group_honor_info。
 *
 * 锁定行为：msg_content text/image 映射与未知类型丢弃、message_id 反查（MessageUnique）
 * 与非群消息拒绝（INVALID_PARAM）、set/delete 分别走 addGroupEssence/removeGroupEssence、
 * 荣誉 type 字符串 → WebHonorType 映射（缺省 all）。
 */
import { ChatType, WebHonorType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { MessageUnique } from "../../../helper/message-unique.js";
import {
    DeleteEssenceMsgAction,
    GetEssenceMsgListAction,
    GetGroupHonorInfoAction,
    SetEssenceMsgAction,
} from "../essence.js";

describe("get_essence_msg_list", () => {
    it("EssenceMsgItem → OB11 结构（text/image 段映射）", async () => {
        const webApi = {
            getEssenceMsgList: vi.fn(async () => [
                {
                    msg_seq: 1300,
                    msg_random: 7,
                    sender_uin: "20002",
                    sender_nick: "甲",
                    add_digest_uin: "10000",
                    add_digest_nick: "操作者",
                    add_digest_time: 1760000000,
                    msg_content: [
                        { msg_type: 1, text: "精华文本" },
                        { msg_type: 3, image_url: "https://img.example/1.png" },
                        { msg_type: 9, unknown: true },
                    ],
                },
            ]),
        };
        const action = new GetEssenceMsgListAction(webApi as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(webApi.getEssenceMsgList).toHaveBeenCalledWith("808");
        expect(result.data?.[0]).toMatchObject({
            msg_seq: 1300,
            msg_random: 7,
            sender_id: 20002,
            sender_nick: "甲",
            operator_id: 10000,
            operator_nick: "操作者",
            operator_time: 1760000000,
            message_id: 0,
        });
        expect(result.data?.[0]?.content).toEqual([
            { type: "text", data: { text: "精华文本" } },
            { type: "image", data: { file: "https://img.example/1.png" } },
        ]);
    });

    it("text 段缺 text / image 段缺 image_url → 空串兜底", async () => {
        const webApi = {
            getEssenceMsgList: vi.fn(async () => [
                {
                    msg_seq: 2,
                    msg_random: 2,
                    sender_uin: "2",
                    sender_nick: "乙",
                    add_digest_uin: "1",
                    add_digest_nick: "op",
                    add_digest_time: 1,
                    msg_content: [{ msg_type: 1 }, { msg_type: 3 }],
                },
            ]),
        };
        const action = new GetEssenceMsgListAction(webApi as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.data?.[0]?.content).toEqual([
            { type: "text", data: { text: "" } },
            { type: "image", data: { file: "" } },
        ]);
    });

    it("msg_content 缺失 → content 空数组", async () => {
        const webApi = {
            getEssenceMsgList: vi.fn(async () => [
                {
                    msg_seq: 1,
                    msg_random: 1,
                    sender_uin: "2",
                    sender_nick: "乙",
                    add_digest_uin: "1",
                    add_digest_nick: "op",
                    add_digest_time: 0,
                },
            ]),
        };
        const action = new GetEssenceMsgListAction(webApi as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.data?.[0]?.content).toEqual([]);
    });
});

describe("set_essence_msg / delete_essence_msg", () => {
    /** 构造已分配群消息的 MessageUnique（message_id=1 ↔ msgId=nt-1，群 808）。 */
    function uniqueWithGroupMsg(): MessageUnique {
        const unique = new MessageUnique();
        unique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        return unique;
    }

    it("群消息 message_id → addGroupEssence(group, msgId)", async () => {
        const groupApi = { addGroupEssence: vi.fn(async () => undefined) };
        const action = new SetEssenceMsgAction({
            groupApi,
            messageUnique: uniqueWithGroupMsg(),
        } as never);
        const result = await action.handle({ message_id: 1 });
        expect(result.retcode).toBe(0);
        expect(groupApi.addGroupEssence).toHaveBeenCalledWith("808", "nt-1");
    });

    it("字符串 message_id 同样反查 → removeGroupEssence", async () => {
        const groupApi = { removeGroupEssence: vi.fn(async () => undefined) };
        const action = new DeleteEssenceMsgAction({
            groupApi,
            messageUnique: uniqueWithGroupMsg(),
        } as never);
        const result = await action.handle({ message_id: "1" });
        expect(result.retcode).toBe(0);
        expect(groupApi.removeGroupEssence).toHaveBeenCalledWith("808", "nt-1");
    });

    it("message_id 未登记 → retcode 102 NOT_FOUND", async () => {
        const action = new SetEssenceMsgAction({
            groupApi: {},
            messageUnique: new MessageUnique(),
        } as never);
        const result = await action.handle({ message_id: 999 });
        expect(result.retcode).toBe(102);
    });

    it("私聊消息 → retcode 105 INVALID_PARAM（精华仅支持群聊）", async () => {
        const unique = new MessageUnique();
        unique.alloc("nt-c2c", { chatType: ChatType.C2C, peerUid: "u90001" });
        const groupApi = { addGroupEssence: vi.fn(async () => undefined) };
        const action = new SetEssenceMsgAction({ groupApi, messageUnique: unique } as never);
        const result = await action.handle({ message_id: 1 });
        expect(result.retcode).toBe(105);
        expect(groupApi.addGroupEssence).not.toHaveBeenCalled();
    });

    it("alloc 未记录 peer → retcode 102（无会话记录）", async () => {
        const unique = new MessageUnique();
        unique.alloc("nt-no-peer");
        const action = new SetEssenceMsgAction({ groupApi: {}, messageUnique: unique } as never);
        const result = await action.handle({ message_id: 1 });
        expect(result.retcode).toBe(102);
    });
});

describe("get_group_honor_info", () => {
    it("type 缺省 → WebHonorType.ALL 透传返回值", async () => {
        const honor = { gid: 808 };
        const webApi = { getGroupHonorInfo: vi.fn(async () => honor) };
        const action = new GetGroupHonorInfoAction(webApi as never);
        const result = await action.handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(result.data).toBe(honor);
        expect(webApi.getGroupHonorInfo).toHaveBeenCalledWith("808", WebHonorType.ALL);
    });

    it("type 四个合法值逐一映射", async () => {
        const webApi = { getGroupHonorInfo: vi.fn(async () => ({})) };
        const action = new GetGroupHonorInfoAction(webApi as never);
        await action.handle({ group_id: 808, type: "talkative" });
        expect(webApi.getGroupHonorInfo).toHaveBeenLastCalledWith("808", WebHonorType.TALKATIVE);
        await action.handle({ group_id: 808, type: "performer" });
        expect(webApi.getGroupHonorInfo).toHaveBeenLastCalledWith("808", WebHonorType.PERFORMER);
        await action.handle({ group_id: 808, type: "legend" });
        expect(webApi.getGroupHonorInfo).toHaveBeenLastCalledWith("808", WebHonorType.LEGEND);
        await action.handle({ group_id: 808, type: "emotion" });
        expect(webApi.getGroupHonorInfo).toHaveBeenLastCalledWith("808", WebHonorType.EMOTION);
    });

    it("未知 type 字符串 → 回退 ALL（表驱动宽容）", async () => {
        const webApi = { getGroupHonorInfo: vi.fn(async () => ({})) };
        const action = new GetGroupHonorInfoAction(webApi as never);
        await action.handle({ group_id: 808, type: "bogus" });
        expect(webApi.getGroupHonorInfo).toHaveBeenLastCalledWith("808", WebHonorType.ALL);
    });
});
