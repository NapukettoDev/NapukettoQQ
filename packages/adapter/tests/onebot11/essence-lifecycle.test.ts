import { setImmediate } from "node:timers/promises";
import type { EssenceMsgItem, GroupListener, MsgListener } from "@napuketto/kernel";
import { GroupListUpdateType, NTEventChannel } from "@napuketto/kernel";
import { expect, it, vi } from "vitest";
import type { OneBotApi } from "../../src/onebot11/api/onebot-api.js";
import { Ob11EventPipeline } from "../../src/onebot11/event-pipeline.js";

it.each(["leave", "stop"] as const)("OB11 中止在途精华反查和通知 (%s)", async (reason) => {
    const deferred = Promise.withResolvers<{ msgSeq: string; msgId: string }[]>();
    const fetchMessages = vi
        .fn()
        .mockReturnValueOnce(deferred.promise)
        .mockResolvedValue([{ msgSeq: "3", msgId: "new" }]);
    const alloc = vi.fn().mockReturnValue(123);
    const item = (msgSeq: number): EssenceMsgItem => ({
        msg_seq: msgSeq,
        sender_uin: "456",
        msg_content: [],
    });
    const getEssenceMsgList = vi
        .fn()
        .mockResolvedValueOnce([item(1)])
        .mockResolvedValueOnce([item(1), item(2)])
        .mockResolvedValueOnce([item(1)])
        .mockResolvedValue([item(1), item(3)]);
    const groupChannel = new NTEventChannel<GroupListener, "Group">("Group");
    const msgChannel = new NTEventChannel<MsgListener, "Msg">("Msg");
    const broadcast = vi.fn();
    const pipeline = new Ob11EventPipeline({
        selfUin: "123",
        api: {
            msgApi: { fetchMessages },
            messageUnique: { alloc },
            webApi: { getEssenceMsgList },
        } as unknown as OneBotApi,
        broadcast,
        groupChannel,
        msgChannel,
    });
    pipeline.subscribe();
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    await setImmediate();
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    await setImmediate();
    expect(fetchMessages).toHaveBeenCalledTimes(1);

    if (reason === "leave") {
        groupChannel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, []);
    } else {
        pipeline.unsubscribeAll();
    }
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    deferred.resolve([{ msgSeq: "2", msgId: "old" }]);
    await setImmediate();
    expect(getEssenceMsgList).toHaveBeenCalledTimes(2);
    expect(alloc).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();

    pipeline.subscribe();
    groupChannel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [
        {
            groupCode: "100",
            groupName: "fixture",
            memberCount: 1,
            maxMember: 100,
        },
    ]);
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    await setImmediate();
    expect(broadcast).not.toHaveBeenCalled();
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    await setImmediate();
    expect(alloc).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            notice_type: "group_essence",
            sub_type: "add",
            message_id: 123,
        }),
    );
    pipeline.unsubscribeAll();
});
