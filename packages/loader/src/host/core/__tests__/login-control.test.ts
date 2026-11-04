/**
 * login-control.test.ts：control login 相位分派单测（2026-09-08 A1/A2，relogin.ts）。
 *
 * LoginControl：相位机迁移（login-race → assembling → ready / aborted）、
 * 竞速抢占口取用、control login 互斥。
 * createLoginControlHandler：qr/uin 参数展开、登录期抢占（接管竞速）、
 * A1 迟到成功抑制（assembling/aborted 不发 logged_in）、ready 态软重登
 * （reassemble 调用 + ready/logged_in 重播 + 失败处理注入）、在途互斥。
 *
 * wire 断言：enableIpc() 后 sendLogin/sendStatus 经 process.stdout 写 JSON 行，
 * spy stdout 捕获解析（测真实协议路径，不经注入桩）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableIpc } from "../../ipc/index.js";
import type { CoreLike, LoginResultLike } from "../../types.js";
import { createLoginControlHandler, LoginControl, type LoginPreemptRef } from "../relogin.js";

enableIpc();

/** stdout 捕获（sendIpc JSON 行；mockImplementation 吞掉输出防刷屏）。 */
function captureStdout(): { lines(): string[]; restore(): void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        chunks.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
    });
    return {
        lines: () => chunks,
        restore: () => {
            spy.mockRestore();
        },
    };
}

/** 解析捕获的 IPC login 消息 payload。 */
function loginPayloads(lines: string[]): Array<{ state: string; selfInfo?: unknown }> {
    const payloads: Array<{ state: string; selfInfo?: unknown }> = [];
    for (const line of lines) {
        try {
            const msg = JSON.parse(line) as { type?: string; payload?: unknown };
            if (msg.type === "login") {
                payloads.push(msg.payload as { state: string; selfInfo?: unknown });
            }
        } catch {
            // 非 JSON 行忽略（测试环境理论上没有）
        }
    }
    return payloads;
}

/** 解析捕获的 IPC status 消息 phase。 */
function statusPhases(lines: string[]): string[] {
    const phases: string[] = [];
    for (const line of lines) {
        try {
            const msg = JSON.parse(line) as { type?: string; payload?: { phase?: string } };
            if (msg.type === "status" && msg.payload?.phase !== undefined) {
                phases.push(msg.payload.phase);
            }
        } catch {
            // 非 JSON 行忽略
        }
    }
    return phases;
}

/** 桩 core：login 受控 resolve（延迟 settle，测互斥/时序）。 */
function makeDeferredCore(): {
    core: CoreLike;
    loginCalls: Record<string, unknown>[];
    settle: (result: LoginResultLike | null) => void;
} {
    const loginCalls: Record<string, unknown>[] = [];
    let pending: ((result: LoginResultLike | null) => void) | null = null;
    const core = {
        login: (opts: Record<string, unknown>) => {
            loginCalls.push(opts);
            return new Promise<LoginResultLike | null>((resolve) => {
                pending = resolve;
            });
        },
    } as unknown as CoreLike;
    return {
        core,
        loginCalls,
        settle: (result) => {
            pending?.(result);
        },
    };
}

const RESULT: LoginResultLike = { uin: "10001", uid: "u1", nick: "测试" };
const RESULT2: LoginResultLike = { uin: "20002", uid: "u2", nick: "测试2" };

afterEach(() => {
    vi.restoreAllMocks();
});

describe("LoginControl 相位机", () => {
    /** 占位 resolve（不消费结果；takePreempt 测试只验证取走与清口）。 */
    const noopResolve = (): void => {
        // 占位不消费
    };

    it("takePreempt 取走竞速口（一次性），beginAssembly 后返回 null", () => {
        const preempt: LoginPreemptRef = { resolve: noopResolve };
        const control = new LoginControl(preempt);
        expect(control.currentPhase).toBe("login-race");
        const resolve = control.takePreempt();
        expect(resolve).toBeTypeOf("function");
        expect(preempt.resolve).toBeNull();
        expect(control.takePreempt()).toBeNull();

        const preempt2: LoginPreemptRef = { resolve: noopResolve };
        const control2 = new LoginControl(preempt2);
        control2.beginAssembly();
        expect(control2.currentPhase).toBe("assembling");
        expect(preempt2.resolve).toBeNull();
        expect(control2.takePreempt()).toBeNull();
    });

    it("markReady/abort 相位迁移；abort 关竞速口", () => {
        const preempt: LoginPreemptRef = { resolve: noopResolve };
        const control = new LoginControl(preempt);
        control.markReady();
        expect(control.currentPhase).toBe("ready");
        control.abort();
        expect(control.currentPhase).toBe("aborted");
        expect(preempt.resolve).toBeNull();
    });

    it("claim/release 互斥：在途时二次 claim 失败", () => {
        const control = new LoginControl({ resolve: null });
        expect(control.claim()).toBe(true);
        expect(control.claim()).toBe(false);
        control.release();
        expect(control.claim()).toBe(true);
    });
});

describe("createLoginControlHandler", () => {
    it("qr=true → qrOnly:true；uin → quickUin；qrFallback 常开", async () => {
        const { core, loginCalls, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(
            core,
            "537376818",
            new LoginControl({ resolve: null }),
            {
                reassemble: () => Promise.resolve(true),
            },
        );
        handler({ uin: "10001", qr: true });
        await vi.waitFor(() => {
            expect(loginCalls).toHaveLength(1);
        });
        const opts = loginCalls[0];
        expect(opts).toBeDefined();
        expect(opts?.["qrOnly"]).toBe(true);
        expect(opts?.["quickUin"]).toBe("10001");
        expect(opts?.["qrFallback"]).toBe(true);
        expect(opts?.["appid"]).toBe("537376818");
        settle(null); // 收尾（不产生额外断言）
    });

    it("登录期抢占：竞速中被接管（wire 上报 logged_in + preempt resolve）", async () => {
        const cap = captureStdout();
        const preemptResolve = vi.fn();
        const control = new LoginControl({ resolve: preemptResolve });
        const { core, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, control, {
            reassemble: () => Promise.resolve(true),
        });
        handler({});
        settle(RESULT);
        await vi.waitFor(() => {
            expect(preemptResolve).toHaveBeenCalledWith(RESULT);
        });
        const logins = loginPayloads(cap.lines());
        expect(logins).toHaveLength(1);
        expect(logins[0]?.state).toBe("logged_in");
        expect(logins[0]?.selfInfo).toEqual({ uin: "10001", uid: "u1", nick: "测试" });
        cap.restore();
    });

    it("A1：初始登录失败后（aborted）迟到的 control login 成功不再发 logged_in", async () => {
        const cap = captureStdout();
        const preempt: LoginPreemptRef = { resolve: null };
        const control = new LoginControl(preempt);
        control.beginAssembly();
        control.abort(); // bootstrap 失败路径（doLogin null → 进程将退出）
        const reassemble = vi.fn(() => Promise.resolve(true));
        const { core, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, control, { reassemble });
        handler({});
        settle(RESULT);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(loginPayloads(cap.lines()).filter((l) => l.state === "logged_in")).toHaveLength(0);
        expect(reassemble).not.toHaveBeenCalled();
        cap.restore();
    });

    it("A1：装配进行中（assembling）的 control login 成功同样抑制", async () => {
        const cap = captureStdout();
        const control = new LoginControl({ resolve: null });
        control.beginAssembly(); // 竞速已结束、装配链运行中
        const reassemble = vi.fn(() => Promise.resolve(true));
        const { core, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, control, { reassemble });
        handler({});
        settle(RESULT);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(loginPayloads(cap.lines()).filter((l) => l.state === "logged_in")).toHaveLength(0);
        expect(reassemble).not.toHaveBeenCalled();
        cap.restore();
    });

    it("无抢占失败不回归：core.login 返回 null → 发 failed", async () => {
        const cap = captureStdout();
        const { core, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, new LoginControl({ resolve: null }), {
            reassemble: () => Promise.resolve(true),
        });
        handler({});
        settle(null);
        await vi.waitFor(() => {
            expect(loginPayloads(cap.lines())).toEqual([
                { state: "failed", message: "登录返回空结果" },
            ]);
        });
        cap.restore();
    });

    it("core.login 抛错 → 发 failed，不冒泡不触发 reassemble", async () => {
        const cap = captureStdout();
        const core = {
            login: () => Promise.reject(new Error("boom")),
        } as unknown as CoreLike;
        const reassemble = vi.fn(() => Promise.resolve(true));
        const handler = createLoginControlHandler(core, 1, new LoginControl({ resolve: null }), {
            reassemble,
        });
        expect(() => handler({})).not.toThrow();
        await vi.waitFor(() => {
            expect(loginPayloads(cap.lines())).toHaveLength(1);
        });
        expect(loginPayloads(cap.lines())[0]?.state).toBe("failed");
        expect(reassemble).not.toHaveBeenCalled();
        cap.restore();
    });

    it("ready 软重登：reassemble 用新结果调用，成功后重播 ready + logged_in", async () => {
        const cap = captureStdout();
        const control = new LoginControl({ resolve: null });
        control.beginAssembly();
        control.markReady();
        const reassemble = vi.fn((_r: LoginResultLike) => Promise.resolve(true));
        const { core, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, control, { reassemble });
        handler({});
        settle(RESULT2);
        await vi.waitFor(() => {
            expect(reassemble).toHaveBeenCalledWith(RESULT2);
        });
        await vi.waitFor(() => {
            expect(statusPhases(cap.lines())).toContain("ready");
        });
        const logins = loginPayloads(cap.lines());
        expect(logins).toEqual([
            { state: "logged_in", selfInfo: { uin: "20002", uid: "u2", nick: "测试2" } },
        ]);
        cap.restore();
    });

    it("ready 软重登失败：调用注入的失败处理（不走默认 process.exit）", async () => {
        const control = new LoginControl({ resolve: null });
        control.beginAssembly();
        control.markReady();
        const onReassembleFailed = vi.fn();
        const { core, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, control, {
            reassemble: () => Promise.resolve(false),
            onReassembleFailed,
        });
        handler({});
        settle(RESULT2);
        await vi.waitFor(() => {
            expect(onReassembleFailed).toHaveBeenCalledTimes(1);
        });
    });

    it("在途互斥：control login 未 settle 时的新指令被忽略", async () => {
        const cap = captureStdout();
        const { core, loginCalls, settle } = makeDeferredCore();
        const handler = createLoginControlHandler(core, 1, new LoginControl({ resolve: null }), {
            reassemble: () => Promise.resolve(true),
        });
        handler({});
        handler({});
        handler({});
        expect(loginCalls).toHaveLength(1);
        settle(null);
        // 首次 login 的 failed 上 wire（.then 已跑）+ 一拍（.finally 释放互斥）
        await vi.waitFor(() => {
            expect(loginPayloads(cap.lines())).toHaveLength(1);
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        // 互斥已释放：新指令可入
        handler({});
        await vi.waitFor(() => {
            expect(loginCalls).toHaveLength(2);
        });
        cap.restore();
    });

    it("onLoginProgress：QR 数据上 wire（sendQr）；登录态合法才发 login 消息", async () => {
        const cap = captureStdout();
        type ProgressFn = (p: {
            state: string;
            qr?: { pngBase64: string; qrcodeUrl: string };
        }) => void;
        const progressHolder: { fn: ProgressFn | null } = { fn: null };
        const core = {
            login: (opts: Record<string, unknown>) => {
                progressHolder.fn = opts["onLoginProgress"] as ProgressFn;
                return new Promise<LoginResultLike | null>(() => {
                    // 不 settle（挂起中，QR 推送持续）
                });
            },
        } as unknown as CoreLike;
        const handler = createLoginControlHandler(core, 1, new LoginControl({ resolve: null }), {
            reassemble: () => Promise.resolve(true),
        });
        handler({});
        progressHolder.fn?.({
            state: "waiting_scan",
            qr: { pngBase64: "cG5n", qrcodeUrl: "https://qr/x" },
        });
        progressHolder.fn?.({ state: "bogus_state" }); // 非法登录态 → 不发 login 消息
        await new Promise((resolve) => setTimeout(resolve, 10));
        const all = cap
            .lines()
            .map((l) => JSON.parse(l) as Record<string, unknown>)
            .filter(Boolean);
        expect(all.some((m) => m["type"] === "qr")).toBe(true);
        // waiting_scan 合法登录态上 wire；bogus_state 被过滤（仅一条 login）
        expect(loginPayloads(cap.lines())).toEqual([{ state: "waiting_scan" }]);
        cap.restore();
    });

    it("ready 软重登失败且未注入失败处理 → 默认上报 failed + process.exit(1)", async () => {
        const cap = captureStdout();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            const control = new LoginControl({ resolve: null });
            control.beginAssembly();
            control.markReady();
            const { core, settle } = makeDeferredCore();
            const handler = createLoginControlHandler(core, 1, control, {
                reassemble: () => Promise.resolve(false),
                // 无 onReassembleFailed → defaultReassembleFailed
            });
            handler({});
            settle(RESULT2);
            await vi.waitFor(() => {
                expect(exitSpy).toHaveBeenCalledWith(1);
            });
            const statuses = cap
                .lines()
                .map((l) => JSON.parse(l) as { type?: string; payload?: { phase?: string } })
                .filter((m) => m["type"] === "status");
            expect(statuses.at(-1)?.payload).toMatchObject({ phase: "failed" });
        } finally {
            exitSpy.mockRestore();
            cap.restore();
        }
    });
});
