/**
 * group-notify.ts GroupNotifyApi 类测试 + extract 系列纯函数断言（同文件合并保留）：
 *  - constructor 空校验
 *  - getSingleScreenNotifies / getGroupShutUpMemberList（列表提取 + 失败分支）
 *  - handleGroupRequest：group 缺省 postscript 空格兜底 / 参数组装
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../../infra/index.js";
import { GroupNotifyMsgType } from "../../../types/index.js";
import { makeSession } from "../../__tests__/test-support.js";
import {
    extractMemberList,
    extractNotifyList,
    findPendingGroupRequest,
    GroupNotifyApi,
} from "../group-notify.js";

function makeApi(overrides: Record<string, unknown> = {}) {
    const service = {
        // getSingleScreenNotifies 只检查 raw.result（result 即列表 / result 内字段）
        getSingleScreenNotifies: vi.fn(async () => ({
            result: [{ seq: "1", type: 1 }],
            errMsg: "",
        })),
        getGroupShutUpMemberList: vi.fn(async () => ({
            result: 0,
            errMsg: "",
        })),
        operateSysNotify: vi.fn(async () => undefined),
        ...overrides,
    };
    const api = new GroupNotifyApi(makeSession({ getGroupService: () => service }));
    return { api, service };
}

describe("constructor", () => {
    it("getGroupService 空 / undefined → INVALID_STATE", () => {
        expect(() => new GroupNotifyApi(makeSession({ getGroupService: () => null }))).toThrow(
            /getGroupService\(\) 返回空/,
        );
        expect(() => new GroupNotifyApi(makeSession({ getGroupService: () => undefined }))).toThrow(
            /getGroupService\(\) 返回空/,
        );
    });
});

describe("查询", () => {
    it("getSingleScreenNotifies：doubt/count 透传 + result 内 notifies 提取", async () => {
        const { api, service } = makeApi();
        await expect(api.getSingleScreenNotifies(false, 20)).resolves.toEqual([
            { seq: "1", type: 1 },
        ]);
        expect(service.getSingleScreenNotifies).toHaveBeenCalledWith(false, "", 20);
    });

    it("getSingleScreenNotifies：result 直接数组形状；缺省形状空数组", async () => {
        const { api } = makeApi({
            getSingleScreenNotifies: vi.fn(async () => ({ result: [{ seq: "2", type: 1 }] })),
        });
        await expect(api.getSingleScreenNotifies(true, 5)).resolves.toEqual([
            { seq: "2", type: 1 },
        ]);
        const { api: api2 } = makeApi({
            getSingleScreenNotifies: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api2.getSingleScreenNotifies(true, 5)).resolves.toEqual([]);
    });

    it("getGroupShutUpMemberList：result=0 时提取为空（extract 只看 result）；失败抛错", async () => {
        const { api, service } = makeApi();
        await expect(api.getGroupShutUpMemberList("10001")).resolves.toEqual([]);
        expect(service.getGroupShutUpMemberList).toHaveBeenCalledWith("10001");
        const { api: api2 } = makeApi({
            getGroupShutUpMemberList: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(api2.getGroupShutUpMemberList("10001")).rejects.toBeInstanceOf(KernelError);
    });

    it("getGroupShutUpMemberList：result 即列表形状时按元素守卫提取", async () => {
        // result 为成员列表数组（非错误码）时不再误判为失败：逐项过 isGroupMember。
        const { api } = makeApi({
            getGroupShutUpMemberList: vi.fn(async () => ({
                result: [{ uid: "u2", uin: "10002" }, { uid: "junk" }],
                errMsg: "",
            })),
        });
        await expect(api.getGroupShutUpMemberList("10001")).resolves.toEqual([
            { uid: "u2", uin: "10002" },
        ]);
    });
});

describe("handleGroupRequest", () => {
    it("参数组装：seq/type/groupCode/postscript；reason 空串兜底空格", async () => {
        const { api, service } = makeApi();
        const notify = { seq: "9", type: 7, group: { groupCode: "10001" } } as never;
        await api.handleGroupRequest(false, notify, 2, "理由");
        expect(service.operateSysNotify).toHaveBeenCalledWith(false, {
            operateType: 2,
            targetMsg: { seq: "9", type: 7, groupCode: "10001", postscript: "理由" },
        });
        await api.handleGroupRequest(true, notify, 1, "");
        expect(service.operateSysNotify).toHaveBeenLastCalledWith(true, {
            operateType: 1,
            targetMsg: { seq: "9", type: 7, groupCode: "10001", postscript: " " },
        });
    });

    it("notify 无 group 字段 → groupCode 空串", async () => {
        const { api, service } = makeApi();
        const notify = { seq: "3", type: 1 } as never;
        await api.handleGroupRequest(false, notify, 1, "ok");
        expect(service.operateSysNotify).toHaveBeenCalledWith(false, {
            operateType: 1,
            targetMsg: { seq: "3", type: 1, groupCode: "", postscript: "ok" },
        });
    });
});

describe("群请求引用", () => {
    const pending = {
        seq: "9007199254740993",
        group: { groupCode: "808", groupName: "测试群" },
        user1: { uid: "u_inviter", nickName: "邀请人" },
        status: 1,
    } as const;

    it.each([
        [GroupNotifyMsgType.INVITED_BY_MEMBER, "invitation"],
        [GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS, "invited_join_request"],
        [GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS, "join_request"],
    ])("type %s 的公开引用保留队列、群号和完整序号", async (type, kind) => {
        const { api, service } = makeApi();
        for (const doubt of [false, true]) {
            const [notice] = api.getPendingGroupRequests(doubt, [
                null,
                { ...pending, type, group: null },
                { ...pending, type, status: 2 },
                { ...pending, type },
            ]);
            expect(notice).toEqual({
                request: { seq: pending.seq, groupCode: "808", kind, doubt },
                initiatorUid: "u_inviter",
            });
            expect(notice).toBeDefined();
            if (notice !== undefined) {
                await api.respondToRequest(notice.request, !doubt);
            }
            expect(service.operateSysNotify).toHaveBeenLastCalledWith(doubt, {
                operateType: doubt ? 2 : 1,
                targetMsg: { seq: pending.seq, groupCode: "808", type, postscript: " " },
            });
        }
    });

    it("旧序号有多队列匹配时报错；显式指定队列只查该队列", async () => {
        const notify = { ...pending, type: GroupNotifyMsgType.INVITED_BY_MEMBER };
        const getSingleScreenNotifies = vi.fn(async () => [notify]);
        const { api } = makeApi({ getSingleScreenNotifies });
        await expect(findPendingGroupRequest(api, { seq: notify.seq }, 50)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        getSingleScreenNotifies.mockClear();
        await expect(
            findPendingGroupRequest(api, { seq: notify.seq, doubt: true }, 50),
        ).resolves.toMatchObject({
            request: { doubt: true, seq: notify.seq },
        });
        expect(getSingleScreenNotifies).toHaveBeenCalledExactlyOnceWith(true, "", 50);
    });

    it("队列查询和审批的原生失败均传播", async () => {
        const { api } = makeApi({
            getSingleScreenNotifies: async () => ({ result: 7, errMsg: "查询失败" }),
            operateSysNotify: async () => ({ result: 9, errMsg: "拒绝访问" }),
        });
        await expect(api.getSingleScreenNotifies(true, 50)).rejects.toThrow("查询失败");
        await expect(
            api.respondToRequest(
                {
                    seq: pending.seq,
                    groupCode: "808",
                    kind: "invitation",
                    doubt: true,
                },
                false,
            ),
        ).rejects.toThrow("拒绝访问");
    });
});

// ---------------------------------------------------------------------------
// extractNotifyList / extractMemberList 基线断言（原 group-notify.test.ts，合并保留全部断言）
// ---------------------------------------------------------------------------

describe("extractNotifyList", () => {
    it("直接数组 → 原样返回", () => {
        const arr = [{ seq: "1", type: 1 }];
        expect(extractNotifyList(arr)).toEqual(arr);
    });

    it("notifies 字段 → 返回该字段", () => {
        const notifies = [{ seq: "1", type: 1 }];
        expect(extractNotifyList({ notifies })).toEqual(notifies);
    });

    it("groupNotifies 字段 → 返回该字段", () => {
        const groupNotifies = [{ seq: "2", type: 2 }];
        expect(extractNotifyList({ groupNotifies })).toEqual(groupNotifies);
    });

    it("非数组 / 非对象 / 缺字段 → 空数组", () => {
        expect(extractNotifyList(null)).toEqual([]);
        expect(extractNotifyList(undefined)).toEqual([]);
        expect(extractNotifyList("str")).toEqual([]);
        expect(extractNotifyList(42)).toEqual([]);
        expect(extractNotifyList({ other: 1 })).toEqual([]);
        expect(extractNotifyList({ notifies: "not-array" })).toEqual([]);
    });
});

describe("extractMemberList", () => {
    it("直接数组 → 逐项校验后返回", () => {
        const arr = [{ uid: "u1", uin: "10001" }];
        expect(extractMemberList(arr)).toEqual(arr);
    });

    it("memberList 字段 → 返回该字段", () => {
        const memberList = [{ uid: "u1", uin: "10001", nick: "A" }];
        expect(extractMemberList({ memberList })).toEqual(memberList);
    });

    it("list 字段 → 返回该字段", () => {
        const list = [{ uid: "u2", uin: "10002", nick: "B" }];
        expect(extractMemberList({ list })).toEqual(list);
    });

    it("infos Map → 逐项校验后返回", () => {
        const infos = new Map([["u3", { uid: "u3", uin: "10003" }]]);
        expect(extractMemberList({ infos })).toEqual([{ uid: "u3", uin: "10003" }]);
    });

    it("残缺成员项（缺 uin）被逐项丢弃", () => {
        expect(extractMemberList([{ uid: "u1" }, { uid: "u2", uin: "10002" }])).toEqual([
            { uid: "u2", uin: "10002" },
        ]);
    });

    it("非数组 / 非对象 / 缺字段 → 空数组", () => {
        expect(extractMemberList(null)).toEqual([]);
        expect(extractMemberList(undefined)).toEqual([]);
        expect(extractMemberList("str")).toEqual([]);
        expect(extractMemberList(42)).toEqual([]);
        expect(extractMemberList({ other: 1 })).toEqual([]);
        expect(extractMemberList({ memberList: "not-array" })).toEqual([]);
    });
});
