import { expect, it, vi } from "vitest";
import { GroupApi } from "../../src/apis/group/group.js";
import type {
    GeneralCallResult,
    KickMemberV2Req,
    NodeIKernelGroupService,
    NodeIKernelMsgService,
    NodeIQQNTWrapperSession,
} from "../../src/types/index.js";

function fixture(result: GeneralCallResult) {
    const kick = vi
        .fn<(request: KickMemberV2Req) => Promise<GeneralCallResult>>()
        .mockResolvedValue(result);
    const group: Partial<NodeIKernelGroupService> = {
        getGroupList: vi.fn(),
        getGroupDetailInfo: vi.fn(),
        getAllMemberList: vi.fn(),
        kickMemberV2: kick,
    };
    const msg: Partial<NodeIKernelMsgService> = { getMsgsByMsgId: vi.fn() };
    const session: Partial<NodeIQQNTWrapperSession> = {
        getGroupService: () => group as NodeIKernelGroupService,
        getMsgService: () => msg as NodeIKernelMsgService,
    };
    return { api: new GroupApi(session as NodeIQQNTWrapperSession), kick };
}

it.each([
    { refuseForever: false, optFlag: 1 },
    { refuseForever: true, optFlag: 0 },
])("按当前约定组装踢人请求 refuseForever=$refuseForever", async ({ refuseForever, optFlag }) => {
    const { api, kick } = fixture({ result: 0, errMsg: "" });
    await expect(
        api.kickMember("100", ["u_fixture"], refuseForever, "test"),
    ).resolves.toBeUndefined();
    expect(kick).toHaveBeenCalledExactlyOnceWith({
        groupCode: "100",
        kickFlag: 0,
        kickList: [{ optFlag, optOperate: 0, optMemberUid: "u_fixture", optBytesMsg: "" }],
        kickListUids: ["u_fixture"],
        kickMsg: "test",
    });
});

it("原生非零结果沿当前错误契约返回 UNKNOWN", async () => {
    const { api } = fixture({ result: 9, errMsg: "synthetic denial" });
    await expect(api.kickMember("100", ["u_fixture"], false)).rejects.toMatchObject({
        code: "UNKNOWN",
        message: "kickMemberV2 失败: synthetic denial",
    });
});

it("成员列表为空时在原生边界前拒绝", async () => {
    const { api, kick } = fixture({ result: 0, errMsg: "" });
    await expect(api.kickMember("100", [], false)).rejects.toMatchObject({ code: "INVALID_PARAM" });
    expect(kick).not.toHaveBeenCalled();
});
