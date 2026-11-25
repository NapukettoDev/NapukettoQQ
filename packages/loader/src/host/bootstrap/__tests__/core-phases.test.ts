/**
 * core-phases.test.ts：bootstrapWithCore 主流程编排单测（P2 拆分后）。
 *
 * session 替换/激活/就绪直接单测见 session-activation.test.ts；探测/录制相位
 * 直接单测见 probe.test.ts。本文件只保留「主流程编排」：
 *  - NapukettoCore.create 选项折叠（[log] 段 + IPC consoleLog:false + dataRoot/账号路径）
 *  - 登录前置：QR_ONLY 一次性消费 / QR 透出（cli NAPUTO_QR 标记行、IPC sendQr）/
 *    pickLoginAccount 选中账号透传 quickUin
 *  - core.login 缺失 / 登录返回 null → failed(NOT_LOGIN) / kernel 无 NapukettoCore
 *  - startProtocols null → 引导失败
 *  - 关停期间不发布结果（协议装配挂起时收到关停请求）
 *  - 关停钩子顺序（先停协议，再清理 IPC 与服务）
 *  - listener 录制先于探测（时序硬约束，跨相位编排）
 *
 * vi.mock ipc 具体模块 + protocols + log-config；env 快照每用例独立
 * （stubEnv + resetModules + 动态 import）；假定时器隔离 session 探测与 35s 晚探测。
 */
// biome-ignore-all lint/style/useNamingConvention: 对象键名为 kernel/wrapper 导出面（PascalCase 类名），必须原样保留

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedState } from "../../runtime/state.js";
import type { KernelLike } from "../../runtime/types.js";

/** 跨 mock 共享记录（vi.hoisted）。 */
const h = vi.hoisted(() => {
    return {
        /** sendStatus 记录。 */
        statuses: [] as Array<{ phase: string; message?: string; error?: { code: string } }>,
        /** sendLogin / sendQr 记录。 */
        logins: [] as Array<{ state: string; selfInfo?: unknown }>,
        qrs: [] as Array<{ pngBase64: string; qrcodeUrl: string }>,
        /** stdout 捕获（cli QR 标记行断言）。 */
        stdout: [] as string[],
        /** attach 事件时序。 */
        events: [] as string[],
        /** startProtocols 返回值/抛出（null = 装配失败）。 */
        protocolResult: { ok: true } as unknown,
        /** startProtocols 挂起闸门（关停期用例）。 */
        protocolGate: null as Promise<void> | null,
        /** startProtocols 被调用通知（关停期用例）。 */
        onProtocolStart: null as null | (() => void),
        /** NapukettoCore.create 收到的选项。 */
        createOptions: [] as Record<string, unknown>[],
        /** core.login 收到的 opts。 */
        loginCalls: [] as Record<string, unknown>[],
    };
});

// IPC 层按具体模块替换（2026-11-25 P2 移除 host/ipc/index.ts barrel）。
vi.mock("../../ipc/attach.js", () => ({
    attachIpcServices: vi.fn(() => {
        h.events.push("attach:ipc-services");
        return () => {
            h.events.push("stop:ipc-services");
        };
    }),
    createIpcActionsForCore: vi.fn(() => new Map()),
}));

vi.mock("../../ipc/ob11-bridge.js", () => ({
    attachOb11IpcBridge: vi.fn(async () => {
        h.events.push("attach:ob11-bridge");
        return () => {
            h.events.push("stop:ob11-bridge");
        };
    }),
}));

vi.mock("../../ipc/sender.js", () => ({
    sendLogin: vi.fn((state: string, selfInfo?: unknown) => {
        h.logins.push({ state, ...(selfInfo !== undefined ? { selfInfo } : {}) });
    }),
    sendQr: vi.fn((pngBase64: string, qrcodeUrl: string) => {
        h.qrs.push({ pngBase64, qrcodeUrl });
    }),
    sendStatus: vi.fn(
        (phase: string, message?: string, error?: { code: string; message: string }) => {
            h.statuses.push({
                phase,
                ...(message !== undefined ? { message } : {}),
                ...(error !== undefined ? { error } : {}),
            });
        },
    ),
}));

vi.mock("../../ipc/server.js", () => ({
    startIpcServer: vi.fn(() => () => undefined),
}));

vi.mock("../../protocols/protocols.js", () => ({
    startProtocols: vi.fn(async (_kernel: unknown, _ctx: unknown, loginResult: { uin: string }) => {
        h.events.push(`startProtocols:${loginResult.uin}`);
        h.onProtocolStart?.();
        if (h.protocolGate !== null) {
            await h.protocolGate;
        }
        if (h.protocolResult === null) {
            return null;
        }
        if (h.protocolResult instanceof Error) {
            throw h.protocolResult;
        }
        // 默认产物（其余用例）；关停钩子用例注入带 dispose/stopAdapters 的产物
        return (
            (h.protocolResult as { dispose?: unknown }).dispose !== undefined
                ? h.protocolResult
                : { self: { uin: loginResult.uin, nickname: "" } }
        ) as never;
    }),
}));

vi.mock("../../runtime/log-config.js", () => ({
    resolveLoaderLogConfig: vi.fn(() => ({
        level: "info",
        banner: true,
        unboundReceive: true,
        levels: { kernel: "debug" },
        format: "json",
        timestamp: "iso",
        colorize: false,
        file: { path: "logs/x.log", level: "warn" },
    })),
    resolveLogFilePath: vi.fn((p: string) => `ABS/${p}`),
}));

let tmpRoot = "";
let restoreStdout: (() => void) | null = null;

beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-bcphases-test-"));
});

afterAll(() => {
    vi.useRealTimers();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

beforeEach(() => {
    h.statuses.length = 0;
    h.logins.length = 0;
    h.qrs.length = 0;
    h.stdout.length = 0;
    h.events.length = 0;
    h.protocolResult = { ok: true };
    h.protocolGate = null;
    h.onProtocolStart = null;
    h.createOptions.length = 0;
    h.loginCalls.length = 0;
    vi.unstubAllEnvs();
    // session 探测 interval / 35s 晚探测统一走假定时器（避免跨用例泄漏）
    vi.useFakeTimers();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        h.stdout.push(String(chunk));
        return true;
    });
    restoreStdout = () => {
        stdoutSpy.mockRestore();
    };
});

afterEach(() => {
    restoreStdout?.();
    restoreStdout = null;
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

/** 取全新 bootstrap/core 模块（env 快照隔离）。 */
async function freshModule(): Promise<typeof import("../core.js")> {
    vi.resetModules();
    return await import("../core.js");
}

/** 通用引导 env（IPC/自建宿主开关由用例覆盖）。 */
function stubBootEnv(): void {
    vi.stubEnv("NAPUKETTO_CFG_DIR", tmpRoot);
    vi.stubEnv("NAPUKETTO_QQ_VERSION", "9.9.9-Test");
    vi.stubEnv("NAPUKETTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
    vi.stubEnv("NAPUKETTO_IPC", "");
}

/** 假 core（NapukettoCore.create 产物；login 可编程）。 */
function fakeCore(loginResult: { uin: string; uid: string; nick?: string } | null | Error): {
    core: Record<string, unknown>;
    setSession: ReturnType<typeof vi.fn>;
} {
    const setSession = vi.fn();
    const core: Record<string, unknown> = {
        attachWrapper: () => ({
            engine: {},
            session: { getMsgService: () => null }, // 非 READY（激活路径可触达）
            loginService: {},
        }),
        setSession,
        login: (opts: Record<string, unknown>) => {
            h.loginCalls.push(opts);
            if (
                opts["onLoginProgress"] !== undefined &&
                loginResult !== null &&
                !(loginResult instanceof Error)
            ) {
                // QR 阶段回调（登录流程透出验证）
                (
                    opts["onLoginProgress"] as (p: {
                        state: string;
                        qr?: { pngBase64: string; qrcodeUrl: string };
                    }) => void
                )({
                    state: "waiting_scan",
                    qr: { pngBase64: "cG5n", qrcodeUrl: "https://qr/x" },
                });
            }
            if (loginResult instanceof Error) {
                return Promise.reject(loginResult);
            }
            return Promise.resolve(loginResult);
        },
    };
    return { core, setSession };
}

/** 假 kernel（NapukettoCore 路径 + 全量生命周期/探测面）。 */
function fakeKernel(
    core: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
): KernelLike {
    const box: Record<string, unknown> = {
        listLoginAccounts: () => Promise.resolve([]),
        buildSessionConfig: () => ({}),
        createLifecycleSessionListener: () => ({ listener: true }),
        initAndStartSession: () => Promise.resolve(),
        waitSessionReady: () => Promise.resolve(),
        resolveQqUserDataRoot: () => "qqroot",
        resolveQqGlobalPath: (root: string) => `${root}/global`,
        readMachineGuid: () => "",
        probeRuntime: (_ctx: unknown, filename?: string) => {
            h.events.push(filename === undefined ? "probe:immediate" : `probe:${filename}`);
            return { session: {}, services: {} };
        },
        startListenerRecording: () => {
            h.events.push("listener-record");
            return {
                file: "napuketto-listener-record.jsonl",
                registered: { Msg: { ok: true } },
            };
        },
    };
    box["NapukettoCore"] = {
        create: (options: Record<string, unknown>) => {
            h.createOptions.push(options);
            return core;
        },
    };
    return Object.assign(box, overrides) as unknown as KernelLike;
}

/** 引导输入状态。 */
function freshState(overrides: Partial<SharedState> = {}): SharedState {
    return {
        wrapperExports: null,
        qqSession: null,
        qqLoginService: null,
        bootstrapped: false,
        ...overrides,
    };
}

const BOOT_ENV = {
    qqVersion: "9.9.9-Test",
    dataDir: "数据目录",
    dataRoot: "",
    wrapperPath: "wrapper.node",
};
const LOGIN_RESULT = { uin: "10001", uid: "u1", nick: "甲" };

describe("NapukettoCore.create 选项折叠", () => {
    it("NAPUKETTO_DATA_ROOT 是账号目录父级 → paths 拆成数据根 + 账号名", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        const dataRoot = join("数据根", "napuketto");
        const bootEnv = { ...BOOT_ENV, dataDir: join(dataRoot, "10001"), dataRoot };
        await mod.bootstrapWithCore(kernel, freshState(), bootEnv, 537376818);
        expect(h.createOptions[0]?.["paths"]).toEqual({ dataRoot, account: "10001" });
    });

    it("[log] 段折叠进 create 选项；IPC 模式 consoleLog:false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_IPC", "1");
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        vi.stubEnv("NAPUKETTO_QUICK_UIN", "10001");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        const options = h.createOptions[0];
        expect(options).toMatchObject({
            paths: { dataRoot: "数据目录" },
            logLevel: "debug",
            logFormat: "json",
            logTimestamp: "iso",
            logColorize: false,
            logFile: "ABS/logs/x.log",
            logFileLevel: "warn",
            account: "10001",
            consoleLog: false,
        });
    });

    it("非 IPC 模式 → 不传 consoleLog（cli 控制台输出保留）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect("consoleLog" in (h.createOptions[0] as Record<string, unknown>)).toBe(false);
    });
});

describe("bootstrapWithCore：登录前置", () => {
    it("NAPUKETTO_QR_ONLY=1 → qrOnly:true 且不传 quickUin（一次性消费）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        vi.stubEnv("NAPUKETTO_QR_ONLY", "1");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        const opts = h.loginCalls[0];
        expect(opts?.["qrOnly"]).toBe(true);
        expect("quickUin" in (opts as Record<string, unknown>)).toBe(false);
        // 一次性标记：读取后删除，软重登/后续重试不再被残留标记强制扫码
        expect(process.env["NAPUKETTO_QR_ONLY"]).toBeUndefined();
    });

    it("登录回调 QR 阶段：非 IPC 模式 → stdout NAPUTO_QR 标记行（cli 终端渲染）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        const qrLine = h.stdout.find((c) => c.startsWith("NAPUTO_QR "));
        expect(qrLine).toBeDefined();
        expect(JSON.parse((qrLine as string).slice("NAPUTO_QR ".length))).toEqual({
            pngBase64: "cG5n",
            qrcodeUrl: "https://qr/x",
        });
    });

    it("登录回调 QR 阶段：IPC 模式 → sendQr（不写 stdout 标记行）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_IPC", "1");
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(h.qrs).toEqual([{ pngBase64: "cG5n", qrcodeUrl: "https://qr/x" }]);
        expect(h.stdout.some((c) => c.startsWith("NAPUTO_QR "))).toBe(false);
    });

    it("pickLoginAccount 自动选中可快速登录账号 → 透传 quickUin", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const listLoginAccounts = vi.fn(() =>
            Promise.resolve([
                { uin: "10001", nickName: "甲", isQuickLogin: true },
                { uin: "20002", nickName: "乙", isQuickLogin: false },
            ]),
        );
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core, {
            listLoginAccounts,
        });
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(listLoginAccounts).toHaveBeenCalledTimes(1);
        expect(h.loginCalls[0]?.["quickUin"]).toBe("10001");
    });
});

describe("bootstrapWithCore：引导失败分支", () => {
    it("startProtocols null（服务未装配）→ 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        h.protocolResult = null;
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
        expect(h.events).toEqual(["startProtocols:10001"]);
    });

    it("core.login 缺失（kernel core 不完整）→ 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const core: Record<string, unknown> = {
            attachWrapper: () => ({ session: null, engine: {} }),
        };
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
    });

    it("doLogin null（登录失败）→ failed(NOT_LOGIN) + 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_IPC", "1");
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const kernel = fakeKernel(fakeCore(null).core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
        expect(h.statuses.at(-1)).toMatchObject({ phase: "failed", error: { code: "NOT_LOGIN" } });
    });

    it("kernel 无 NapukettoCore（非 fallback 入口）→ 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const kernel = fakeKernel({});
        delete (kernel as unknown as Record<string, unknown>)["NapukettoCore"];
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
        expect(h.createOptions).toHaveLength(0);
    });
});

describe("bootstrapWithCore：关停编排", () => {
    it("关停请求发生在协议装配期间 → 不发布 ready、清理新服务并返回 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_IPC", "1");
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const dispose = vi.fn(() => h.events.push("dispose:services"));
        const stopAdapters = vi.fn(async () => h.events.push("stop:adapters"));
        h.protocolResult = { dispose, stopAdapters };
        let releaseProtocols!: () => void;
        h.protocolGate = new Promise<void>((resolve) => {
            releaseProtocols = resolve;
        });
        const protocolStarted = new Promise<void>((resolve) => {
            h.onProtocolStart = resolve;
        });
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();

        const pending = mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        await protocolStarted;
        const shutdown = await import("../../../lifecycle/shutdown.js");
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            await shutdown.requestShutdown("单测关停");
        } finally {
            exitSpy.mockRestore();
        }
        releaseProtocols();

        expect(await pending).toBe(false);
        expect(h.statuses.map((s) => s.phase)).toEqual(["logging", "sessioning"]);
        expect(h.events).toEqual(["startProtocols:10001", "stop:adapters", "dispose:services"]);
    });

    it("关停钩子注册：requestShutdown 先停协议，再清理 IPC 和服务", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_IPC", "1");
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        // 装配产物带清理探针（bootstrap/core 把它们注册进关停钩子）
        const dispose = vi.fn(() => h.events.push("dispose:services"));
        const stopAdapters = vi.fn(async () => h.events.push("stop:adapters"));
        h.protocolResult = { dispose, stopAdapters };
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(true);
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            const shutdown = await import("../../../lifecycle/shutdown.js");
            await shutdown.requestShutdown("单测关停");
            // 逆序执行：stopAdapters → IPC 面 + OB11 桥（同一钩子内先 IPC 后 OB11）→ services.dispose
            expect(h.events.slice(h.events.indexOf("startProtocols:10001"))).toEqual([
                "startProtocols:10001",
                "attach:ipc-services",
                "attach:ob11-bridge",
                "stop:ob11-bridge",
                "stop:adapters",
                "stop:ipc-services",
                "dispose:services",
            ]);
            expect(exitSpy).toHaveBeenCalledWith(0);
        } finally {
            exitSpy.mockRestore();
        }
    });
});

describe("bootstrapWithCore：探测与录制相位编排", () => {
    it("listener 录制先于探测（时序硬约束）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        vi.stubEnv("NAPUKETTO_LISTENER_RECORD", "1");
        vi.stubEnv("NAPUKETTO_PROBE", "1");
        const kernel = fakeKernel(fakeCore(LOGIN_RESULT).core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(true);
        expect(h.events.filter((e) => e === "listener-record" || e.startsWith("probe:"))).toEqual([
            "listener-record",
            "probe:immediate",
        ]);
    });
});
