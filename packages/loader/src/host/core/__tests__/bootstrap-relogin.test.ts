/**
 * bootstrap-relogin.test.ts：bootstrapWithCore 软重登重装配集成单测（2026-09-08 A2）。
 *
 * vi.mock IPC 层（捕获 startIpcServer 的 onLogin handler + 记录 sendStatus/
 * sendLogin）与 protocols（startProtocols 返回带 dispose 探针的假服务）。
 * 假 kernel 直接传参（bootstrapWithCore 以参数接收 kernel，无需 .mjs 文件）；
 * 全文件不 resetModules——env 快照在 beforeAll stubEnv 后首次动态 import 时
 * 固定（NAPUTO_IPC=1 / NAPUTO_SELF_HOST=1），mock 实例全程同一份。
 *
 * 断言：
 *  - 初次引导：logging → logged_in → sessioning → startProtocols → attach
 *    （IPC 服务 + OB11 桥），返回 true。
 *  - ready 态 control login（A2 软重登）：清理顺序 ob11 桥 → IPC 服务 →
 *    services.dispose → 重装配（startProtocols 新结果 → attach ×2）→
 *    重播 sessioning/ready + logged_in（新 selfInfo）。
 *  - A1：登录失败（aborted）后迟到的 control login 成功——不发 logged_in、
 *    不触发重装配。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcActionHandler } from "../../ipc/ipc-actions.js";
import { decodeIpcMessage } from "../../ipc/ipc-codec.js";
import type { KernelLike } from "../../types.js";
import type { SharedState } from "../../util.js";
import type { KernelServices } from "../kernel-services.js";

/** 跨 mock 共享的记录器（vi.hoisted：工厂在 import 前执行）。 */
const h = vi.hoisted(() => {
    return {
        /** 装配/清理事件时序（断言顺序用）。 */
        events: [] as string[],
        lines: [] as string[],
        actions: new Map<string, IpcActionHandler>(),
        onEvent: null as null | ((event: string, ...args: unknown[]) => void),
        /** sendStatus 记录（phase + message）。 */
        statuses: [] as Array<{ phase: string; message?: string }>,
        /** sendLogin 记录（state + selfInfo + message）。 */
        logins: [] as Array<{ state: string; selfInfo?: unknown; message?: string }>,
        /** startIpcServer 捕获的 onLogin handler（control login 注入口）。 */
        onLogin: null as null | ((payload: { uin?: string; qr?: boolean }) => void),
    };
});

vi.mock("../../ipc/index.js", async () => {
    const sender = await import("../../ipc/ipc-sender.js");
    const ipcBootstrap = await import("../../ipc/ipc-bootstrap.js");
    return {
        ...sender,
        attachIpcServices: vi.fn(
            (actions: Map<string, IpcActionHandler>, services: KernelServices) => {
                h.events.push("attach:ipc-services");
                const stop = ipcBootstrap.attachIpcServices(actions, services);
                return () => {
                    h.events.push("stop:ipc-services");
                    stop();
                };
            },
        ),
        attachOb11IpcBridge: vi.fn(async (actions: Map<string, IpcActionHandler>) => {
            h.events.push("attach:ob11-bridge");
            await Promise.resolve();
            h.onEvent?.("Msg/onRecvMsg", "装配中");
            actions.set("get_login_info", async () => undefined);
            sender.sendEvent("ob11", "message", ["装配中"]);
            return () => {
                h.events.push("stop:ob11-bridge");
                actions.delete("get_login_info");
            };
        }),
        createIpcActionsForCore: vi.fn(() => h.actions),
        sendLogin: vi.fn((state: string, selfInfo?: unknown, message?: string) => {
            h.logins.push({
                state,
                ...(selfInfo !== undefined ? { selfInfo } : {}),
                ...(message !== undefined ? { message } : {}),
            });
        }),
        sendStatus: vi.fn((...args: Parameters<typeof sender.sendStatus>) => {
            const [phase, message] = args;
            h.statuses.push({ phase, ...(message !== undefined ? { message } : {}) });
            sender.sendStatus(...args);
        }),
        startIpcServer: vi.fn(
            (options: {
                actions: Map<string, IpcActionHandler>;
                onLogin?: (payload: { uin?: string; qr?: boolean }) => void;
            }) => {
                h.actions = options.actions;
                h.onLogin = options.onLogin ?? null;
                return () => undefined;
            },
        ),
    };
});

vi.mock("../protocols.js", () => ({
    startProtocols: vi.fn(async (_kernel: unknown, _ctx: unknown, loginResult: { uin: string }) => {
        h.events.push(`startProtocols:${loginResult.uin}`);
        return {
            kernel: {},
            ctx: {},
            logger: {},
            channel: {
                onAny: (handler: NonNullable<typeof h.onEvent>) => {
                    h.onEvent = handler;
                    return () => {
                        // 模拟清理期间旧服务最后一次回调。
                        handler("Msg/onRecvMsg", "清理中");
                        h.onEvent = null;
                    };
                },
            },
            groupChannel: {},
            friendChannel: {},
            msgApi: {},
            groupApi: {},
            friendApi: {},
            groupCache: {},
            groupNotifyApi: {},
            ticketApi: {},
            richMediaApi: {},
            recentContactApi: {},
            profileApi: {},
            profileLikeApi: {},
            webApi: {},
            self: { uin: loginResult.uin, nickname: "" },
            session: {},
            engine: {},
            util: {},
            dispose: () => {
                h.events.push("dispose:services");
            },
        } as unknown as KernelServices;
    }),
}));

/** 动态加载的被测模块（beforeAll stubEnv 之后首次 import，env 快照正确）。 */
let bootstrapCore: typeof import("../bootstrap-core.js");
let ipc: typeof import("../../ipc/index.js");
let tmpRoot = "";

/** 假 kernel：NapukettoCore 路径 + 登录结果队列（逐次出队，空队列 → null）。 */
function fakeKernel(loginResults: LoginResultBox[]): KernelLike {
    const core = {
        attachWrapper: () => ({
            engine: {},
            session: { getMsgService: () => ({}) },
            loginService: {},
        }),
        login: () => {
            const result = loginResults.shift() ?? null;
            return Promise.resolve(result);
        },
        setSession: () => {
            // 假 kernel 无需替换（self-host 路径不触达）
        },
        refreshQr: () => false,
    };
    // NapukettoCore 是 kernel 导出的类名（PascalCase），对象字面量直写会被
    // useNamingConvention 拦——bracket 赋值绕开字面量成员命名检查
    const kernelBox: Record<string, unknown> = {
        listLoginAccounts: () => Promise.resolve([]),
        buildSessionConfig: () => ({}),
        createLifecycleSessionListener: () => ({}),
        initAndStartSession: () => Promise.resolve(),
        waitSessionReady: () => Promise.resolve(),
    };
    kernelBox["NapukettoCore"] = { create: () => core };
    return kernelBox as unknown as KernelLike;
}

type LoginResultBox = { uin: string; uid: string; nick?: string } | null;

/** 引导输入状态（wrapper 未 dlopen、无 QQ 捕获实例）。 */
function freshState(): SharedState {
    return { wrapperExports: null, qqSession: null, qqLoginService: null, bootstrapped: false };
}

beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-relogin-test-"));
    vi.stubEnv("NAPUTO_CFG_DIR", tmpRoot);
    vi.stubEnv("NAPUTO_IPC", "1");
    vi.stubEnv("NAPUTO_SELF_HOST", "1");
    vi.stubEnv("NAPUTO_QQ_VERSION", "9.9.9-Test");
    vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
    vi.useFakeTimers(); // startSessionProbe 起 5s interval / 60s timeout，假定时器隔离
    bootstrapCore = await import("../bootstrap-core.js");
    ipc = await import("../../ipc/index.js");
});

beforeEach(() => {
    h.events.length = 0;
    h.statuses.length = 0;
    h.logins.length = 0;
    h.lines.length = 0;
    h.actions.clear();
    h.onEvent = null;
    h.onLogin = null;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        h.lines.push(String(chunk));
        return true;
    });
    ipc.enableIpc();
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

afterAll(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

const BOOT_ENV = {
    qqVersion: "9.9.9-Test",
    dataDir: "测试数据目录",
    dataRoot: "",
    wrapperPath: "wrapper.node",
};

describe("bootstrapWithCore 软重登重装配（A2）", () => {
    it("初次引导装配链 + ready 态 control login → 清理旧装配 → 重装配 → 重播 ready", async () => {
        // 第 1 次 = 初始 doLogin；第 2 次 = control login（软重登）
        const kernel = fakeKernel([
            { uin: "10001", uid: "u1", nick: "甲" },
            { uin: "20002", uid: "u2", nick: "乙" },
        ]);
        const ok = await bootstrapCore.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        // 初次装配链：协议服务 → IPC 服务 → OB11 桥（顺序）
        expect(h.events).toEqual([
            "startProtocols:10001",
            "attach:ipc-services",
            "attach:ob11-bridge",
        ]);
        // 状态/登录推送：logging → logged_in(初始结果) → sessioning
        expect(h.statuses.map((s) => s.phase)).toEqual(["logging", "sessioning", "ready"]);
        expect(h.lines.map(decodeIpcMessage).map((message) => message?.type)).toEqual([
            "status",
            "status",
            "status",
        ]);
        expect(h.actions.has("msg.sendMessage")).toBe(true);
        expect(h.actions.has("get_login_info")).toBe(true);
        h.onEvent?.("Msg/onRecvMsg", "初次就绪");
        expect(h.logins).toEqual([
            { state: "logged_in", selfInfo: { uin: "10001", uid: "u1", nick: "甲" } },
        ]);
        expect(h.onLogin).toBeTypeOf("function");

        // ready 态 control login（A2 软重登）
        h.onLogin?.({ uin: "20002" });
        await vi.waitFor(() => {
            expect(h.statuses.filter((status) => status.phase === "ready")).toHaveLength(2);
        });
        // 清理顺序：OB11 桥 → IPC 服务 → kernel 服务 dispose，再重装配
        expect(h.events.slice(3)).toEqual([
            "stop:ob11-bridge",
            "stop:ipc-services",
            "dispose:services",
            "startProtocols:20002",
            "attach:ipc-services",
            "attach:ob11-bridge",
        ]);
        // 状态重播：sessioning（重装配中）→ ready；logged_in 携带新 selfInfo
        expect(h.statuses.map((s) => s.phase)).toEqual([
            "logging",
            "sessioning",
            "ready",
            "sessioning",
            "ready",
        ]);
        h.onEvent?.("Msg/onRecvMsg", "重登就绪");
        ipc.sendEvent("ob11", "message", ["重登就绪"]);
        expect(h.lines.map(decodeIpcMessage)).toMatchObject([
            { type: "status", payload: { phase: "logging" } },
            { type: "status", payload: { phase: "sessioning" } },
            { type: "status", payload: { phase: "ready", selfInfo: { uin: "10001", uid: "u1" } } },
            { type: "event", payload: { service: "Msg", args: ["初次就绪"] } },
            { type: "status", payload: { phase: "sessioning" } },
            { type: "status", payload: { phase: "ready", selfInfo: { uin: "20002", uid: "u2" } } },
            { type: "event", payload: { service: "Msg", args: ["重登就绪"] } },
            { type: "event", payload: { service: "ob11", args: ["重登就绪"] } },
        ]);
        expect(h.logins).toEqual([
            { state: "logged_in", selfInfo: { uin: "10001", uid: "u1", nick: "甲" } },
            { state: "logged_in", selfInfo: { uin: "20002", uid: "u2", nick: "乙" } },
        ]);
    });

    it("A1：初始登录失败（aborted）后迟到的 control login 成功——不发 logged_in、不重装配", async () => {
        // 第 1 次 = 初始 doLogin 失败（null）；第 2 次 = 迟到的 control login 成功
        const kernel = fakeKernel([null, { uin: "20002", uid: "u2", nick: "乙" }]);
        const ok = await bootstrapCore.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(false);
        expect(h.statuses.map((s) => s.phase)).toEqual(["logging", "failed"]);
        expect(h.events).toEqual([]); // 失败路径未触达协议装配

        // 失败后迟到的 control login 成功（进程将退出前的在途请求）
        h.onLogin?.({});
        // 假定时器下推进：微任务（core.login resolve + then 链）+ 定时器一并放行
        await vi.advanceTimersByTimeAsync(50);
        // 不误发 logged_in（failed → logged_in 误导序列）；不触发重装配
        expect(h.logins.filter((l) => l.state === "logged_in")).toHaveLength(0);
        expect(h.events).toEqual([]);
    });

    it("在途互斥：control login 进行中重复指令被忽略（core.login 不重入）", async () => {
        const kernel = fakeKernel([{ uin: "10001", uid: "u1", nick: "甲" }]);
        const ok = await bootstrapCore.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        // 队列已空 → core.login 恒 null（首次 control login 在途挂起等 settle）
        h.onLogin?.({});
        h.onLogin?.({ qr: true });
        h.onLogin?.({ uin: "30003" });
        await vi.advanceTimersByTimeAsync(50);
        // 第二/三次指令被互斥忽略——首次 login(null) 只发一条 failed
        expect(h.logins).toEqual([
            { state: "logged_in", selfInfo: { uin: "10001", uid: "u1", nick: "甲" } },
            { state: "failed", message: "登录返回空结果" },
        ]);
        // 互斥释放后再来一条：可入（claim/release 语义不卡死）
        h.onLogin?.({});
        await vi.advanceTimersByTimeAsync(50);
        expect(h.logins).toHaveLength(3);
        expect(h.logins[2]).toEqual({ state: "failed", message: "登录返回空结果" });
    });
});
