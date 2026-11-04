/**
 * session.test.ts：session 选择与就绪探测单测（session.ts 全量纯函数面）。
 *
 * 覆盖：
 *  - isSessionUsable：null / getMsgService 抛断言 / 返回 null / 返回 service
 *  - collectCandidateSessions：四路候选（getMainSession / getNTWrapperSession /
 *    get() / qqSession）各自命中与异常吞掉
 *  - pickBestSession：空候选、valid 暂存、READY 优先短路、全无效 → null
 *  - startSessionProbe：5s 间隔探测日志（qqSession/get()/getNT 三源）、探测失败
 *    分支、durationMs 到期停表
 *  - probeSessionMethods：方法面枚举、session 缺失、原型枚举抛错
 *
 * host/util 的 log 经 vi.mock 替换为内存收集器（session.ts 的探测输出可断言），
 * 其余导出（errMsg 等）透传真实实现。
 */
// biome-ignore-all lint/style/useNamingConvention: 对象键名为 kernel/wrapper 导出面（PascalCase 类名），必须原样保留

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreContextLike, KernelLike } from "../../types.js";
import type { SharedState } from "../../util.js";
import {
    collectCandidateSessions,
    isSessionUsable,
    pickBestSession,
    probeSessionMethods,
    startSessionProbe,
} from "../session.js";

/** log 收集器（vi.hoisted：mock 工厂执行前可用）。 */
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

beforeEach(() => {
    h.logs.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

/** 空共享状态。 */
function freshState(overrides: Partial<SharedState> = {}): SharedState {
    return {
        wrapperExports: null,
        qqSession: null,
        qqLoginService: null,
        bootstrapped: false,
        ...overrides,
    };
}

/** 最小 ctx。 */
function freshCtx(session: unknown = {}): CoreContextLike {
    return { session };
}

describe("isSessionUsable", () => {
    it("null / undefined → false", () => {
        expect(isSessionUsable(null)).toBe(false);
        expect(isSessionUsable(undefined)).toBe(false);
    });

    it("getMsgService 抛断言 → false（cpp_impl 未激活）", () => {
        expect(
            isSessionUsable({
                getMsgService: () => {
                    throw new Error("assert failed");
                },
            }),
        ).toBe(false);
    });

    it("getMsgService 返回 null → false（对象有效但未 init）", () => {
        expect(isSessionUsable({ getMsgService: () => null })).toBe(false);
    });

    it("getMsgService 返回 service → true（核心 service 已挂载）", () => {
        expect(isSessionUsable({ getMsgService: () => ({}) })).toBe(true);
    });
});

describe("collectCandidateSessions", () => {
    it("四路候选全部命中（tag 与顺序符合优先级）", () => {
        const mainSession = { getMsgService: () => ({}) };
        const kernel = {
            getMainSession: () => mainSession,
        } as unknown as KernelLike;
        const S2 = {
            getNTWrapperSession: (key: string) => ({ key }),
            get: () => ({ singleton: true }),
        };
        const state = freshState({
            wrapperExports: { NodeIQQNTWrapperSession: S2 },
            qqSession: { captured: true },
        });
        const candidates = collectCandidateSessions(state, kernel, freshCtx());
        expect(candidates.map((c) => c.tag)).toEqual([
            "getMainSession(nt_x)",
            "getNT(Session)",
            "get()",
            "qqSession",
        ]);
        expect(candidates.map((c) => c.s)).toEqual([
            mainSession,
            { key: "Session" },
            { singleton: true },
            { captured: true },
        ]);
    });

    it("getMainSession 抛错 → 吞掉，其余候选继续", () => {
        const kernel = {
            getMainSession: () => {
                throw new Error("main session 不可用");
            },
        } as unknown as KernelLike;
        const candidates = collectCandidateSessions(
            freshState({ qqSession: { a: 1 } }),
            kernel,
            freshCtx(),
        );
        expect(candidates.map((c) => c.tag)).toEqual(["qqSession"]);
    });

    it("S2 的 getNTWrapperSession / get 抛错 → 分别吞掉", () => {
        const kernel = {} as KernelLike;
        const S2 = {
            getNTWrapperSession: () => {
                throw new Error("getNT fail");
            },
            get: () => {
                throw new Error("get fail");
            },
        };
        const candidates = collectCandidateSessions(
            freshState({ wrapperExports: { NodeIQQNTWrapperSession: S2 } }),
            kernel,
            freshCtx(),
        );
        expect(candidates).toEqual([]);
    });

    it("wrapperExports 为空且无 qqSession → 空候选", () => {
        const candidates = collectCandidateSessions(freshState(), {} as KernelLike, freshCtx());
        expect(candidates).toEqual([]);
    });

    it("getNTWrapperSession / get 返回 null → 不入候选（falsy 剔除）", () => {
        const S2 = { getNTWrapperSession: () => null, get: () => null };
        const candidates = collectCandidateSessions(
            freshState({ wrapperExports: { NodeIQQNTWrapperSession: S2 } }),
            {} as KernelLike,
            freshCtx(),
        );
        expect(candidates).toEqual([]);
    });
});

describe("pickBestSession", () => {
    it("空候选 → null", () => {
        expect(pickBestSession([])).toBeNull();
    });

    it("首个 valid 暂存，后续 READY 短路胜出", () => {
        const validOnly = { getMsgService: () => null };
        const ready = { getMsgService: () => ({}) };
        const best = pickBestSession([
            { s: validOnly, tag: "valid" },
            { s: ready, tag: "ready" },
        ]);
        expect(best?.tag).toBe("ready");
    });

    it("READY 在前 → 立即返回（不继续扫描）", () => {
        const ready = { getMsgService: () => ({}) };
        const best = pickBestSession([
            { s: ready, tag: "ready-first" },
            { s: { getMsgService: () => null }, tag: "later" },
        ]);
        expect(best?.tag).toBe("ready-first");
    });

    it("全无效（断言 / null）→ null", () => {
        const best = pickBestSession([
            { s: null, tag: "null" },
            {
                s: {
                    getMsgService: () => {
                        throw new Error("assert");
                    },
                },
                tag: "assert",
            },
        ]);
        expect(best).toBeNull();
    });

    it("只有 valid 非 READY → 返回首个 valid", () => {
        const valid = { getMsgService: () => null };
        const best = pickBestSession([{ s: valid, tag: "valid-only" }]);
        expect(best?.tag).toBe("valid-only");
    });
});

describe("startSessionProbe", () => {
    it("5s 间隔探测：qqSession / get() / getNT 三源描述进日志", async () => {
        vi.useFakeTimers();
        const S2 = {
            get: () => ({ getMsgService: () => ({}) }),
            getNTWrapperSession: (key: string) => ({ getMsgService: () => null, key }),
        };
        const state = freshState({
            wrapperExports: { NodeIQQNTWrapperSession: S2 },
            qqSession: { getMsgService: () => null, getSessionId: () => 7 },
        });
        const handle = startSessionProbe(state, freshCtx());
        await vi.advanceTimersByTimeAsync(5000);
        const probeLines = h.logs.filter((l) => l.includes("session 探测"));
        expect(probeLines).toHaveLength(1);
        expect(probeLines[0]).toContain("qqSession[id=7 msgSvc=null]");
        expect(probeLines[0]).toContain("get()[");
        expect(probeLines[0]).toContain('getNT("Session")[');
        clearInterval(handle);
    });

    it("探测内部抛错（S2.get 抛）→ 日志留痕不崩", async () => {
        vi.useFakeTimers();
        const S2 = {
            get: () => {
                throw new Error("get 断言");
            },
        };
        const state = freshState({ wrapperExports: { NodeIQQNTWrapperSession: S2 } });
        const handle = startSessionProbe(state, freshCtx());
        await vi.advanceTimersByTimeAsync(5000);
        expect(h.logs.some((l) => l.includes("session 探测失败") && l.includes("get 断言"))).toBe(
            true,
        );
        clearInterval(handle);
    });

    it("durationMs 到期自动停表（后续轮不再探测）", async () => {
        vi.useFakeTimers();
        const state = freshState({ qqSession: { getMsgService: () => null } });
        startSessionProbe(state, freshCtx(), 12000);
        await vi.advanceTimersByTimeAsync(10000);
        const countAt10s = h.logs.filter((l) => l.includes("session 探测")).length;
        expect(countAt10s).toBe(2); // 5s + 10s 两轮
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.logs.filter((l) => l.includes("session 探测")).length).toBe(countAt10s);
    });
});

describe("probeSessionMethods", () => {
    it("session 缺失 → 无输出不抛", () => {
        expect(() => probeSessionMethods({ session: null })).not.toThrow();
        expect(h.logs).toHaveLength(0);
    });

    it("session 方法面枚举：原型 + ownKeys 去重合并，关键方法类型进日志", () => {
        const proto = { init: () => 1 };
        const session = Object.assign(Object.create(proto), { startNT: () => 2 });
        probeSessionMethods({ session });
        const methodsLine = h.logs.find((l) => l.includes("session methods"));
        expect(methodsLine).toContain("init");
        expect(methodsLine).toContain("startNT");
        const typesLine = h.logs.find((l) => l.includes("session.init="));
        expect(typesLine).toContain("init=function");
        expect(typesLine).toContain("startNT=function");
    });

    it("原型枚举抛错（Proxy 陷阱）→ 日志留痕不抛", () => {
        const session = new Proxy(
            {},
            {
                getOwnPropertyDescriptor: () => {
                    throw new Error("trap");
                },
                ownKeys: () => {
                    throw new Error("trap");
                },
                getPrototypeOf: () => {
                    throw new Error("trap");
                },
            },
        );
        expect(() => probeSessionMethods({ session })).not.toThrow();
        expect(h.logs.some((l) => l.includes("session 探测失败"))).toBe(true);
    });
});
