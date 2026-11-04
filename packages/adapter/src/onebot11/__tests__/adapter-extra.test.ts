/**
 * adapter 传输装配 / 精华链 / 消息事件链补充分支（承接 adapter-request.test.ts 的
 * 主体覆盖，避免单文件过长）。
 *
 * 覆盖：start() 真 HTTP 传输 open、handleRequest 包装层兜底 catch、精华列表参数
 * 收窄失败、delete 事件 sender/message_id 缺失分支、fetchMessages 拒绝、消息事件
 * 的 at/reply ID 转换与失败兜底、空通知数组短路。
 */
import type { GroupEventChannel, MsgEventChannel } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { describe, expect, it, vi } from "vitest";
import { ProtocolConfig } from "../../core/index.js";
import {
    type AdapterLoggerLike,
    NapukettoOneBot11Adapter,
    type OneBot11AdapterOptions,
} from "../adapter.js";
import { ob11ConfigSchema } from "../helper/index.js";

/** 桩 kernel apis（可注入 groupApi / webApi / msgApi 覆盖）。 */
function stubOptions(
    overrides?: Record<string, unknown>,
): Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel"> {
    return {
        msgApi: {},
        groupApi: {},
        groupNotifyApi: {},
        friendApi: {},
        ticketApi: {},
        richMediaApi: {},
        profileApi: {},
        profileLikeApi: {},
        webApi: {},
        self: { uin: "10001", nickname: "测试号" },
        system: { appVersion: "test" },
        ...overrides,
    } as unknown as Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel">;
}

/** 捕获 handler 的假通道。 */
function captureChannel(): {
    channel: MsgEventChannel;
    handlers: Map<string, (...args: unknown[]) => void>;
} {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const channel = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }),
    } as unknown as MsgEventChannel;
    return { channel, handlers };
}

/** 构造适配器（seed 配置；事件捕获数组返回）。 */
function makeAdapter(options?: {
    seed?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
    logger?: {
        warn: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
        debug: ReturnType<typeof vi.fn>;
    };
    groupChannel?: GroupEventChannel;
}): {
    adapter: NapukettoOneBot11Adapter;
    events: Record<string, unknown>[];
    msg: ReturnType<typeof captureChannel>;
} {
    const msg = captureChannel();
    const events: Record<string, unknown>[] = [];
    const adapter = new NapukettoOneBot11Adapter({
        ...stubOptions(options?.overrides),
        config: new ProtocolConfig({
            path: "ob11-test.toml",
            schema: ob11ConfigSchema,
            defaults: ob11ConfigSchema.parse({}),
            seed: ob11ConfigSchema.parse(options?.seed ?? {}),
        }),
        broadcaster: {
            emit: (e: unknown) => events.push(e as Record<string, unknown>),
            register: () => undefined,
            unregister: () => undefined,
        } as unknown as EventBroadcaster,
        msgChannel: msg.channel,
        ...(options?.groupChannel !== undefined ? { groupChannel: options.groupChannel } : {}),
        ...(options?.logger !== undefined
            ? { logger: options.logger as unknown as AdapterLoggerLike }
            : {}),
    });
    return { adapter, events, msg };
}

describe("传输装配与请求链（start + 真传输）", () => {
    it("start() 装配 HTTP server 并 open（含正向上报 client 的 open 循环）", async () => {
        const seed = {
            httpServers: [{ enabled: true, host: "127.0.0.1", port: 37240 }],
            httpPostUrls: [{ enabled: true, url: "http://127.0.0.1:1/nowhere" }],
            heartbeatInterval: 0,
        };
        const { adapter, events } = makeAdapter({ seed });
        await adapter.start();
        // lifecycle enable 已广播（传输打开成功）
        expect(events[0]).toMatchObject({ meta_event_type: "lifecycle" });
        await adapter.stop();
    });

    it("handleRequest 包装层兜底 catch：respond 首次抛错 → 999 兜底二次 respond", async () => {
        const seed = {
            httpServers: [{ enabled: true, host: "127.0.0.1", port: 37241 }],
            heartbeatInterval: 0,
        };
        const { adapter } = makeAdapter({ seed });
        await adapter.start();
        try {
            // 从装配的传输上取回包装后的 handleRequest（private 字段，测试窥视）
            const transports = (
                adapter as unknown as {
                    transports: {
                        servers: Array<{
                            onRequest?: (req: unknown, respond: (res: unknown) => void) => void;
                        }>;
                    } | null;
                }
            ).transports;
            const wrapped = transports?.servers[0]?.onRequest;
            expect(wrapped).toBeTypeOf("function");
            let calls = 0;
            wrapped?.({ action: "get_status" }, () => {
                calls += 1;
                if (calls === 1) {
                    throw new Error("respond 崩了");
                }
            });
            // 兜底 catch 异步二次 respond（等一拍微任务）
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(calls).toBe(2);
        } finally {
            await adapter.stop();
        }
    });
});

describe("精华链补充分支", () => {
    /** 带 group 通道的 harness（webApi/msgApi 可控）。 */
    function makeEssenceHarness(fetchBehavior: "ok" | "reject"): {
        adapter: NapukettoOneBot11Adapter;
        group: ReturnType<typeof captureChannel>;
        events: Record<string, unknown>[];
        warn: ReturnType<typeof vi.fn>;
        getEssenceList: ReturnType<typeof vi.fn>;
    } {
        const group = captureChannel();
        const events: Record<string, unknown>[] = [];
        const warn = vi.fn();
        const getEssenceList = vi.fn(async (_group: string): Promise<unknown[]> => []);
        const fetchMsgs =
            fetchBehavior === "reject"
                ? vi.fn(async () => {
                      throw new Error("fetchMessages 崩了");
                  })
                : vi.fn(async (_peer: unknown, _opts: unknown): Promise<unknown[]> => []);
        const overrides = {
            webApi: { getEssenceMsgList: getEssenceList },
            msgApi: { fetchMessages: fetchMsgs },
        };
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(overrides),
            config: new ProtocolConfig({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: {
                emit: (e: unknown) => events.push(e as Record<string, unknown>),
            } as unknown as EventBroadcaster,
            msgChannel: captureChannel().channel,
            groupChannel: group.channel as unknown as GroupEventChannel,
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        return { adapter, group, events, warn, getEssenceList };
    }

    /** EssenceMsgItem 桩（sender 可空）。 */
    const essenceItem = (seq: number, adder: string, sender = "10001") => ({
        msg_seq: seq,
        msg_random: seq,
        sender_uin: sender,
        sender_nick: "s",
        add_digest_uin: adder,
        add_digest_nick: "op",
        add_digest_time: 1793540100,
        msg_content: [],
    });

    it("列表变更参数未知形状 → warn 校准（不入串行链）", async () => {
        const { adapter, group, warn, getEssenceList } = makeEssenceHarness("ok");
        await adapter.subscribeOnly();
        group.handlers.get("Group/onGroupEssenceListChange")?.({ bogus: 1 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getEssenceList).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("onGroupEssenceListChange 未知参数形状");
        adapter.unsubscribeOnly();
    });

    it("移除项 sender 不可得 → warn 跳过 delete 事件", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness("ok");
        await adapter.subscribeOnly();
        // 基线：含 seq 150（sender_uin 空串 → prev 缓存 sender 不可得）
        getEssenceList.mockResolvedValue([essenceItem(150, "10002", "")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 次轮：150 被移除 → delete 广播路径 sender 为 null → warn
        getEssenceList.mockResolvedValue([]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(warn.mock.calls.some((c) => String(c[1]).includes("sender 不可得"))).toBe(true);
        });
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });

    it("移除项 message_id 反查未命中 → 跳过事件（delete 分支 continue）", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness("ok");
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 次轮移除 150，fetchMsgs 默认返回空 → message_id 反查未命中
        getEssenceList.mockResolvedValue([]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(
                warn.mock.calls.some((c) => String(c[1]).includes("message_id 反查未命中")),
            ).toBe(true);
        });
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });

    it("精华 message_id 反查 fetchMessages 抛错 → 按未命中处理（warn）", async () => {
        const { adapter, group, warn, getEssenceList } = makeEssenceHarness("reject");
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(151, "10003")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(
                warn.mock.calls.some((c) => String(c[1]).includes("message_id 反查未命中")),
            ).toBe(true);
        });
        adapter.unsubscribeOnly();
    });
});

describe("精华串行链 rejection 恢复", () => {
    it("广播抛错 → 链吞掉 rejection；紧随其后的一次同步被恢复分支消费，再下一次恢复运行", async () => {
        const group = captureChannel();
        const events: Record<string, unknown>[] = [];
        const warn = vi.fn();
        let throwOnEssence = true;
        const getEssenceList = vi.fn(async (_group: string): Promise<unknown[]> => []);
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions({
                webApi: { getEssenceMsgList: getEssenceList },
                msgApi: {
                    fetchMessages: vi.fn(async () => [{ msgId: "nt-151", msgSeq: "151" }]),
                },
            }),
            config: new ProtocolConfig({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: {
                emit: (e: unknown) => {
                    const event = e as Record<string, unknown>;
                    if (throwOnEssence && event["notice_type"] === "group_essence") {
                        throwOnEssence = false;
                        throw new Error("emit 崩了");
                    }
                    events.push(event);
                },
                register: () => undefined,
                unregister: () => undefined,
            } as unknown as EventBroadcaster,
            msgChannel: captureChannel().channel,
            groupChannel: group.channel as unknown as GroupEventChannel,
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        const item = (seq: number) => ({
            msg_seq: seq,
            msg_random: seq,
            sender_uin: "10001",
            sender_nick: "s",
            add_digest_uin: "10002",
            add_digest_nick: "op",
            add_digest_time: 1793540100,
            msg_content: [],
        });
        // 基线
        getEssenceList.mockResolvedValue([item(150)]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 新增 → add 广播抛错（链 rejection 被吞）。then(sync, recover) 语义：
        // 失败后紧随入队的那次同步被恢复分支消费（不执行），再下一次恢复运行——
        // 三个触发同 tick 入队（恢复 handler 先于 rejection 事件挂上，
        // 避免 unhandledRejection 窗口）。
        getEssenceList.mockResolvedValue([item(150), item(151)]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            // 基线 1 次 + 失败的同步 1 次 + 恢复后重新运行 1 次 = 3
            expect(getEssenceList).toHaveBeenCalledTimes(3);
        });
        // 再触发一次：链仍然活着（第四次同步照常执行，diff 空无事件）
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(4);
        });
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });
});

describe("消息事件链（broadcastMessageEvent 分支）", () => {
    /** 群 at 消息（可带 reply）。 */
    function groupAtMsg(replyId?: string): unknown {
        return {
            msgId: "nt-at",
            msgSeq: "77",
            msgTime: "1700000000000",
            chatType: 2,
            peerUid: "808",
            senderUin: "90009",
            senderUid: "u90009",
            sendNickName: "某人",
            elements: [
                ...(replyId !== undefined
                    ? [{ elementType: 7, replyElement: { replayMsgId: replyId } }]
                    : []),
                { elementType: 1, textElement: { content: "@甲", atType: 2, atUid: "u90002" } },
            ],
        };
    }

    it("at uid 批量转换成功 → at 段 qq=uin；reply 反查 OB11 id", async () => {
        const groupApi = {
            uidToUin: vi.fn(
                async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("u", "")])),
            ),
        };
        const { adapter, msg, events } = makeAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        // 预登记被回复消息的 OB11 id（首个分配为 1，本消息为 2）
        const unique = (
            adapter as unknown as {
                oneBotApi: { messageUnique: { alloc: (id: string, peer: unknown) => number } };
            }
        ).oneBotApi.messageUnique;
        unique.alloc("nt-src", { chatType: 2, peerUid: "808" }); // id 1
        msg.handlers.get("Msg/onRecvMsg")?.([groupAtMsg("nt-src")]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const segments = events[0]?.["message"] as Array<{
            type: string;
            data: Record<string, unknown>;
        }>;
        expect(segments?.find((s) => s.type === "reply")?.data["id"]).toBe("1");
        expect(segments.find((s) => s.type === "at")?.data["qq"]).toBe("90002");
        adapter.unsubscribeOnly();
    });

    it("uidToUin 抛错 → at 段保留 uid（不阻塞上报）", async () => {
        const groupApi = {
            uidToUin: vi.fn(async () => {
                throw new Error("转换服务不可用");
            }),
        };
        const { adapter, msg, events } = makeAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([groupAtMsg()]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const segments = events[0]?.["message"] as Array<{
            type: string;
            data: Record<string, unknown>;
        }>;
        expect(segments?.find((s) => s.type === "at")?.data["qq"]).toBe("u90002");
        adapter.unsubscribeOnly();
    });
});

describe("群请求链补充分支", () => {
    it("空通知数组 → uidToUinMap 短路（空 Map）且无事件", async () => {
        const groupHandlers = new Map<string, (...args: unknown[]) => void>();
        const groupChannel = {
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                groupHandlers.set(event, handler);
                return () => undefined;
            }),
        } as unknown as GroupEventChannel;
        const groupApi = { uidToUin: vi.fn(async () => new Map<string, string>()) };
        const { adapter, events } = makeAdapter({
            overrides: { groupApi },
            groupChannel,
        });
        await adapter.subscribeOnly();
        groupHandlers.get("Group/onGroupNotifiesUpdated")?.(false, []);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(groupApi.uidToUin).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });
});
