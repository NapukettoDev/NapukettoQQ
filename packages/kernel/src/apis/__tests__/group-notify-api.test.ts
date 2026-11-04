/**
 * group-notify.ts GroupNotifyApi 类测试（extract 系列已有独立基线）：
 *  - constructor 空校验
 *  - getSingleScreenNotifies / getGroupShutUpMemberList（列表提取 + 失败分支）
 *  - handleGroupRequest：group 缺省 postscript 空格兜底 / 参数组装
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { GroupNotifyApi } from "../group-notify.js";
import { makeSession } from "./test-support.js";

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
            getSingleScreenNotifies: vi.fn(async () => ({ result: [{ seq: "2" }] })),
        });
        await expect(api.getSingleScreenNotifies(true, 5)).resolves.toEqual([{ seq: "2" }]);
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

    it("getGroupShutUpMemberList：result 即列表形状被严格 unwrap 拒绝（疑似 bug：提取分支不可达）", async () => {
        // 现状：raw.result 非 0 即抛错，而 result 为成员列表数组时 !== 0 → 永远走 unwrap 失败，
        // extractMemberList 的 memberList/list 分支实际不可达（返回形状待探测校准）。
        const { api } = makeApi({
            getGroupShutUpMemberList: vi.fn(async () => ({
                result: [{ uid: "u2" }],
                errMsg: "",
            })),
        });
        await expect(api.getGroupShutUpMemberList("10001")).rejects.toMatchObject({
            message: /getGroupShutUpMemberList 失败/,
        });
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
