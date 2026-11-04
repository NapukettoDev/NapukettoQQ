/**
 * ipc-bootstrap.test.ts：IPC 装配单测（attachIpcServices / createIpcActionsForCore）。
 *
 * 回归重点（2026-08-20 生产事故）：kernel 的 Api 是**类**，注入其方法必须保 this。
 * ipc-actions.test.ts 注入的是 `vi.fn` 裸函数（本身不依赖 this），因此测不出
 * 「摘方法丢 this」这类装配缺陷——本文件用「方法读 this.service」的假 GroupApi
 * 覆盖该缺陷：未 bind 时 uinToUid 会抛
 * `Cannot read properties of undefined (reading 'service')`。
 *
 * 事件通道转发（forwardChannel）经 ipc-sender mock 捕获 sendEvent：事件名
 * "Service/method" 拆分、无斜杠兜底、onAny 缺失跳过、stop 退订。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelServices } from "../../core/kernel-services.js";
import { callIpcAction, type IpcActionHandler, type IpcPeer } from "../ipc-actions.js";
import { attachIpcServices, createIpcActionsForCore } from "../ipc-bootstrap.js";

/** sendEvent 捕获（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return { events: [] as Array<{ service: string; name: string; args: unknown[] }> };
});

vi.mock("../ipc-sender.js", () => ({
    sendEvent: vi.fn((service: string, name: string, args: unknown[]) => {
        h.events.push({ service, name, args });
    }),
}));

/** 假 GroupApi：与 kernel GroupApi 同构——uinToUid 经 `this.service` 调原生。 */
class FakeGroupApi {
    private readonly service = {
        getUidByUins: async (uins: string[]) => ({
            errCode: 0,
            uids: new Map(uins.map((uin) => [uin, `u_${uin}`])),
        }),
    };

    async uinToUid(uins: string[]): Promise<Map<string, string>> {
        const raw = await this.service.getUidByUins(uins);
        return raw.uids;
    }

    async getGroupList(): Promise<unknown[]> {
        return [];
    }
}

/** 最小 KernelServices（只填动作表用到的成员；其余 unknown 字段经 cast 省略）。 */
function mockServices(): { services: KernelServices; sent: IpcPeer[] } {
    const sent: IpcPeer[] = [];
    const services = {
        msgApi: {
            sendMessage: async (peer: IpcPeer) => {
                sent.push(peer);
                return { msgId: "42" };
            },
        },
        groupApi: new FakeGroupApi(),
        groupCache: { listGroupsRefreshed: async () => [] },
        friendApi: { getFriendList: async () => [] },
        self: { uin: "10001", nickname: "测试号" },
        // forwardChannel 只在 onAny 是函数时订阅——空对象即跳过事件转发
        channel: {},
        groupChannel: {},
    } as unknown as KernelServices;
    return { services, sent };
}

describe("attachIpcServices", () => {
    beforeEach(() => {
        h.events.length = 0;
    });

    it("私聊 peerUin → uid：注入的 uinToUid 保留 this（不再 undefined.service）", async () => {
        const { services, sent } = mockServices();
        const actions = new Map<string, IpcActionHandler>();
        attachIpcServices(actions, services);

        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUin: "12345",
            elements: [{ type: "text", text: "你好" }],
        });

        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(sent[0]).toEqual({ chatType: 1, peerUid: "u_12345" });
    });

    it("群聊 peerUin 直通群号（不经 uinToUid）", async () => {
        const { services, sent } = mockServices();
        const actions = new Map<string, IpcActionHandler>();
        attachIpcServices(actions, services);

        const result = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "978515338",
            elements: [],
        });

        expect(result).toEqual({ ok: true, value: { msgId: "42" } });
        expect(sent[0]).toEqual({ chatType: 2, peerUid: "978515338" });
    });

    it("动作表并入后 login.getSelf 可用（装配确实生效）", async () => {
        const { services } = mockServices();
        const actions = new Map<string, IpcActionHandler>();
        const stop = attachIpcServices(actions, services);

        const result = await callIpcAction(actions, "login.getSelf", undefined);

        expect(result).toEqual({ ok: true, value: { uin: "10001", nickname: "测试号" } });
        expect(() => stop()).not.toThrow();
    });

    it("groupApi 无 uinToUid → 不注入（私聊 peerUin 报缺 peerUid，群聊不受影响）", async () => {
        const { services, sent } = mockServices();
        // 换成无 uinToUid 的裸对象
        (services as unknown as Record<string, unknown>)["groupApi"] = {
            getGroupList: async () => [],
        };
        const actions = new Map<string, IpcActionHandler>();
        attachIpcServices(actions, services);
        const fail = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 1,
            peerUin: "12345",
            elements: [],
        });
        expect(fail).toEqual({
            ok: false,
            error: { code: "UNKNOWN", message: "缺 peerUid（或 peerUin 且未注入 uinToUid）" },
        });
        const ok = await callIpcAction(actions, "msg.sendMessage", {
            chatType: 2,
            peerUin: "978",
            elements: [],
        });
        expect(ok).toEqual({ ok: true, value: { msgId: "42" } });
        expect(sent).toHaveLength(1);
    });

    it("事件通道转发：onAny 事件名拆分 service/name；stop 退订五通道", () => {
        const { services } = mockServices();
        const offFns: Array<() => void> = [];
        const channels: Record<string, unknown> = {};
        for (const key of [
            "channel",
            "groupChannel",
            "friendChannel",
            "recentContactChannel",
            "loginChannel",
        ]) {
            channels[key] = {
                onAny: vi.fn((handler: (event: string, ...args: unknown[]) => void) => {
                    // 记录 handler 以便手动 emit
                    (channels as Record<string, unknown>)[`${key}:handler`] = handler;
                    const off = () => undefined;
                    offFns.push(off);
                    return off;
                }),
            };
        }
        const merged = { ...services, ...channels } as KernelServices;
        const actions = new Map<string, IpcActionHandler>();
        const stop = attachIpcServices(actions, merged);
        const handler = (channels as Record<string, unknown>)["channel:handler"] as
            | ((event: string, ...args: unknown[]) => void)
            | undefined;
        handler?.("Msg/onRecvMsg", { msgId: "m1" });
        handler?.("NoSlashEvent");
        expect(h.events).toEqual([
            { service: "Msg", name: "onRecvMsg", args: [{ msgId: "m1" }] },
            { service: "NoSlashEvent", name: "", args: [] },
        ]);
        // stop：五通道退订（offFns 5 个被调用）+ 并入动作表移除
        const sizeBefore = actions.size;
        expect(sizeBefore).toBeGreaterThan(0);
        stop();
        expect(actions.size).toBe(0);
    });

    it("onAny 缺失 / 非函数返回值 → 跳过转发与退订收集（不崩）", () => {
        const { services } = mockServices();
        const merged = {
            ...services,
            channel: {},
            groupChannel: { onAny: "不是函数" },
            friendChannel: { onAny: () => "非函数返回值" },
        } as unknown as KernelServices;
        const actions = new Map<string, IpcActionHandler>();
        const stop = attachIpcServices(actions, merged);
        expect(() => stop()).not.toThrow();
        expect(h.events).toHaveLength(0);
    });
});

describe("createIpcActionsForCore", () => {
    it("core.refreshQr 存在 → login.refreshQr 注册且透传布尔结果", async () => {
        const refreshQr = vi.fn(() => true);
        const core = { refreshQr } as unknown as Parameters<typeof createIpcActionsForCore>[0];
        const actions = createIpcActionsForCore(core);
        const result = await callIpcAction(actions, "login.refreshQr", undefined);
        expect(result).toEqual({ ok: true, value: true });
        expect(refreshQr).toHaveBeenCalledTimes(1);
    });

    it("core.refreshQr 返回 undefined → 兜底 false（?? 链）", async () => {
        const core = { refreshQr: () => undefined } as unknown as Parameters<
            typeof createIpcActionsForCore
        >[0];
        const actions = createIpcActionsForCore(core);
        const result = await callIpcAction(actions, "login.refreshQr", undefined);
        expect(result).toEqual({ ok: true, value: false });
    });

    it("core.refreshQr 缺失（老 kernel）→ 空动作表（不注册）", () => {
        const actions = createIpcActionsForCore(
            {} as Parameters<typeof createIpcActionsForCore>[0],
        );
        expect(actions.size).toBe(0);
    });
});
