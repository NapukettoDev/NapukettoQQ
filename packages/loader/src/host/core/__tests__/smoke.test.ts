/**
 * smoke.test.ts：P2-1 收发消息冒烟自检单测（smoke.ts runSmokeTest 全分支）。
 *
 * 假 kernel（NTEventChannel 可手动 emit / MsgBridge / MsgApi / GroupApi）+
 * env 快照隔离（vi.stubEnv + vi.resetModules + 动态 import，NAPUTO_SMOKE_PEER
 * 每用例注入）。覆盖：
 *  - session 缺失短路 false
 *  - 目标解析：缺省自己（c2c + selfUid 直通）、group:<uin>、c2c:<uin>（uinToUid）、
 *    残缺/非法格式回退自己
 *  - 结果判定：发送成功+收到事件 → true；发送失败 → false（即便收到事件）；
 *    无事件但落库命中 → true；双失败 → false
 *  - 容错分支：onRecvMsg 解析抛错、落库 fetchMessages 抛错、注销抛错
 */
// biome-ignore-all lint/style/useNamingConvention: 对象键名为 kernel/wrapper 导出面（PascalCase 类名），必须原样保留

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalElementLike, CoreContextLike, KernelLike } from "../../types.js";

/** log 收集器（smoke.ts 的进度日志可断言）。 */
const h = vi.hoisted(() => {
    return { logs: [] as string[] };
});

vi.mock("../../util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../util.js")>();
    return {
        ...actual,
        log: (msg: string) => {
            h.logs.push(msg);
        },
    };
});

/** ChatType（kernel 常量对象最小面；GROUP=1 与 C2C=2 同 msg-log.test.ts 约定）。 */
const CHAT_TYPE = { GROUP: 1, C2C: 2 };
const CHAT_TYPE_KEY = "ChatType";

/** 可手动 emit 的事件通道（记录订阅 handler）。 */
class FakeChannel {
    readonly handlers = new Map<string, (payload: unknown) => void>();
    on(event: string, handler: (payload: unknown) => void): () => void {
        this.handlers.set(event, handler);
        return () => {
            this.handlers.delete(event);
        };
    }
    emit(event: string, payload: unknown): void {
        this.handlers.get(event)?.(payload);
    }
}

/** 假 kernel 构造参数。 */
interface FakeKernelOptions {
    /** uin → uid 映射（缺省空映射 = 解析失败）。 */
    uidMap?: Map<string, string>;
    /** sendMessage 抛错（发送失败分支）。 */
    failSend?: boolean;
    /** fetchMessages 抛错（落库失败分支）。 */
    failFetch?: boolean;
    /** fetchMessages 返回值（落库核对列表；缺省 [{msgId:"m_other_1"}]）。 */
    fetchResult?: Record<string, unknown>[];
    /** unregister 抛错（收尾容错分支）。 */
    failUnregister?: boolean;
    /** toCanonicalElements 替换（解析失败分支）。 */
    toCanonical?: (msg: unknown) => CanonicalElementLike[];
}

/** 假 kernel：记录关键调用面，供断言 peer / 元素。 */
function fakeKernel(options: FakeKernelOptions = {}): {
    kernel: KernelLike;
    /** runSmokeTest 构造的事件通道（未构造时 undefined——session 为空短路）。 */
    lastChannel: () => FakeChannel | undefined;
} {
    let created: FakeChannel | undefined;
    const kernelBox: Record<string, unknown> = {
        listLoginAccounts: () => Promise.resolve([]),
        buildSessionConfig: () => ({}),
        createLifecycleSessionListener: () => ({}),
        initAndStartSession: () => Promise.resolve(),
        waitSessionReady: () => Promise.resolve(),
        toCanonicalElements:
            options.toCanonical ??
            ((msg: unknown) => {
                const raw = msg as { elements?: CanonicalElementLike[] };
                return Array.isArray(raw.elements) ? raw.elements : [];
            }),
        [CHAT_TYPE_KEY]: CHAT_TYPE,
        // 通道实例即 FakeChannel（runSmokeTest 只构造一个，emit 由此驱动）
        NTEventChannel: class extends FakeChannel {
            constructor(_name: string) {
                super();
                created = this;
            }
        },
        MsgBridge: class {
            register(): void {
                // 桩
            }
            unregister(): void {
                if (options.failUnregister) {
                    throw new Error("unregister 断言");
                }
            }
        },
        GroupApi: class {
            uinToUid(uins: string[]): Promise<Map<string, string>> {
                const map = options.uidMap ?? new Map<string, string>();
                const out = new Map<string, string>();
                for (const uin of uins) {
                    const uid = map.get(uin);
                    if (uid !== undefined) {
                        out.set(uin, uid);
                    }
                }
                return Promise.resolve(out);
            }
        },
        MsgApi: class {
            sendMessage(): Promise<{ msgId: string }> {
                if (options.failSend) {
                    return Promise.reject(new Error("发送风控"));
                }
                return Promise.resolve({ msgId: "m_smoke_1" });
            }
            fetchMessages(): Promise<Record<string, unknown>[]> {
                if (options.failFetch) {
                    return Promise.reject(new Error("库未就绪"));
                }
                return Promise.resolve(options.fetchResult ?? [{ msgId: "m_other_1" }]);
            }
        },
    };
    return { kernel: kernelBox as unknown as KernelLike, lastChannel: () => created };
}

/** 登录上下文（self uin=10001）。 */
function freshCtx(): CoreContextLike {
    return { session: {}, login: { uin: "10001", uid: "u_self" } };
}

/** 取全新 smoke 模块（隔离 env 快照）。 */
async function freshSmoke(): Promise<typeof import("../smoke.js")> {
    vi.resetModules();
    return await import("../smoke.js");
}

/** 微任务/定时器推进（smoke 内部 5s settle 等待）。 */
async function settle(ms = 5000): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    h.logs.length = 0;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

const LOGIN = { uin: "10001", uid: "u_self", nick: "自己" };

describe("runSmokeTest 短路与目标解析", () => {
    it("session 为空 → false，不构造事件通道", async () => {
        const { kernel, lastChannel } = fakeKernel();
        const smoke = await freshSmoke();
        const ok = await smoke.runSmokeTest(kernel, { session: null }, LOGIN);
        expect(ok).toBe(false);
        expect(lastChannel()).toBeUndefined();
        expect(h.logs.some((l) => l.includes("session 为空"))).toBe(true);
    });

    it("缺省目标 = 自己（c2c + loginResult.uid 直通），收到回显事件 → true", async () => {
        const { kernel, lastChannel } = fakeKernel();
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [
            { msgId: "m_smoke_1", elements: [{ type: "text", text: "hi" }] },
        ]);
        await settle();
        expect(await pending).toBe(true);
        // 发送 peer：self uin 命中 ctx.login → 直接用 loginResult.uid
        expect(h.logs.some((l) => l.includes("目标=c2c:10001"))).toBe(true);
        expect(h.logs.some((l) => l.includes("发送成功 msgId=m_smoke_1"))).toBe(true);
    });

    it("group:<uin> → 群号直通 peerUid（不走 uinToUid）", async () => {
        vi.stubEnv("NAPUTO_SMOKE_PEER", "group:999");
        const { kernel, lastChannel } = fakeKernel();
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [{ msgId: "m_smoke_1" }]);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("目标=group:999"))).toBe(true);
    });

    it("c2c:<其他 uin> → uinToUid 解析 uid", async () => {
        vi.stubEnv("NAPUTO_SMOKE_PEER", "c2c:20002");
        const uidMap = new Map([["20002", "u_20002"]]);
        const { kernel, lastChannel } = fakeKernel({ uidMap });
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [{ msgId: "m_smoke_1" }]);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("peerUid=u_20002") || l.includes("发送成功"))).toBe(
            true,
        );
    });

    it("c2c 目标解析失败（空映射）→ runSmokeTest 抛错（bootstrap 侧捕获）", async () => {
        vi.stubEnv("NAPUTO_SMOKE_PEER", "c2c:20002");
        const { kernel } = fakeKernel({ uidMap: new Map() });
        const smoke = await freshSmoke();
        await expect(smoke.runSmokeTest(kernel, freshCtx(), LOGIN)).rejects.toThrow(
            "uinToUid 解析失败: 20002",
        );
    });

    it("非法格式（bogus / group: 空uin / c2c: 空uin）→ 回退自己", async () => {
        for (const peer of ["bogus", "group:", "c2c:"]) {
            h.logs.length = 0;
            vi.stubEnv("NAPUTO_SMOKE_PEER", peer);
            const smoke = await freshSmoke();
            const { kernel, lastChannel } = fakeKernel();
            const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
            const channel = lastChannel();
            if (channel === undefined) {
                throw new Error("事件通道未构造（fakeKernel 契约破坏）");
            }
            await settle(0);
            channel.emit("Msg/onRecvMsg", [{ msgId: "m_smoke_1" }]);
            await settle();
            expect(await pending).toBe(true);
            expect(h.logs.some((l) => l.includes("目标=c2c:10001"))).toBe(true);
        }
    });
});

describe("runSmokeTest 结果判定", () => {
    it("发送失败 → false（即便收到事件）", async () => {
        const { kernel, lastChannel } = fakeKernel({ failSend: true });
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [{ msgId: "x" }]);
        await settle();
        expect(await pending).toBe(false);
        expect(h.logs.some((l) => l.includes("发送失败") && l.includes("发送风控"))).toBe(true);
        expect(h.logs.some((l) => l.includes("发送=FAIL"))).toBe(true);
    });

    it("无事件但落库命中刚发消息 → true", async () => {
        const { kernel } = fakeKernel({
            fetchResult: [{ msgId: "m_old" }, { msgId: "m_smoke_1" }],
        });
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("落库验证: 最近 2 条"))).toBe(true);
        expect(h.logs.some((l) => l.includes("含刚发消息"))).toBe(true);
    });

    it("无事件且落库未命中 → false（打印最近消息摘要）", async () => {
        const { kernel } = fakeKernel();
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        await settle();
        expect(await pending).toBe(false);
        expect(h.logs.some((l) => l.includes("落库验证: 最近 1 条"))).toBe(true);
        expect(h.logs.some((l) => l.includes("最近消息 msgId=m_other_1"))).toBe(true);
    });

    it("落库 fetchMessages 抛错 → 容错日志，结果 false", async () => {
        const { kernel } = fakeKernel({ failFetch: true });
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        await settle();
        expect(await pending).toBe(false);
        expect(h.logs.some((l) => l.includes("落库验证失败") && l.includes("库未就绪"))).toBe(true);
    });
});

describe("runSmokeTest 容错分支", () => {
    it("onRecvMsg 消息解析抛错 → 记日志继续（received 计数不受影响）", async () => {
        const { kernel, lastChannel } = fakeKernel({
            toCanonical: () => {
                throw new Error("元素断言");
            },
        });
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [{ msgId: "m_1" }]);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("onRecvMsg 解析失败") && l.includes("元素断言"))).toBe(
            true,
        );
    });

    it("onRecvMsg 多条消息逐条计数；非数组单条也处理", async () => {
        const { kernel, lastChannel } = fakeKernel();
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [
            { msgId: "m_1", elements: [{ type: "text", text: "a" }] },
            { msgId: "m_2", elements: [{ type: "text", text: "b" }] },
        ]);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("收到 #2"))).toBe(true);
    });

    it("onRecvMsg 消息数组含无效项（null/非对象）→ 过滤", async () => {
        const { kernel, lastChannel } = fakeKernel();
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [null, "str", { msgId: "m_1" }]);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("收到 #1"))).toBe(true);
    });

    it("MsgBridge 注销抛错 → 容错日志，结果不受影响", async () => {
        const { kernel, lastChannel } = fakeKernel({ failUnregister: true });
        const smoke = await freshSmoke();
        const pending = smoke.runSmokeTest(kernel, freshCtx(), LOGIN);
        const channel = lastChannel();
        if (channel === undefined) {
            throw new Error("事件通道未构造（fakeKernel 契约破坏）");
        }
        await settle(0);
        channel.emit("Msg/onRecvMsg", [{ msgId: "m_smoke_1" }]);
        await settle();
        expect(await pending).toBe(true);
        expect(h.logs.some((l) => l.includes("注销失败（忽略）"))).toBe(true);
    });
});
