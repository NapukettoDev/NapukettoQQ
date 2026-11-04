/**
 * adapter 分支补全测试（承接 adapter.test.ts / adapter-extra.test.ts /
 * adapter-request.test.ts 的剩余分支）：
 *
 * - 私聊消息事件（message_type=private，senderRole 不注入）
 * - groupCache 命中 → sender.role 注入（owner）
 * - group_card sysmsg：uidToUin 返回缺 uid → user_id=0 兜底
 * - 未知 grayTip 子类型 → 不广播 + warn 校准日志（collectGrayTipUids 空 + notice null）
 * - 群撤回带校准 logger → 翻译上下文注入 logger 后事件照常广播
 * - 群请求已处理（status ≠ KUNHANDLE）→ 跳过不广播
 * - onRecvSysMsg(undefined) → JSON.stringify(undefined) → truncRaw 空串分支
 * - broadcaster 缺省 → start 跳过传输装配、stop 走 transports=null 清理分支
 * - 请求包装层兜底 catch：非 Error 异常 → message = String(err)
 */
import type { GroupEventChannel, GroupNotify, MsgEventChannel } from "@napuketto/kernel";
import { ChatType, NTGroupMemberRole } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { describe, expect, it, vi } from "vitest";
import { ProtocolConfig } from "../../core/index.js";
import {
    type AdapterLoggerLike,
    NapukettoOneBot11Adapter,
    type OneBot11AdapterOptions,
} from "../adapter.js";
import { ob11ConfigSchema } from "../helper/index.js";

/** 桩 kernel apis（可注入 groupApi / groupCache / msgApi / webApi 覆盖）。 */
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

/** 捕获 handler 的假通道（按事件名存取，测试手动触发）。 */
function captureChannel(): {
    channel: MsgEventChannel;
    handlers: Map<string, (...args: unknown[]) => void>;
    off: ReturnType<typeof vi.fn>;
} {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const off = vi.fn();
    const channel = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler);
            return off;
        }),
    } as unknown as MsgEventChannel;
    return { channel, handlers, off };
}

/** 构造适配器（seed 配置；broadcaster emit 捕获事件数组。broadcaster=null = 不传广播器）。 */
function makeAdapter(options?: {
    seed?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
    logger?: AdapterLoggerLike;
    broadcaster?: EventBroadcaster | null;
    groupChannel?: GroupEventChannel;
}): {
    adapter: NapukettoOneBot11Adapter;
    events: Record<string, unknown>[];
    msg: ReturnType<typeof captureChannel>;
} {
    const msg = captureChannel();
    const events: Record<string, unknown>[] = [];
    // broadcaster：null = 显式缺省（BaseProtocolAdapter 允许 undefined）；缺省 = emit 捕获桩
    let broadcaster: EventBroadcaster | undefined;
    if (options?.broadcaster === null) {
        broadcaster = undefined;
    } else if (options?.broadcaster === undefined) {
        broadcaster = {
            emit: (e: unknown) => events.push(e as Record<string, unknown>),
            register: () => undefined,
            unregister: () => undefined,
        } as unknown as EventBroadcaster;
    } else {
        broadcaster = options.broadcaster;
    }
    const adapter = new NapukettoOneBot11Adapter({
        ...stubOptions(options?.overrides),
        config: new ProtocolConfig({
            path: "ob11-test.toml",
            schema: ob11ConfigSchema,
            defaults: ob11ConfigSchema.parse({}),
            seed: ob11ConfigSchema.parse(options?.seed ?? {}),
        }),
        broadcaster: broadcaster as EventBroadcaster, // null → 运行时 undefined（装配跳过分支）
        msgChannel: msg.channel,
        ...(options?.groupChannel !== undefined ? { groupChannel: options.groupChannel } : {}),
        ...(options?.logger !== undefined ? { logger: options.logger } : {}),
    });
    return { adapter, events, msg };
}

/** 文本消息（chatType 可覆盖；元素 = 单 text）。 */
function textMsg(chatType: number): Record<string, unknown> {
    return {
        msgId: "nt-text",
        msgSeq: "5",
        msgTime: "1700000000000",
        chatType,
        peerUid: "808",
        senderUin: "90009",
        senderUid: "u90009",
        sendNickName: "某人",
        elements: [{ elementType: 1, textElement: { content: "你好" } }],
    };
}

describe("消息事件分支（broadcastMessageEvent）", () => {
    it("C2C 私聊文本 → private 事件（sub_type=friend，sender 无 role 字段）", async () => {
        const { adapter, msg, events } = makeAdapter();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([textMsg(ChatType.C2C)]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const event = events[0] as {
            message_type?: string;
            sub_type?: string;
            sender?: Record<string, unknown>;
        };
        expect(event.message_type).toBe("private");
        expect(event.sub_type).toBe("friend");
        expect(event.sender).toMatchObject({ user_id: 90009, nickname: "某人" });
        // 私聊 sender 不带 role（senderRole 仅群消息注入）
        expect("role" in (event.sender as object)).toBe(false);
        adapter.unsubscribeOnly();
    });

    it("groupCache 命中群主 → sender.role=owner 注入群消息事件", async () => {
        const groupCache = {
            getMember: vi.fn(async () => ({
                uid: "u90009",
                uin: "90009",
                nick: "某人",
                role: NTGroupMemberRole.OWNER,
            })),
        };
        const { adapter, msg, events } = makeAdapter({ overrides: { groupCache } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([textMsg(ChatType.GROUP)]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            message_type: "group",
            sender: { user_id: 90009, role: "owner" },
        });
        expect(groupCache.getMember).toHaveBeenCalledWith("808", "u90009");
        adapter.unsubscribeOnly();
    });
});

describe("grayTip notice 分支（broadcastNotice）", () => {
    it("校准 logger 注入翻译上下文：群撤回事件照常广播", async () => {
        const warn = vi.fn();
        const { adapter, msg, events } = makeAdapter({
            overrides: {
                groupApi: { uidToUin: vi.fn(async () => new Map([["u90009", "90009"]])) },
            },
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([
            {
                ...textMsg(ChatType.GROUP),
                msgId: "nt-revoke",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: 1,
                            revokeElement: { operatorUid: "u90009" },
                        },
                    },
                ],
            },
        ]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_recall")).toBe(true);
        });
        // 翻译成功不走校准日志
        expect(warn).not.toHaveBeenCalled();
        adapter.unsubscribeOnly();
    });

    it("未知 grayTip 子类型（JSON）→ collectGrayTipUids 空 + 事件 null：不广播且 warn 校准", async () => {
        const warn = vi.fn();
        const uidToUin = vi.fn(async () => new Map<string, string>());
        const { adapter, msg, events } = makeAdapter({
            overrides: { groupApi: { uidToUin } },
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([
            {
                ...textMsg(ChatType.GROUP),
                msgId: "nt-json-tip",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: { subElementType: 17, jsonGrayTipElement: {} },
                    },
                ],
            },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        // 无 uid 可转（collectGrayTipUids 短路分支）+ 翻译 null（不广播）
        expect(uidToUin).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("未翻译的 grayTip 子类型");
        adapter.unsubscribeOnly();
    });
});

describe("sysmsg 分支（truncRaw / uidToUin 兜底）", () => {
    it("onRecvSysMsg(undefined) → JSON.stringify(undefined) → warn 的 raw 为空串", async () => {
        const warn = vi.fn();
        const { adapter, msg } = makeAdapter({
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.(undefined);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toEqual({ raw: "" });
        expect(warn.mock.calls[0]?.[1]).toContain("onRecvSysMsg 未知参数形状");
        adapter.unsubscribeOnly();
    });

    it("group_card：card_new/card_old 缺失 → 空串兜底", async () => {
        const groupApi = {
            uidToUin: vi.fn(async () => new Map([["u_90002", "90002"]])),
        };
        const { adapter, msg, events } = makeAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        // 只有 [群号, uid] 两个串 → 新旧名片缺失
        msg.handlers.get("Msg/onRecvSysMsg")?.([[...cardBlob2("1101729931", "u_90002")]]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_card")).toBe(true);
        });
        expect(events.find((e) => e["notice_type"] === "group_card")).toMatchObject({
            group_id: 1101729931,
            user_id: 90002,
            card_new: "",
            card_old: "",
        });
        adapter.unsubscribeOnly();
    });

    it("group_card：uidToUin 返回的 Map 缺目标 uid → user_id=0 兜底", async () => {
        const groupApi = {
            // 转换表不含 u_90002 → map.get(uid) ?? 0 走兜底
            uidToUin: vi.fn(async () => new Map([["u_other", "777"]])),
        };
        const { adapter, msg, events } = makeAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([
            [...cardBlob("1101729931", "u_90002", "新名片", "旧名片")],
        ]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_card")).toBe(true);
        });
        expect(
            (events.find((e) => e["notice_type"] === "group_card") as Record<string, unknown>)[
                "user_id"
            ],
        ).toBe(0);
        adapter.unsubscribeOnly();
    });
});

/** varint 编码（合成 sysmsg 用）。 */
function encVarint(v: number): number[] {
    const out: number[] = [];
    let value = v;
    while (true) {
        const b = value & 0x7f;
        value >>>= 7;
        if (value === 0) {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}

/** length-delimited 字段（tag + 长度 + 字节）。 */
function bytesField(no: number, text: string): number[] {
    const payload = [...new TextEncoder().encode(text)];
    return [(no << 3) | 0x02, payload.length, ...payload];
}

/** 合成 732:21 群名片变更（只有前两个串，名片新旧缺失）。 */
function cardBlob2(group: string, uid: string): number[] {
    const f2 = [0x08, ...encVarint(732), 0x10, ...encVarint(21)];
    return [0x12, f2.length, ...f2, ...bytesField(3, group), ...bytesField(4, uid)];
}

/** 合成 732:21 群名片变更（strings = [群号, 对象 uid, 新名片, 旧名片]）。 */
function cardBlob(group: string, uid: string, cardNew: string, cardOld: string): number[] {
    const f2 = [0x08, ...encVarint(732), 0x10, ...encVarint(21)];
    return [
        0x12,
        f2.length,
        ...f2,
        ...bytesField(3, group),
        ...bytesField(4, uid),
        ...bytesField(5, cardNew),
        ...bytesField(6, cardOld),
    ];
}

describe("群请求分支（broadcastGroupRequests）", () => {
    it("已处理状态（status ≠ KUNHANDLE）→ 事件 null 跳过不广播", async () => {
        const groupHandlers = new Map<string, (...args: unknown[]) => void>();
        const groupChannel = {
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                groupHandlers.set(event, handler);
                return () => undefined;
            }),
        } as unknown as GroupEventChannel;
        const groupApi = { uidToUin: vi.fn(async () => new Map<string, string>()) };
        const { adapter, events } = makeAdapter({ overrides: { groupApi }, groupChannel });
        await adapter.subscribeOnly();
        const handled = { seq: "9", type: 7, status: 2 } as unknown as GroupNotify;
        groupHandlers.get("Group/onGroupNotifiesUpdated")?.(false, [handled]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });
});

describe("传输装配跳过与请求兜底（broadcaster 缺省 / 非 Error 异常）", () => {
    it("broadcaster 缺省 → start 跳过传输装配（transports=null）且 stop 走 null 分支", async () => {
        const { adapter, msg } = makeAdapter({
            broadcaster: null, // 显式缺省：构造参数不传广播器（BaseProtocolAdapter 允许 undefined）
        });
        await adapter.start();
        // 传输未装配（broadcaster === undefined 分支）；订阅链路照常
        const transports = (adapter as unknown as { transports: unknown | null }).transports;
        expect(transports).toBeNull();
        expect(msg.channel.on).toHaveBeenCalledTimes(4);
        await adapter.stop();
        // stop → stopAll：transports=null 分支 + 全部退订
        expect(msg.off).toHaveBeenCalledTimes(4);
    });

    it("请求包装层：非 Error 异常 → 兜底 respond message=String(err)", async () => {
        const { adapter } = makeAdapter({
            seed: {
                httpServers: [{ enabled: true, host: "127.0.0.1", port: 0 }],
                heartbeatInterval: 0,
            },
        });
        await adapter.start();
        try {
            const wrapped = (
                adapter as unknown as {
                    transports: {
                        servers: Array<{
                            onRequest?: (req: unknown, respond: (res: unknown) => void) => void;
                        }>;
                    } | null;
                }
            ).transports?.servers[0]?.onRequest as (
                req: unknown,
                respond: (res: unknown) => void,
            ) => void;
            expect(wrapped).toBeTypeOf("function");
            const responses: unknown[] = [];
            let calls = 0;
            wrapped({ action: "get_status" }, (res) => {
                calls += 1;
                responses.push(res);
                if (calls === 1) {
                    throw "响应失败"; // 非 Error（字符串）触发 instanceof 判定假分支
                }
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(responses).toHaveLength(2);
            expect(responses[1]).toMatchObject({ retcode: 999, message: "响应失败" });
        } finally {
            await adapter.stop();
        }
    });
});
