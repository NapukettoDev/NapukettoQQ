/**
 * probe.test.ts：引导尾部观测相位单测（P2 拆分自 bootstrap/core-phases）。
 *
 * 直接针对 bootstrap/probe.ts 四个导出（不经 bootstrapWithCore）：
 *  - env 未开启时四个相位全部空转
 *  - probeOnce：立即探测（缺省文件名）/ kernel 缺 probeRuntime / probeRuntime 抛错
 *  - runProbePhase：35s 晚探测（napuketto-probe-late.json）+ 定时器 unref +
 *    关停钩子清理 + 晚探测抛错容错
 *  - runListenerRecordingPhase：kernel 缺录制器 / 部分注册失败逐条日志 / 抛错容错
 *  - runSmokeIfEnabled：通过 / 未通过 / 抛错（冒烟实现经 vi.mock 注入）
 *
 * env 快照每用例独立（stubEnv + resetModules + 动态 import）；shared/boot-log 的 log
 * 经 vi.mock 收集，smoke.ts 的 runSmokeTest 经 vi.mock 控制返回/抛错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    CoreContextLike,
    KernelLike,
    LoginResultLike,
} from "../../../src/host/runtime/types.js";

/** 跨 mock 共享记录（vi.hoisted）。 */
const h = vi.hoisted(() => {
    return {
        /** log 收集器。 */
        logs: [] as string[],
        /** runSmokeTest 调用（kernel/ctx/loginResult 透传断言）。 */
        smokeCalls: [] as Array<{ kernel: unknown; ctx: unknown; loginResult: unknown }>,
        /** runSmokeTest 返回值。 */
        smokeResult: true as boolean,
        /** runSmokeTest 抛出（非 null 时 reject）。 */
        smokeError: null as Error | null,
        /** probeRuntime 调用（filename 参数）。 */
        probeCalls: [] as Array<string | undefined>,
    };
});

vi.mock("../../../src/shared/boot-log.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/shared/boot-log.js")>();
    return {
        ...actual,
        log: (msg: string) => {
            h.logs.push(msg);
        },
    };
});

vi.mock("../../../src/host/bootstrap/smoke.js", () => ({
    runSmokeTest: vi.fn((kernel: unknown, ctx: unknown, loginResult: unknown) => {
        h.smokeCalls.push({ kernel, ctx, loginResult });
        if (h.smokeError !== null) {
            return Promise.reject(h.smokeError);
        }
        return Promise.resolve(h.smokeResult);
    }),
}));

const LOGIN: LoginResultLike = { uin: "10001", uid: "u1", nick: "甲" };

beforeEach(() => {
    h.logs.length = 0;
    h.smokeCalls.length = 0;
    h.smokeResult = true;
    h.smokeError = null;
    h.probeCalls.length = 0;
    vi.unstubAllEnvs();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

/** 取全新 bootstrap/probe 模块（env 快照隔离）。 */
async function freshProbe(): Promise<typeof import("../../../src/host/bootstrap/probe.js")> {
    vi.resetModules();
    return await import("../../../src/host/bootstrap/probe.js");
}

/** 最小 ctx。 */
function freshCtx(): CoreContextLike {
    return { session: {} };
}

describe("观测相位开关", () => {
    it("四个 env 均未开启 → 全部空转（不触达 kernel、无定时器/日志）", async () => {
        vi.useFakeTimers();
        const probeRuntime = vi.fn();
        const startListenerRecording = vi.fn();
        const kernel = { probeRuntime, startListenerRecording } as unknown as KernelLike;
        const probe = await freshProbe();

        probe.probeOnce(kernel, freshCtx());
        probe.runListenerRecordingPhase(kernel, freshCtx());
        probe.runProbePhase(kernel, freshCtx());
        await probe.runSmokeIfEnabled(kernel, freshCtx(), LOGIN);

        expect(probeRuntime).not.toHaveBeenCalled();
        expect(startListenerRecording).not.toHaveBeenCalled();
        expect(h.smokeCalls).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.logs).toEqual([]);
    });
});

describe("probeOnce", () => {
    it("NAPUKETTO_PROBE=1 → 立即探测（缺省文件名）并记录结果", async () => {
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const probeRuntime = vi.fn((_ctx: CoreContextLike, filename?: string) => {
            h.probeCalls.push(filename);
            return { session: {}, services: { a: 1, b: 2 } };
        });
        const kernel = { probeRuntime } as unknown as KernelLike;
        const ctx = freshCtx();
        const probe = await freshProbe();

        probe.probeOnce(kernel, ctx);

        expect(probeRuntime).toHaveBeenCalledWith(ctx);
        expect(h.probeCalls).toEqual([undefined]);
        expect(h.logs).toContain("bootstrap: probe done, session=ok, services=2");
    });

    it("kernel 缺 probeRuntime → 静默跳过（不抛错/不写日志）", async () => {
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const probe = await freshProbe();

        expect(() => probe.probeOnce({} as KernelLike, freshCtx())).not.toThrow();
        expect(h.logs).toEqual([]);
    });

    it("probeRuntime 抛错 → 日志留痕不抛出", async () => {
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const probeRuntime = vi.fn(() => {
            throw new Error("探测断言");
        });
        const kernel = { probeRuntime } as unknown as KernelLike;
        const probe = await freshProbe();

        expect(() => probe.probeOnce(kernel, freshCtx())).not.toThrow();
        expect(h.logs).toContain("bootstrap: probe error: 探测断言");
    });
});

describe("runProbePhase", () => {
    it("立即探测 + 35s 晚探测（napuketto-probe-late.json，定时器 unref）", async () => {
        vi.useFakeTimers();
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const probeRuntime = vi.fn((_ctx: CoreContextLike, filename?: string) => {
            h.probeCalls.push(filename);
            return { session: {}, services: { a: 1, b: 2 } };
        });
        const kernel = { probeRuntime } as unknown as KernelLike;
        const ctx = freshCtx();
        const probe = await freshProbe();

        const handles: NodeJS.Timeout[] = [];
        const originalSetTimeout = globalThis.setTimeout;
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
            callback: () => void,
            delay?: number,
        ) => {
            const handle = originalSetTimeout(callback, delay);
            handles.push(handle);
            return handle;
        }) as never);
        try {
            probe.runProbePhase(kernel, ctx);

            expect(h.probeCalls).toEqual([undefined]);
            expect(probeRuntime).toHaveBeenNthCalledWith(1, ctx);
            expect(handles).toHaveLength(1);
            // 晚探测定时器必须 unref（不阻塞进程自然退出）
            expect(handles[0]?.hasRef()).toBe(false);
        } finally {
            setTimeoutSpy.mockRestore();
        }

        await vi.advanceTimersByTimeAsync(34999);
        expect(h.probeCalls).toEqual([undefined]);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.probeCalls).toEqual([undefined, "napuketto-probe-late.json"]);
        expect(probeRuntime).toHaveBeenNthCalledWith(2, ctx, "napuketto-probe-late.json");
        expect(h.logs).toContain("bootstrap: probe-late done, session=ok, services=2");
    });

    it("probeRuntime 抛错 → 立即/晚探测都容错（不崩）", async () => {
        vi.useFakeTimers();
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const probeRuntime = vi.fn((_ctx: CoreContextLike, filename?: string) => {
            h.probeCalls.push(filename);
            throw new Error("探测断言");
        });
        const kernel = { probeRuntime } as unknown as KernelLike;
        const probe = await freshProbe();

        probe.runProbePhase(kernel, freshCtx());
        expect(h.probeCalls).toEqual([undefined]);

        await vi.advanceTimersByTimeAsync(35000);

        expect(h.probeCalls).toEqual([undefined, "napuketto-probe-late.json"]);
        expect(h.logs).toContain("bootstrap: probe error: 探测断言");
        expect(h.logs).toContain("bootstrap: probe-late error: 探测断言");
    });

    it("关停钩子清理晚探测定时器（不再触发探测）", async () => {
        vi.useFakeTimers();
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const probeRuntime = vi.fn((_ctx: CoreContextLike, filename?: string) => {
            h.probeCalls.push(filename);
            return { session: {}, services: {} };
        });
        const kernel = { probeRuntime } as unknown as KernelLike;
        const probe = await freshProbe();

        probe.runProbePhase(kernel, freshCtx());
        expect(vi.getTimerCount()).toBe(1);

        const shutdown = await import("../../../src/lifecycle/shutdown.js");
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            await shutdown.requestShutdown("单测关停");
        } finally {
            exitSpy.mockRestore();
        }

        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(35000);
        expect(h.probeCalls).toEqual([undefined]);
    });
});

describe("runListenerRecordingPhase", () => {
    it("kernel 缺录制器 → 告警（kernel 过旧）不崩", async () => {
        vi.stubEnv("NAPUKETTO_LISTENER_RECORD", "1");
        const probe = await freshProbe();

        expect(() => probe.runListenerRecordingPhase({} as KernelLike, freshCtx())).not.toThrow();
        expect(h.logs).toContain(
            "bootstrap: listener-record 请求但 kernel 缺 startListenerRecording（kernel 过旧）",
        );
    });

    it("部分注册失败 → 挂起计数 + 逐条失败日志（成功项不报错）", async () => {
        vi.stubEnv("NAPUKETTO_LISTENER_RECORD", "1");
        const startListenerRecording = vi.fn(() => ({
            file: "napuketto-listener-record.jsonl",
            // 服务名是 kernel 的原始 PascalCase 契约，用键值对构造避开命名规则
            registered: Object.fromEntries([
                ["Msg", { ok: true }],
                ["Group", { ok: false, error: "绑定失败" }],
                ["QZone", { ok: false }],
            ]),
        }));
        const kernel = { startListenerRecording } as unknown as KernelLike;
        const ctx = freshCtx();
        const probe = await freshProbe();

        probe.runListenerRecordingPhase(kernel, ctx);

        expect(startListenerRecording).toHaveBeenCalledWith(ctx);
        expect(h.logs).toContain(
            "bootstrap: listener-record 挂起 1/3 服务 → napuketto-listener-record.jsonl",
        );
        expect(h.logs).toContain("bootstrap: listener-record Group 未挂: 绑定失败");
        expect(h.logs).toContain("bootstrap: listener-record QZone 未挂: unknown");
        expect(h.logs.some((l) => l.startsWith("bootstrap: listener-record Msg 未挂"))).toBe(false);
    });

    it("录制器抛错 → 日志留痕不抛出", async () => {
        vi.stubEnv("NAPUKETTO_LISTENER_RECORD", "1");
        const kernel = {
            startListenerRecording: () => {
                throw new Error("录制断言");
            },
        } as unknown as KernelLike;
        const probe = await freshProbe();

        expect(() => probe.runListenerRecordingPhase(kernel, freshCtx())).not.toThrow();
        expect(h.logs).toContain("bootstrap: listener-record error: 录制断言");
    });
});

describe("runSmokeIfEnabled", () => {
    it("通过 → 调用冒烟（透传 kernel/ctx/loginResult）并记录通过日志", async () => {
        vi.stubEnv("NAPUKETTO_SMOKE", "1");
        h.smokeResult = true;
        const kernel = {} as KernelLike;
        const ctx = freshCtx();
        const probe = await freshProbe();

        await probe.runSmokeIfEnabled(kernel, ctx, LOGIN);

        expect(h.smokeCalls).toEqual([{ kernel, ctx, loginResult: LOGIN }]);
        expect(h.logs).toContain("bootstrap: 冒烟自检通过（见上文 smoke 日志）");
    });

    it("未通过 → 日志标注未完全通过", async () => {
        vi.stubEnv("NAPUKETTO_SMOKE", "1");
        h.smokeResult = false;
        const probe = await freshProbe();

        await probe.runSmokeIfEnabled({} as KernelLike, freshCtx(), LOGIN);

        expect(h.logs).toContain("bootstrap: 冒烟自检未完全通过（见上文 smoke 日志）");
    });

    it("runSmokeTest 抛错 → 日志留痕不抛出", async () => {
        vi.stubEnv("NAPUKETTO_SMOKE", "1");
        h.smokeError = new Error("冒烟断言");
        const probe = await freshProbe();

        await expect(
            probe.runSmokeIfEnabled({} as KernelLike, freshCtx(), LOGIN),
        ).resolves.toBeUndefined();
        expect(h.logs).toContain("bootstrap: 冒烟自检异常: 冒烟断言");
    });
});
