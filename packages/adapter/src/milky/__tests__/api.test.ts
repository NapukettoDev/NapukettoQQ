/**
 * MilkyApi 公共方法测试（api.ts）+ 配置 schema（config.ts）+ 子路径入口（index.ts）
 *
 * 锁定：resolveUidFromUin（命中 / 空串 / 抛错 → INVALID_PARAM）、resolvePeer
 * 三场景（group 直作 peerUid；friend/temp uin→uid，失败退 uin）、
 * resolveMsgIdBySeq（索引优先 / 近段扫描兜底并回写索引 / 双层未命中 / 拉取失败）、
 * resolveSentOutput（回查 + 索引回写 / 未命中 UNKNOWN）、findGroupNotify 屏序
 * 惰性查找、构造字段透传；
 * milkyConfigSchema 缺省值与校验；index.ts re-export 面。
 */
import {
    ChatType,
    type FriendApi,
    type GroupApi,
    type GroupNotify,
    type GroupNotifyApi,
    type MsgApi,
    type ProfileApi,
    type RawMessage,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../shared/__tests__/stub.js";
import { NapukettoMilkyAdapter } from "../adapter.js";
import { findGroupNotify, MilkyApi } from "../api.js";
import { milkyConfigSchema } from "../config.js";
import { MessageSeqIndex } from "../helper/state/seq-index.js";
import * as milkyIndex from "../index.js";

/** 构造桩 MilkyApi（uinToUid / fetchMessages 可覆写）。 */
function stubApi(
    overrides: {
        uinToUid?: (uins: string[]) => Promise<Map<string, string>>;
        fetchMessages?: MsgApi["fetchMessages"];
    } = {},
): MilkyApi {
    return new MilkyApi(
        stub<ConstructorParameters<typeof MilkyApi>[0]>({
            msgApi: stub<MsgApi>({
                fetchMessages: overrides.fetchMessages ?? vi.fn(async () => []),
                fetchMsgsByMsgId: vi.fn(async () => []),
            }),
            groupApi: stub<GroupApi>({
                uinToUid:
                    overrides.uinToUid ??
                    vi.fn(async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`]))),
                uidToUin: vi.fn(async () => new Map()),
            }),
            friendApi: stub<FriendApi>({}),
            profileApi: stub<ProfileApi>({}),
            self: { uin: "10000", nickname: "机器人", uid: "uid-10000" },
            qqVersion: "9.9.9",
            implVersion: "1.2.3",
            mediaDir: "/media",
            logger: undefined,
        }),
        new MessageSeqIndex(),
    );
}

describe("MilkyApi.resolveUidFromUin", () => {
    it("命中：返回 uid", async () => {
        const api = stubApi();
        await expect(api.resolveUidFromUin(20002)).resolves.toBe("uid-20002");
        await expect(api.resolveUidFromUin("20002")).resolves.toBe("uid-20002");
    });

    it("映射缺失（undefined/空串）→ INVALID_PARAM", async () => {
        const api = stubApi({
            uinToUid: async () => new Map([["20002", ""]]),
        });
        await expect(api.resolveUidFromUin(20002)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });

    it("uinToUid 抛错 → INVALID_PARAM（不透传异常）", async () => {
        const api = stubApi({
            uinToUid: async () => {
                throw new Error("kernel down");
            },
        });
        await expect(api.resolveUidFromUin(20002)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });
});

describe("MilkyApi.resolvePeer", () => {
    it("group：群号直作 peerUid（不查 uid）", async () => {
        const uinToUid = vi.fn(async () => new Map<string, string>());
        const api = stubApi({ uinToUid: () => uinToUid() });
        const peer = await api.resolvePeer("group", 10001);
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "10001" });
        expect(uinToUid).not.toHaveBeenCalled();
    });

    it("friend：uin→uid", async () => {
        const api = stubApi();
        const peer = await api.resolvePeer("friend", 20002);
        expect(peer).toEqual({ chatType: ChatType.C2C, peerUid: "uid-20002" });
    });

    it("temp：C2C_TEMP + uin→uid", async () => {
        const api = stubApi();
        const peer = await api.resolvePeer("temp", 20002);
        expect(peer).toEqual({ chatType: ChatType.C2C_TEMP, peerUid: "uid-20002" });
    });

    it("friend：转换失败退 uin 原样（交 QQ 端判断）", async () => {
        const api = stubApi({ uinToUid: async () => new Map() });
        const peer = await api.resolvePeer("friend", 20002);
        expect(peer).toEqual({ chatType: ChatType.C2C, peerUid: "20002" });
    });

    it("friend：uinToUid 抛错同样退 uin 原样", async () => {
        const api = stubApi({
            uinToUid: async () => {
                throw new Error("x");
            },
        });
        const peer = await api.resolvePeer("friend", 20002);
        expect(peer).toEqual({ chatType: ChatType.C2C, peerUid: "20002" });
    });
});

describe("MilkyApi.resolveMsgIdBySeq", () => {
    const peer = { chatType: ChatType.GROUP, peerUid: "10001" };

    it("索引命中：不触发历史扫描", async () => {
        const api = stubApi();
        api.seqIndex.record({
            msgId: "m-1",
            msgSeq: "5",
            msgTime: "1760000000000",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "20002",
            senderUid: "uid-20002",
            elements: [],
        } as never);
        await expect(api.resolveMsgIdBySeq(peer, 5, ChatType.GROUP)).resolves.toBe("m-1");
    });

    it("索引未命中：近段扫描兜底（按 msgSeq 匹配）并回写索引", async () => {
        const msg = {
            msgId: "m-scan",
            msgSeq: "6",
            msgTime: "1760000000000",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "20002",
            senderUid: "uid-20002",
            elements: [],
        };
        const fetchMessages = vi.fn(async () => [stub<RawMessage>(msg)]);
        const api = stubApi({ fetchMessages: () => fetchMessages() });
        await expect(api.resolveMsgIdBySeq(peer, 6, ChatType.GROUP)).resolves.toBe("m-scan");
        // 回写索引：再次反查不再触发扫描
        await expect(api.resolveMsgIdBySeq(peer, 6, ChatType.GROUP)).resolves.toBe("m-scan");
        expect(fetchMessages).toHaveBeenCalledTimes(1);
    });

    it("双层未命中 → undefined", async () => {
        const api = stubApi({ fetchMessages: async () => [] });
        await expect(api.resolveMsgIdBySeq(peer, 999, ChatType.GROUP)).resolves.toBeUndefined();
    });

    it("历史拉取失败 → undefined（吞错）", async () => {
        const api = stubApi({
            fetchMessages: async () => {
                throw new Error("boom");
            },
        });
        await expect(api.resolveMsgIdBySeq(peer, 999, ChatType.GROUP)).resolves.toBeUndefined();
    });
});

describe("MilkyApi.resolveSentOutput", () => {
    it("回查命中：message_seq/time + 索引回写", async () => {
        const sent = {
            msgId: "sent-1",
            msgSeq: "1300",
            msgTime: "1760000000500",
            chatType: ChatType.GROUP,
            peerUid: "10001",
            senderUin: "10000",
            senderUid: "uid-10000",
            elements: [],
        };
        const api = stubApi({
            fetchMessages: async () => [],
        });
        (api.msgApi as { fetchMsgsByMsgId: unknown }).fetchMsgsByMsgId = vi.fn(async () => [sent]);
        const out = await api.resolveSentOutput(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            "sent-1",
        );
        expect(out).toEqual({ message_seq: 1300, time: 1760000000 });
        // 索引已回写
        await expect(
            api.resolveMsgIdBySeq(
                { chatType: ChatType.GROUP, peerUid: "10001" },
                1300,
                ChatType.GROUP,
            ),
        ).resolves.toBe("sent-1");
    });

    it("回查未命中 → UNKNOWN 抛错", async () => {
        const api = stubApi();
        (api.msgApi as { fetchMsgsByMsgId: unknown }).fetchMsgsByMsgId = vi.fn(async () => []);
        await expect(
            api.resolveSentOutput({ chatType: ChatType.GROUP, peerUid: "10001" }, "ghost"),
        ).rejects.toMatchObject({ code: "UNKNOWN" });
    });
});

describe("MilkyApi 构造透传", () => {
    it("版本 / self / mediaDir / seqIndex 字段原样持有", () => {
        const seqIndex = new MessageSeqIndex();
        const api = new MilkyApi(
            stub<ConstructorParameters<typeof MilkyApi>[0]>({
                msgApi: stub<MsgApi>({}),
                groupApi: stub<GroupApi>({}),
                friendApi: stub<FriendApi>({}),
                profileApi: stub<ProfileApi>({}),
                self: { uin: "1", nickname: "n" },
                qqVersion: "qv",
                implVersion: "iv",
                mediaDir: "/d",
            }),
            seqIndex,
        );
        expect(api.qqVersion).toBe("qv");
        expect(api.implVersion).toBe("iv");
        expect(api.mediaDir).toBe("/d");
        expect(api.self).toEqual({ uin: "1", nickname: "n" });
        expect(api.groupCache).toBeUndefined();
        expect(api.logger).toBeUndefined();
        expect(api.seqIndex).toBe(seqIndex);
    });
});

describe("milkyConfigSchema", () => {
    it("全缺省：enabled=false / 127.0.0.1:3001 / 空token / 双模式 / 空webhooks", () => {
        const cfg = milkyConfigSchema.parse({});
        expect(cfg).toEqual({
            enabled: false,
            host: "127.0.0.1",
            port: 3001,
            token: "",
            eventModes: ["sse", "ws"],
            webhooks: [],
        });
        expect(cfg.cacheDir).toBeUndefined();
    });

    it("完整入参：字段全透传（含可选 cacheDir）", () => {
        const cfg = milkyConfigSchema.parse({
            enabled: true,
            host: "0.0.0.0",
            port: 8080,
            token: "t",
            eventModes: ["sse"],
            webhooks: ["http://a/hook"],
            cacheDir: "/cache",
        });
        expect(cfg).toEqual({
            enabled: true,
            host: "0.0.0.0",
            port: 8080,
            token: "t",
            eventModes: ["sse"],
            webhooks: ["http://a/hook"],
            cacheDir: "/cache",
        });
    });

    it("非法值：端口越界 / eventModes 枚举外 / host 空串均拒绝", () => {
        expect(() => milkyConfigSchema.parse({ port: 70000 })).toThrow();
        expect(() => milkyConfigSchema.parse({ port: 1.5 })).toThrow();
        expect(() => milkyConfigSchema.parse({ eventModes: ["grpc"] })).toThrow();
        expect(() => milkyConfigSchema.parse({ host: "" })).toThrow();
        expect(() => milkyConfigSchema.parse({ webhooks: [""] })).toThrow();
    });
});

describe("milky 子路径入口（index.ts）", () => {
    it("导出 NapukettoMilkyAdapter 与 milkyConfigSchema", () => {
        expect(milkyIndex.NapukettoMilkyAdapter).toBe(NapukettoMilkyAdapter);
        expect(milkyIndex.milkyConfigSchema).toBe(milkyConfigSchema);
        // 类型导出面（编译期断言的运行时影子）：options 类型可被构造消费
        const opts: import("../index.js").MilkyAdapterOptions | undefined = undefined;
        const cfg: import("../index.js").MilkyConfig | undefined = undefined;
        expect(opts).toBeUndefined();
        expect(cfg).toBeUndefined();
    });
});

describe("findGroupNotify 屏序查找", () => {
    /** 构造带群通知桩的 MilkyApi（记录 getSingleScreenNotifies 调用序）。 */
    function notifyApi(
        normal: GroupNotify[],
        doubt: GroupNotify[],
    ): { api: MilkyApi; getCalls: boolean[] } {
        const getCalls: boolean[] = [];
        const api = new MilkyApi(
            stub<ConstructorParameters<typeof MilkyApi>[0]>({
                msgApi: stub<MsgApi>({ fetchMessages: vi.fn(async () => []) }),
                groupNotifyApi: stub<GroupNotifyApi>({
                    getSingleScreenNotifies: vi.fn(async (doubtFlag: boolean) => {
                        getCalls.push(doubtFlag);
                        return doubtFlag ? doubt : normal;
                    }),
                }),
            }),
            new MessageSeqIndex(),
        );
        return { api, getCalls };
    }

    it("首屏（非可疑）命中：不拉可疑屏（群通知规范序）", async () => {
        const { api, getCalls } = notifyApi(
            [stub<GroupNotify>({ seq: "1" })],
            [stub<GroupNotify>({ seq: "2" })],
        );
        const hit = await findGroupNotify(api, "1");
        expect(hit.seq).toBe("1");
        expect(getCalls).toEqual([false]);
    });

    it("首屏未命中：依序拉可疑屏", async () => {
        const { api, getCalls } = notifyApi(
            [stub<GroupNotify>({ seq: "1" })],
            [stub<GroupNotify>({ seq: "9" })],
        );
        const hit = await findGroupNotify(api, "9");
        expect(hit.seq).toBe("9");
        expect(getCalls).toEqual([false, true]);
    });

    it("两屏均未命中：抛 NOT_FOUND", async () => {
        const { api } = notifyApi([], []);
        await expect(findGroupNotify(api, "404")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });
});
