import { setImmediate } from "node:timers/promises";
import type { GroupListener, MsgListener } from "@napuketto/kernel";
import { GroupListUpdateType, NTEventChannel } from "@napuketto/kernel";
import { expect, it, vi } from "vitest";
import type { MilkyInboundBase } from "../../src/milky/api.js";
import { MilkyEventPipeline } from "../../src/milky/event-pipeline.js";
import { MilkyInboundEssence } from "../../src/milky/inbound/essence.js";

it("Milky 退群和停用后清理快路径去重，重订阅后从新基线开始", async () => {
    const getEssenceMsgList = vi.fn().mockResolvedValue([]);
    const deps = {
        api: { self: { uin: "123" }, webApi: { getEssenceMsgList } },
        broadcast: vi.fn(),
    } as unknown as MilkyInboundBase;
    const essence = new MilkyInboundEssence(deps);
    const groupChannel = new NTEventChannel<GroupListener, "Group">("Group");
    const msgChannel = new NTEventChannel<MsgListener, "Msg">("Msg");
    const pipeline = new MilkyEventPipeline({
        essence,
        groupChannel,
        msgChannel,
        request: { markStartup: vi.fn() },
    } as unknown as ConstructorParameters<typeof MilkyEventPipeline>[0]);
    const claim = () =>
        essence.claimFastPath("group_essence_message_change", {
            group_id: 100,
            message_seq: 2,
        });

    pipeline.subscribe();
    expect(claim()).toBe(true);
    expect(claim()).toBe(false);
    groupChannel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, []);
    expect(claim()).toBe(false);
    groupChannel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [
        {
            groupCode: "100",
            groupName: "fixture",
            memberCount: 1,
            maxMember: 100,
        },
    ]);
    expect(claim()).toBe(true);

    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    pipeline.unsubscribeAll();
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    await setImmediate();
    expect(getEssenceMsgList).not.toHaveBeenCalled();
    expect(claim()).toBe(false);

    pipeline.subscribe();
    expect(claim()).toBe(true);
    groupChannel.emit("Group/onGroupEssenceListChange", "100");
    await setImmediate();
    expect(getEssenceMsgList).toHaveBeenCalledExactlyOnceWith("100");
    expect(deps.broadcast).not.toHaveBeenCalled();
    pipeline.unsubscribeAll();
});
