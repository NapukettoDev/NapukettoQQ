/**
 * group.ts GroupApi 类测试（extractGroupDetail 已有独立基线，本文件覆盖 API 面全量）：
 *  - constructor：group/msg service 空各抛 INVALID_STATE
 *  - 查询：getGroupList / getGroupInfo（三种形状 + 失败）/ getGroupMemberList /
 *    getGroupMemberInfo / uinToUid / uidToUin / getGroupRemainAtTimes
 *  - 群管：kickMember / setMemberShutUp / setGroupShutUp / setMemberRole /
 *    setMemberCardName / modifyGroupName / quitGroup / 精华消息
 *  - 公告：列表宽松提取 / 发布（带图两步）/ 删除 / 头衔 / 群头像
 *  - roleToString 三态映射
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { ChatType, NTGroupMemberRole } from "../../types/index.js";
import { GroupApi } from "../group.js";
import { makeSession } from "../test-support.js";

/** 构造 GroupApi（group service + msg service 桩）。 */
function makeApi(
    overrides: Record<string, unknown> = {},
    msgOverrides: Record<string, unknown> = {},
) {
    const service = {
        getGroupList: vi.fn(async () => ({ result: 0, errMsg: "" })),
        getGroupDetailInfo: vi.fn(async () => ({ result: 0, errMsg: "", groupCode: "10001" })),
        getAllMemberList: vi.fn(async () => ({
            errCode: 0,
            errMsg: "",
            result: { ids: [], infos: new Map([["u1", { uid: "u1" }]]), finish: true },
        })),
        getMemberInfo: vi.fn(async () => ({ result: 0, errMsg: "" })),
        getUidByUins: vi.fn(async () => ({ errCode: 0, errMsg: "", uids: new Map() })),
        getUinByUids: vi.fn(async () => ({ errCode: 0, errMsg: "", uins: new Map() })),
        kickMemberV2: vi.fn(async () => ({ result: 0, errMsg: "" })),
        setMemberShutUp: vi.fn(async () => ({ result: 0, errMsg: "" })),
        setGroupShutUp: vi.fn(async () => ({ result: 0, errMsg: "" })),
        modifyMemberRole: vi.fn(),
        modifyMemberCardName: vi.fn(),
        modifyGroupName: vi.fn(async () => ({ result: 0, errMsg: "" })),
        quitGroupV2: vi.fn(async () => ({ result: 0, errMsg: "" })),
        addGroupEssence: vi.fn(async () => null),
        removeGroupEssence: vi.fn(async () => null),
        getGroupBulletin: vi.fn(async () => ({ result: 0, bulletins: [] })),
        publishGroupBulletin: vi.fn(async () => null),
        deleteGroupBulletin: vi.fn(async () => null),
        setIdentityTitleInfo: vi.fn(async () => null),
        setHeader: vi.fn(async () => null),
        uploadGroupBulletinPic: vi.fn(async () => ({ result: 0, picId: "pic-1" })),
        getGroupRemainAtTimes: vi.fn(async () => ({
            errCode: 0,
            errMsg: "",
            atInfo: { canAtAll: true, remainAtAllCountForUin: 5, remainAtAllCountForGroup: 10 },
        })),
        ...overrides,
    };
    const msgService = {
        getMsgsByMsgId: vi.fn(async () => ({
            result: 0,
            errMsg: "",
            msgList: [{ msgId: "m1", msgRandom: 7, msgSeq: 42 }],
        })),
        ...msgOverrides,
    };
    const api = new GroupApi(
        makeSession({ getGroupService: () => service, getMsgService: () => msgService }),
    );
    return { api, service, msgService };
}

describe("GroupApi constructor", () => {
    it("getGroupService 空 → INVALID_STATE", () => {
        expect(
            () =>
                new GroupApi(
                    makeSession({ getGroupService: () => null, getMsgService: () => ({}) }),
                ),
        ).toThrow(/getGroupService\(\) 返回空/);
    });

    it("getGroupService 返回 undefined → INVALID_STATE", () => {
        expect(
            () =>
                new GroupApi(
                    makeSession({ getGroupService: () => undefined, getMsgService: () => ({}) }),
                ),
        ).toThrow(/getGroupService\(\) 返回空/);
    });

    it("getMsgService 空 → INVALID_STATE（精华消息依赖 msg service）", () => {
        expect(
            () =>
                new GroupApi(
                    makeSession({ getGroupService: () => ({}), getMsgService: () => null }),
                ),
        ).toThrow(/getMsgService\(\) 返回空/);
    });
});

describe("查询", () => {
    it("getGroupList：成功恒返回空数组（数据走 onGroupListUpdate 事件）", async () => {
        const { api, service } = makeApi();
        await expect(api.getGroupList(true)).resolves.toEqual([]);
        expect(service.getGroupList).toHaveBeenCalledWith(true);
    });

    it("getGroupList：result 非 0 抛 KernelError", async () => {
        const { api } = makeApi({
            getGroupList: vi.fn(async () => ({ result: 1, errMsg: "bad" })),
        });
        await expect(api.getGroupList()).rejects.toBeInstanceOf(KernelError);
    });

    it("getGroupInfo：详情在 result 对象内（result 即详情形状）", async () => {
        const detail = { groupCode: "10001", groupName: "g" };
        const { api } = makeApi({
            getGroupDetailInfo: vi.fn(async () => ({ result: { ...detail }, errMsg: "" })),
        });
        await expect(api.getGroupInfo("10001")).resolves.toMatchObject(detail);
    });

    it("getGroupInfo：详情在 groupInfo 字段", async () => {
        const info = { groupCode: "10002" };
        const { api } = makeApi({
            getGroupDetailInfo: vi.fn(async () => ({ result: 0, errMsg: "", groupInfo: info })),
        });
        await expect(api.getGroupInfo("10001")).resolves.toBe(info);
    });

    it("getGroupInfo：result 非 0 抛错", async () => {
        const { api } = makeApi({
            getGroupDetailInfo: vi.fn(async () => ({ result: -2, errMsg: "no such group" })),
        });
        await expect(api.getGroupInfo("10001")).rejects.toBeInstanceOf(KernelError);
    });

    it("getGroupInfo：形状异常抛 UNKNOWN（result=0 但无详情字段）", async () => {
        const { api } = makeApi({
            getGroupDetailInfo: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.getGroupInfo("10001")).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("getGroupMemberList：errCode=0 返回 infos 值数组", async () => {
        const { api } = makeApi();
        await expect(api.getGroupMemberList("10001")).resolves.toEqual([{ uid: "u1" }]);
    });

    it("getGroupMemberList：errCode 非 0 抛 UNKNOWN", async () => {
        const { api } = makeApi({
            getAllMemberList: vi.fn(async () => ({
                errCode: 5,
                errMsg: "fail",
                result: undefined,
            })),
        });
        await expect(api.getGroupMemberList("10001")).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("getGroupMemberInfo：uids 空直接返回空（不发原生调用）", async () => {
        const { api, service } = makeApi();
        await expect(api.getGroupMemberInfo("10001", [])).resolves.toEqual([]);
        expect(service.getMemberInfo).not.toHaveBeenCalled();
    });

    it("getGroupMemberInfo：infos Map 提取值数组", async () => {
        const { api } = makeApi({
            getMemberInfo: vi.fn(async () => ({
                result: 0,
                errMsg: "",
                infos: new Map([["u1", { uid: "u1" }]]),
            })),
        });
        await expect(api.getGroupMemberInfo("10001", ["u1"])).resolves.toEqual([{ uid: "u1" }]);
    });

    it("getGroupMemberInfo：infos 非 Map 形状 → 空数组（待校准兜底）", async () => {
        const { api } = makeApi({
            getMemberInfo: vi.fn(async () => ({ result: 0, errMsg: "", infos: "junk" })),
        });
        await expect(api.getGroupMemberInfo("10001", ["u1"])).resolves.toEqual([]);
    });

    it("uinToUid：空数组返回空 Map 不发调用；命中返回 Map", async () => {
        const { api, service } = makeApi({
            getUidByUins: vi.fn(async () => ({
                errCode: 0,
                errMsg: "",
                uids: new Map([["10001", "u-1"]]),
            })),
        });
        await expect(api.uinToUid([])).resolves.toEqual(new Map());
        await expect(api.uinToUid(["10001"])).resolves.toEqual(new Map([["10001", "u-1"]]));
        expect(service.getUidByUins).toHaveBeenCalledTimes(1);
    });

    it("uinToUid：errCode 非 0 抛 UNKNOWN", async () => {
        const { api } = makeApi({
            getUidByUins: vi.fn(async () => ({ errCode: 1, errMsg: "x", uids: new Map() })),
        });
        await expect(api.uinToUid(["10001"])).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("uidToUin：命中返回 Map；errCode 非 0 抛 UNKNOWN", async () => {
        const { api } = makeApi({
            getUinByUids: vi.fn(async () => ({
                errCode: 0,
                errMsg: "",
                uins: new Map([["u-1", "10001"]]),
            })),
        });
        await expect(api.uidToUin(["u-1"])).resolves.toEqual(new Map([["u-1", "10001"]]));
        const { api: api2 } = makeApi({
            getUinByUids: vi.fn(async () => ({ errCode: 1, errMsg: "x", uins: new Map() })),
        });
        await expect(api2.uidToUin(["u-1"])).rejects.toMatchObject({ code: "UNKNOWN" });
    });

    it("getGroupRemainAtTimes：atInfo 拆平返回", async () => {
        const { api } = makeApi();
        await expect(api.getGroupRemainAtTimes("10001")).resolves.toEqual({
            canAtAll: true,
            remainAtAllCountForUin: 5,
            remainAtAllCountForGroup: 10,
        });
    });

    it("getGroupRemainAtTimes：errCode 非 0 抛 UNKNOWN", async () => {
        const { api } = makeApi({
            getGroupRemainAtTimes: vi.fn(async () => ({
                errCode: 2,
                errMsg: "x",
                atInfo: undefined,
            })),
        });
        await expect(api.getGroupRemainAtTimes("10001")).rejects.toMatchObject({ code: "UNKNOWN" });
    });
});

describe("群管操作", () => {
    it("roleToString：owner/admin/member 三态", () => {
        expect(GroupApi.roleToString(NTGroupMemberRole.OWNER)).toBe("owner");
        expect(GroupApi.roleToString(NTGroupMemberRole.ADMIN)).toBe("admin");
        expect(GroupApi.roleToString(NTGroupMemberRole.MEMBER)).toBe("member");
        expect(GroupApi.roleToString(NTGroupMemberRole.STRANGER)).toBe("member");
    });

    it("kickMember：空 uid 列表抛 INVALID_PARAM", async () => {
        const { api, service } = makeApi();
        await expect(api.kickMember("10001", [], false)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        expect(service.kickMemberV2).not.toHaveBeenCalled();
    });

    it("kickMember：refuseForever=false 时 optFlag=1，参数组装正确", async () => {
        const { api, service } = makeApi();
        await api.kickMember("10001", ["u1", "u2"], false, "原因");
        expect(service.kickMemberV2).toHaveBeenCalledWith({
            groupCode: "10001",
            kickFlag: 0,
            kickList: [
                { optFlag: 1, optOperate: 0, optMemberUid: "u1", optBytesMsg: "" },
                { optFlag: 1, optOperate: 0, optMemberUid: "u2", optBytesMsg: "" },
            ],
            kickListUids: ["u1", "u2"],
            kickMsg: "原因",
        });
    });

    it("kickMember：refuseForever=true 时 optFlag=0；原生失败抛错", async () => {
        const { api } = makeApi({
            kickMemberV2: vi.fn(async () => ({ result: 9, errMsg: "denied" })),
        });
        await expect(api.kickMember("10001", ["u1"], true)).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /kickMemberV2 失败/,
        });
    });

    it("setMemberShutUp：空列表抛 INVALID_PARAM；uid→timeStamp 映射", async () => {
        const { api, service } = makeApi();
        await expect(api.setMemberShutUp("10001", [])).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await api.setMemberShutUp("10001", [
            { uid: "u1", duration: 600 },
            { uid: "u2", duration: 0 },
        ]);
        expect(service.setMemberShutUp).toHaveBeenCalledWith("10001", [
            { uid: "u1", timeStamp: 600 },
            { uid: "u2", timeStamp: 0 },
        ]);
    });

    it("setGroupShutUp：参数透传，失败抛错", async () => {
        const { api } = makeApi({
            setGroupShutUp: vi.fn(async () => ({ result: 3, errMsg: "x" })),
        });
        await expect(api.setGroupShutUp("10001", true)).rejects.toBeInstanceOf(KernelError);
        const { api: api2, service: service2 } = makeApi();
        await api2.setGroupShutUp("10001", false);
        expect(service2.setGroupShutUp).toHaveBeenCalledWith("10001", false);
    });

    it("setMemberRole / setMemberCardName：void 语义直接透传", () => {
        const { api, service } = makeApi();
        api.setMemberRole("10001", "u1", NTGroupMemberRole.ADMIN);
        expect(service.modifyMemberRole).toHaveBeenCalledWith(
            "10001",
            "u1",
            NTGroupMemberRole.ADMIN,
        );
        api.setMemberCardName("10001", "u1", "名片");
        expect(service.modifyMemberCardName).toHaveBeenCalledWith("10001", "u1", "名片");
    });

    it("modifyGroupName：参数透传（第三参 false），失败抛错", async () => {
        const { api, service } = makeApi();
        await api.modifyGroupName("10001", "新名");
        expect(service.modifyGroupName).toHaveBeenCalledWith("10001", "新名", false);
        const { api: api2 } = makeApi({
            modifyGroupName: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(api2.modifyGroupName("10001", "新名")).rejects.toBeInstanceOf(KernelError);
    });

    it("quitGroup：默认保留本地消息，needDeleteLocalMsg 可显式传", async () => {
        const { api, service } = makeApi();
        await api.quitGroup("10001");
        expect(service.quitGroupV2).toHaveBeenCalledWith({
            groupCode: "10001",
            needDeleteLocalMsg: false,
        });
        await api.quitGroup("10001", true);
        expect(service.quitGroupV2).toHaveBeenLastCalledWith({
            groupCode: "10001",
            needDeleteLocalMsg: true,
        });
    });
});

describe("精华消息", () => {
    it("addGroupEssence：按 msgId 取 msgSeq/msgRandom → addGroupEssence", async () => {
        const { api, msgService, service } = makeApi();
        await api.addGroupEssence("10001", "m1");
        expect(msgService.getMsgsByMsgId).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            ["m1"],
        );
        expect(service.addGroupEssence).toHaveBeenCalledWith({
            groupCode: "10001",
            msgRandom: 7,
            msgSeq: 42,
        });
    });

    it("removeGroupEssence：走 removeGroupEssence 通道", async () => {
        const { api, service } = makeApi();
        await api.removeGroupEssence("10001", "m1");
        expect(service.removeGroupEssence).toHaveBeenCalledWith({
            groupCode: "10001",
            msgRandom: 7,
            msgSeq: 42,
        });
        expect(service.addGroupEssence).not.toHaveBeenCalled();
    });

    it("消息不存在抛 NOT_FOUND", async () => {
        const { api } = makeApi(
            {},
            {
                getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: "", msgList: [] })),
            },
        );
        await expect(api.addGroupEssence("10001", "m404")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    it("getMsgsByMsgId 失败抛错", async () => {
        const { api } = makeApi(
            {},
            {
                getMsgsByMsgId: vi.fn(async () => ({ result: 9, errMsg: "x" })),
            },
        );
        await expect(api.removeGroupEssence("10001", "m1")).rejects.toBeInstanceOf(KernelError);
    });

    it("msgRandom 缺省兜底 0；宽松 result 非 0 抛错", async () => {
        const { api, service } = makeApi(
            {},
            {
                getMsgsByMsgId: vi.fn(async () => ({
                    result: 0,
                    errMsg: "",
                    msgList: [{ msgId: "m1", msgSeq: "8" }],
                })),
            },
        );
        await api.addGroupEssence("10001", "m1");
        expect(service.addGroupEssence).toHaveBeenCalledWith({
            groupCode: "10001",
            msgRandom: 0,
            msgSeq: 8,
        });
        const { api: api2 } = makeApi({
            addGroupEssence: vi.fn(async () => ({ result: 5, errMsg: "fail" })),
        });
        await expect(api2.addGroupEssence("10001", "m1")).rejects.toBeInstanceOf(KernelError);
    });
});

describe("公告 / 头衔 / 群头像", () => {
    it("getGroupAnnouncements：result 数组 / bulletins / 非对象项过滤 / 形状缺失空数组", async () => {
        const { api } = makeApi({
            getGroupBulletin: vi.fn(async () => ({
                result: [{ announcementId: "a1" }, null, "junk"],
            })),
        });
        await expect(api.getGroupAnnouncements("10001")).resolves.toEqual([
            { announcementId: "a1" },
        ]);

        const { api: api2 } = makeApi({
            getGroupBulletin: vi.fn(async () => ({
                result: { bulletins: [{ announcementId: "a2" }] },
            })),
        });
        await expect(api2.getGroupAnnouncements("10001")).resolves.toEqual([
            { announcementId: "a2" },
        ]);

        const { api: api3 } = makeApi({
            getGroupBulletin: vi.fn(async () => ({ result: "junk", errMsg: "" })),
        });
        await expect(api3.getGroupAnnouncements("10001")).resolves.toEqual([]);
    });

    it("getGroupAnnouncements：service 异常包装 UNKNOWN；KernelError 原样上抛", async () => {
        const { api } = makeApi({
            getGroupBulletin: vi.fn(async () => {
                throw new Error("boom");
            }),
        });
        await expect(api.getGroupAnnouncements("10001")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /getGroupBulletin 调用失败: boom/,
        });
        const { api: api2 } = makeApi({
            getGroupBulletin: vi.fn(async () => {
                throw new KernelError("原生", "NOT_FOUND");
            }),
        });
        await expect(api2.getGroupAnnouncements("10001")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    it("publishGroupAnnouncement：imagePath 空串不触发上传；带图两步链", async () => {
        const { api, service } = makeApi();
        await api.publishGroupAnnouncement("10001", "公告", "");
        expect(service.uploadGroupBulletinPic).not.toHaveBeenCalled();
        expect(service.publishGroupBulletin).toHaveBeenCalledWith({
            groupCode: "10001",
            content: "公告",
        });

        const { api: api2, service: service2 } = makeApi();
        await api2.publishGroupAnnouncement("10001", "公告", "/tmp/a.png");
        expect(service2.uploadGroupBulletinPic).toHaveBeenCalledWith("10001", "/tmp/a.png");
        expect(service2.publishGroupBulletin).toHaveBeenCalledWith({
            groupCode: "10001",
            content: "公告",
            picId: "pic-1",
        });
    });

    it("uploadGroupBulletinPic：失败抛错；picId 非字符串兜底空串", async () => {
        const { api } = makeApi({
            uploadGroupBulletinPic: vi.fn(async () => ({ result: 1, errMsg: "up fail" })),
        });
        await expect(
            api.publishGroupAnnouncement("10001", "公告", "/tmp/a.png"),
        ).rejects.toMatchObject({
            message: /uploadGroupBulletinPic 失败/,
        });
        const { api: api2, service: service2 } = makeApi({
            uploadGroupBulletinPic: vi.fn(async () => ({ result: 0 })),
        });
        await api2.publishGroupAnnouncement("10001", "公告", "/tmp/a.png");
        // picId 非字符串兜底空串（仍注入 picId 键）
        expect(service2.publishGroupBulletin).toHaveBeenCalledWith({
            groupCode: "10001",
            content: "公告",
            picId: "",
        });
    });

    it("publishGroupAnnouncement：service 抛裸异常包装 UNKNOWN", async () => {
        const { api } = makeApi({
            publishGroupBulletin: vi.fn(async () => {
                throw 42;
            }),
        });
        await expect(api.publishGroupAnnouncement("10001", "公告")).rejects.toMatchObject({
            message: /publishGroupBulletin 调用失败: 42/,
        });
    });

    it("deleteGroupAnnouncement / setMemberSpecialTitle / setGroupAvatar 透传 + 异常包装", async () => {
        const { api, service } = makeApi();
        await api.deleteGroupAnnouncement("10001", "a1");
        expect(service.deleteGroupBulletin).toHaveBeenCalledWith("10001", "a1");
        await api.setMemberSpecialTitle("10001", "u1", "头衔");
        expect(service.setIdentityTitleInfo).toHaveBeenCalledWith("10001", "u1", "头衔");
        await api.setGroupAvatar("10001", "/tmp/g.png");
        expect(service.setHeader).toHaveBeenCalledWith("10001", "/tmp/g.png");

        const { api: api2 } = makeApi({
            setHeader: vi.fn(async () => {
                throw new Error("boom");
            }),
        });
        await expect(api2.setGroupAvatar("10001", "/tmp/g.png")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /setHeader\(group\) 调用失败: boom/,
        });
    });
});

describe("错误语义补充（KernelError 透传 / 缺省分支）", () => {
    it("uidToUin：空数组直接返回空 Map（不发调用）", async () => {
        const { api, service } = makeApi();
        await expect(api.uidToUin([])).resolves.toEqual(new Map());
        expect(service.getUinByUids).not.toHaveBeenCalled();
    });

    it("getGroupBulletin：result 为数字 0 按成功解包（无公告体 → 空列表）", async () => {
        const { api } = makeApi({
            getGroupBulletin: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.getGroupAnnouncements("10001")).resolves.toEqual([]);
    });

    it("getGroupAnnouncements：result 为数组时原样提取", async () => {
        const { api } = makeApi({
            getGroupBulletin: vi.fn(async () => ({ result: [{ id: "b1" }] })),
        });
        await expect(api.getGroupAnnouncements("10001")).resolves.toEqual([{ id: "b1" }]);
    });

    it("publishGroupBulletin：KernelError 原样上抛（不二次包装）", async () => {
        const { api } = makeApi({
            publishGroupBulletin: vi.fn(async () => ({ result: 1, errMsg: "busy" })),
        });
        await expect(api.publishGroupAnnouncement("10001", "公告")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /publishGroupBulletin 失败/,
        });
    });

    it("deleteGroupAnnouncement：result 非 0 → UNKNOWN；裸异常 → UNKNOWN 包装", async () => {
        const { api } = makeApi({
            deleteGroupBulletin: vi.fn(async () => ({ result: 3, errMsg: "denied" })),
        });
        await expect(api.deleteGroupAnnouncement("10001", "a1")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /deleteGroupBulletin 失败: denied/,
        });
        const { api: api2 } = makeApi({
            deleteGroupBulletin: vi.fn(async () => {
                throw "raw-delete-fail";
            }),
        });
        await expect(api2.deleteGroupAnnouncement("10001", "a1")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /deleteGroupBulletin 调用失败: raw-delete-fail/,
        });
    });

    it("setMemberSpecialTitle：result 非 0 → UNKNOWN；裸异常 → UNKNOWN 包装", async () => {
        const { api } = makeApi({
            setIdentityTitleInfo: vi.fn(async () => ({ result: 5, errMsg: "no perm" })),
        });
        await expect(api.setMemberSpecialTitle("10001", "u1", "头衔")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /setIdentityTitleInfo 失败: no perm/,
        });
        const { api: api2 } = makeApi({
            setIdentityTitleInfo: vi.fn(async () => {
                throw new Error("ipc dead");
            }),
        });
        await expect(api2.setMemberSpecialTitle("10001", "u1", "头衔")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /setIdentityTitleInfo 调用失败: ipc dead/,
        });
    });
});
