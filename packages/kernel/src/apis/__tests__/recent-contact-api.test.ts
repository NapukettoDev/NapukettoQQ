/**
 * recent-contact.ts RecentContactApi 扩展测试（p2-batch2 基线之外的形状与分支）：
 *  - extractPinnedContacts 宽松形状：result 数组 / raw 自身数组 / data / list 键 /
 *    非对象项过滤 / 无候选 → 空
 *  - peerUin 条件注入（非空字符串才产出）
 *  - service 抛 KernelError 原样上抛 / 裸异常（含非 Error 值）包装 UNKNOWN
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { ChatType } from "../../types/index.js";
import { RecentContactApi } from "../recent-contact.js";
import { makeSession } from "./test-support.js";

function makeApi(service: Record<string, unknown>): RecentContactApi {
    return new RecentContactApi(makeSession({ getRecentContactService: () => service }));
}

describe("RecentContactApi 形状兼容", () => {
    it("result 直接是数组（顶层列表形状）", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: [{ peerUid: "g1", chatType: ChatType.GROUP, topFlag: 1 }],
            })),
        });
        await expect(api.getPinnedContacts()).resolves.toEqual([{ peerUid: "g1", scene: "group" }]);
    });

    it("raw 自身是数组（无 result 包装）也能提取", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => [
                { peerUid: "u1", chatType: ChatType.C2C, isTop: true },
            ]),
        });
        await expect(api.getPinnedContacts()).resolves.toEqual([
            { peerUid: "u1", scene: "friend" },
        ]);
    });

    it("data / list 键形状兼容", async () => {
        const data = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: 0,
                data: [{ peerUid: "g2", chatType: ChatType.GROUP, topFlag: 1 }],
            })),
        });
        await expect(data.getPinnedContacts()).resolves.toEqual([
            { peerUid: "g2", scene: "group" },
        ]);
        const list = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: 0,
                list: [{ peerUid: "g3", chatType: ChatType.GROUP, topFlag: 1 }],
            })),
        });
        await expect(list.getPinnedContacts()).resolves.toEqual([
            { peerUid: "g3", scene: "group" },
        ]);
    });

    it("无候选数组 / 非数组项 → 空数组", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => ({ result: 0, other: 1 })),
        });
        await expect(api.getPinnedContacts()).resolves.toEqual([]);
        const api2 = makeApi({
            getRecentContactList: vi.fn(async () => ({ result: "junk" })),
        });
        await expect(api2.getPinnedContacts()).resolves.toEqual([]);
    });

    it("数组内非对象项（null/数字）过滤", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: [null, 42, { peerUid: "u2", chatType: ChatType.C2C, isTop: true }],
            })),
        });
        await expect(api.getPinnedContacts()).resolves.toEqual([
            { peerUid: "u2", scene: "friend" },
        ]);
    });
});

describe("置顶项组装", () => {
    it("peerUin 非空注入；空串 / 缺省不产出键（exactOptionalPropertyTypes）", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: [
                    { peerUid: "u1", chatType: ChatType.C2C, topFlag: 1, peerUin: "10001" },
                    { peerUid: "u2", chatType: ChatType.C2C, topFlag: 1, peerUin: "" },
                    { peerUid: "u3", chatType: ChatType.C2C, topFlag: 1 },
                ],
            })),
        });
        const pins = await api.getPinnedContacts();
        expect(pins).toEqual([
            { peerUid: "u1", peerUin: "10001", scene: "friend" },
            { peerUid: "u2", scene: "friend" },
            { peerUid: "u3", scene: "friend" },
        ]);
        expect("peerUin" in (pins[1] ?? {})).toBe(false);
    });

    it("peerUid 非字符串 / 置顶标记缺失不产出", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: [
                    { peerUid: 123, chatType: ChatType.GROUP, topFlag: 1 },
                    { peerUid: "g4", chatType: ChatType.GROUP, topFlag: 0 },
                ],
            })),
        });
        await expect(api.getPinnedContacts()).resolves.toEqual([]);
    });

    it("chatType 非 friend/group（temp 场景）不产出", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => ({
                result: [{ peerUid: "t1", chatType: 9, isTop: true }],
            })),
        });
        await expect(api.getPinnedContacts()).resolves.toEqual([]);
    });

    it("fetch 参数：count=200", async () => {
        const service = {
            getRecentContactList: vi.fn(async () => ({ result: 0, data: [] })),
        };
        const api = makeApi(service);
        await api.getPinnedContacts();
        expect(service.getRecentContactList).toHaveBeenCalledWith({ count: 200 });
    });
});

describe("错误分支", () => {
    it("service 抛 KernelError 原样上抛（不二次包装）", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => {
                throw new KernelError("原生错误", "NOT_FOUND");
            }),
        });
        await expect(api.getPinnedContacts()).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("service 抛 Error / 非 Error 值包装 UNKNOWN", async () => {
        const api = makeApi({
            getRecentContactList: vi.fn(async () => {
                throw new Error("boom");
            }),
        });
        await expect(api.getPinnedContacts()).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /getRecentContactList 调用失败: boom/,
        });
        const api2 = makeApi({
            getRecentContactList: vi.fn(async () => {
                throw "字符串异常";
            }),
        });
        await expect(api2.getPinnedContacts()).rejects.toMatchObject({
            message: /getRecentContactList 调用失败: 字符串异常/,
        });
    });
});
