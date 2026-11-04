/**
 * bootstrap-core-phases.test.ts：bootstrapWithCore 分相位/分支单测
 * （bootstrap-core.ts 装配链尾部：session 替换/激活/就绪/探测/录制/退出码前置）。
 *
 * 与 bootstrap-relogin.test.ts（软重登时序）互补：本文件覆盖
 *  - replaceSession：非自建宿主候选替换 / 同 session / 无候选 / 自建宿主恒 null
 *  - activateSession：先 init 后 start（buildSessionConfig 参数含 QQ global 目录与
 *    machineGuid）/ init 失败容错
 *  - waitSessionReady 失败容错；startProtocols null → 引导失败
 *  - 探测相位（NAPUTO_PROBE=1 立即 + 35s 晚探测）与 listener 录制相位
 *  - NapukettoCore.create 选项折叠（[log] 段 + IPC consoleLog:false）
 *  - 登录前置：NAPUTO_QR_ONLY 强制扫码 / 登录回调 QR 透出（cli NAPUTO_QR 标记行、
 *    IPC sendQr）/ core.login 缺失 / 登录失败 → failed(NOT_LOGIN)
 *
 * vi.mock ipc/index + protocols + log-cfg（bootstrap-relogin.test.ts 同套路）；
 * env 快照每用例独立（stubEnv + resetModules + 动态 import）；假定时器隔离
 * startSessionProbe 与 35s 晚探测。
 */
// biome-ignore-all lint/style/useNamingConvention: 对象键名为 kernel/wrapper 导出面（PascalCase 类名），必须原样保留

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelLike } from "../../types.js";
import type { SharedState } from "../../util.js";

/** 跨 mock 共享记录（vi.hoisted）。 */
const h = vi.hoisted(() => {
    return {
        /** sendStatus 记录。 */
        statuses: [] as Array<{ phase: string; message?: string; error?: { code: string } }>,
        /** sendLogin / sendQr 记录。 */
        logins: [] as Array<{ state: string; selfInfo?: unknown }>,
        qrs: [] as Array<{ pngBase64: string; qrcodeUrl: string }>,
        /** startIpcServer 捕获的 onLogin。 */
        onLogin: null as null | ((payload: { uin?: string; qr?: boolean }) => void),
        /** attach 事件时序。 */
        events: [] as string[],
        /** startProtocols 返回值/抛出（null = 装配失败）。 */
        protocolResult: { ok: true } as unknown,
        /** NapukettoCore.create 收到的选项。 */
        createOptions: [] as Record<string, unknown>[],
        /** core.login 收到的 opts。 */
        loginCalls: [] as Record<string, unknown>[],
        /** core.setSession 调用。 */
        setSessionCalls: [] as unknown[],
        /** buildSessionConfig 收到的参数。 */
        sessionConfigArgs: [] as Record<string, unknown>[],
        /** initAndStartSession 调用（config 引用透传）。 */
        initCalls: [] as Array<{ config: unknown; timeoutMs: number }>,
        /** probeRuntime 调用（filename 参数）。 */
        probeCalls: [] as Array<string | undefined>,
        /** startListenerRecording 调用计数。 */
        listenerRecordCalls: 0,
    };
});

vi.mock("../../ipc/index.js", () => ({
    attachIpcServices: vi.fn(() => {
        h.events.push("attach:ipc-services");
        return () => {
            h.events.push("stop:ipc-services");
        };
    }),
    attachOb11IpcBridge: vi.fn(async () => {
        h.events.push("attach:ob11-bridge");
        return () => {
            h.events.push("stop:ob11-bridge");
        };
    }),
    createIpcActionsForCore: vi.fn(() => new Map()),
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
    startIpcServer: vi.fn(
        (options: { onLogin?: (payload: { uin?: string; qr?: boolean }) => void }) => {
            h.onLogin = options.onLogin ?? null;
            return () => undefined;
        },
    ),
}));

vi.mock("../protocols.js", () => ({
    startProtocols: vi.fn(async (_kernel: unknown, _ctx: unknown, loginResult: { uin: string }) => {
        h.events.push(`startProtocols:${loginResult.uin}`);
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

vi.mock("../../log-cfg.js", () => ({
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
    h.onLogin = null;
    h.events.length = 0;
    h.createOptions.length = 0;
    h.loginCalls.length = 0;
    h.setSessionCalls.length = 0;
    h.sessionConfigArgs.length = 0;
    h.initCalls.length = 0;
    h.probeCalls.length = 0;
    h.listenerRecordCalls = 0;
    h.protocolResult = { ok: true };
    vi.unstubAllEnvs();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

/** 取全新 bootstrap-core 模块（env 快照隔离）。 */
async function freshModule(): Promise<typeof import("../bootstrap-core.js")> {
    vi.resetModules();
    return await import("../bootstrap-core.js");
}

/** 通用引导 env（IPC/自建宿主开关由用例覆盖）。 */
function stubBootEnv(): void {
    vi.stubEnv("NAPUTO_CFG_DIR", tmpRoot);
    vi.stubEnv("NAPUTO_QQ_VERSION", "9.9.9-Test");
    vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
    vi.stubEnv("NAPUTO_IPC", "");
}

/** 假 core（NapukettoCore.create 产物；login 可编程）。 */
function fakeCore(loginResult: { uin: string; uid: string; nick?: string } | null | Error): {
    core: Record<string, unknown>;
    setSession: ReturnType<typeof vi.fn>;
    attachWrapper: ReturnType<typeof vi.fn>;
} {
    const setSession = vi.fn((s: unknown) => {
        h.setSessionCalls.push(s);
    });
    const attachWrapper = vi.fn(() => ({
        engine: {},
        session: { getMsgService: () => null }, // 非 READY（激活路径可触达）
        loginService: {},
    }));
    const core: Record<string, unknown> = {
        attachWrapper,
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
    return { core, setSession, attachWrapper };
}

/** 假 kernel（NapukettoCore 路径 + 全量生命周期/探测面）。 */
function fakeKernel(
    core: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
): KernelLike {
    const box: Record<string, unknown> = {
        listLoginAccounts: () => Promise.resolve([]),
        buildSessionConfig: (args: Record<string, unknown>) => {
            h.sessionConfigArgs.push(args);
            return { built: true };
        },
        createLifecycleSessionListener: () => ({ listener: true }),
        initAndStartSession: async (
            _ctx: unknown,
            config: unknown,
            _listener: unknown,
            options: { timeoutMs: number },
        ) => {
            h.initCalls.push({ config, timeoutMs: options.timeoutMs });
        },
        waitSessionReady: () => Promise.resolve(),
        resolveQqUserDataRoot: () => "qqroot",
        resolveQqGlobalPath: (root: string) => `${root}/global`,
        readMachineGuid: () => "machine-guid",
        probeRuntime: (ctx: unknown, filename?: string) => {
            void ctx;
            h.probeCalls.push(filename);
            return { session: {}, services: { a: 1, b: 2 } };
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

const BOOT_ENV = { qqVersion: "9.9.9-Test", dataDir: "数据目录", wrapperPath: "wrapper.node" };
const LOGIN_RESULT = { uin: "10001", uid: "u1", nick: "甲" };

describe("bootstrapWithCore：session 替换（非自建宿主）", () => {
    it("getMainSession READY 候选 → core.setSession 替换", async () => {
        stubBootEnv();
        const mainSession = { getMsgService: () => ({}) };
        const { core, setSession, attachWrapper } = fakeCore(LOGIN_RESULT);
        const ctxSession = { getMsgService: () => null };
        attachWrapper.mockImplementation(() => ({
            engine: {},
            session: ctxSession,
            loginService: {},
        }));
        const kernel = fakeKernel(core, { getMainSession: () => mainSession });
        const mod = await freshModule();
        const ok = await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        expect(setSession).toHaveBeenCalledWith(mainSession);
    });

    it("候选与 ctx.session 相同 → 不替换（原地保留）", async () => {
        stubBootEnv();
        const ctxSession = { getMsgService: () => ({}) };
        const { core, setSession, attachWrapper } = fakeCore(LOGIN_RESULT);
        attachWrapper.mockImplementation(() => ({
            engine: {},
            session: ctxSession,
            loginService: {},
        }));
        const kernel = fakeKernel(core, { getMainSession: () => ctxSession });
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(setSession).not.toHaveBeenCalled();
    });

    it("无候选（getMainSession 抛错）→ 保留 kernel 自建 session（不替换）", async () => {
        stubBootEnv();
        const { core, setSession } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core, {
            getMainSession: () => {
                throw new Error("主 session 不可用");
            },
        });
        const mod = await freshModule();
        const ok = await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        expect(setSession).not.toHaveBeenCalled();
    });
});

describe("bootstrapWithCore：session 激活（自建宿主）", () => {
    it("NAPUTO_SELF_HOST=1 → 不替换，对 kernel 自建 session 走 init+start（三要素参数）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core, setSession } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        const ok = await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        expect(setSession).not.toHaveBeenCalled();
        // buildSessionConfig：QQ global 目录 + 设备指纹 + 登录身份
        const args = h.sessionConfigArgs[0];
        expect(args).toMatchObject({
            appid: 537376818,
            fullVersion: "9.9.9-Test",
            selfUin: "10001",
            selfUid: "u1",
            accountPath: "qqroot/global",
            machineGuid: "machine-guid",
        });
        expect(String(args?.["downloadPath"])).toContain("NapCat");
        // initAndStartSession：timeout 20s，先 init 后 start（kernel 内部契约）
        expect(h.initCalls[0]?.config).toEqual({ built: true });
        expect(h.initCalls[0]?.timeoutMs).toBe(20000);
    });

    it("initAndStartSession 拒绝 → 容错继续（waitSessionReady → 装配）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core, {
            initAndStartSession: () => Promise.reject(new Error("session init 断言")),
        });
        const mod = await freshModule();
        const ok = await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        expect(h.events).toContain("startProtocols:10001");
    });

    it("waitSessionReady 拒绝 → 容错继续装配（30s 超时参数）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        let waited = 0;
        const kernel = fakeKernel(core, {
            waitSessionReady: (ctx: unknown, options: { timeoutMs: number }) => {
                void ctx;
                waited += 1;
                void options;
                return Promise.reject(new Error("就绪超时"));
            },
        });
        const mod = await freshModule();
        const ok = await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(ok).toBe(true);
        expect(waited).toBe(1);
    });
});

describe("bootstrapWithCore：引导失败分支", () => {
    it("startProtocols null（服务未装配）→ 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        h.protocolResult = null;
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
        expect(h.events).toEqual(["startProtocols:10001"]);
    });

    it("core.login 缺失（kernel core 不完整）→ 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const core: Record<string, unknown> = {
            attachWrapper: () => ({ session: null, engine: {} }),
        };
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
    });

    it("doLogin null（登录失败）→ failed(NOT_LOGIN) + 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(null);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
        expect(h.statuses.at(-1)).toMatchObject({ phase: "failed", error: { code: "NOT_LOGIN" } });
    });

    it("kernel 无 NapukettoCore（非 fallback 入口）→ 引导 false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const kernel = fakeKernel({}) as KernelLike;
        delete (kernel as unknown as Record<string, unknown>)["NapukettoCore"];
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(false);
        expect(h.createOptions).toHaveLength(0);
    });

    it("probeCreatedSession：S2.create() 抛错 → 探测日志留痕，引导继续", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const state = freshState({
            wrapperExports: {
                NodeIQQNTWrapperSession: {
                    create: () => {
                        throw new Error("create 断言");
                    },
                },
            },
        });
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, state, BOOT_ENV, 537376818)).toBe(true);
    });

    it("关停钩子注册：requestShutdown 逆序触发 services.dispose → IPC 面 → stopAdapters", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        // 装配产物带清理探针（bootstrap-core 把它们注册进关停钩子）
        const dispose = vi.fn(() => h.events.push("dispose:services"));
        const stopAdapters = vi.fn(async () => h.events.push("stop:adapters"));
        h.protocolResult = { dispose, stopAdapters } as never;
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        expect(await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818)).toBe(true);
        // 真实 shutdown 模块编排（exit mock 不真退）
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            const shutdown = await import("../../../shutdown.js");
            // bootstrap-core 注册的钩子在新模块实例里——同一实例（resetModules 后
            // bootstrap-core 与 shutdown 同批加载）
            await shutdown.requestShutdown("单测关停");
            // 逆序执行：stopAdapters → IPC 面 + OB11 桥（同一钩子内先 IPC 后 OB11）→ services.dispose
            expect(h.events.slice(h.events.indexOf("startProtocols:10001"))).toEqual([
                "startProtocols:10001",
                "attach:ipc-services",
                "attach:ob11-bridge",
                "stop:adapters",
                "stop:ipc-services",
                "stop:ob11-bridge",
                "dispose:services",
            ]);
            expect(exitSpy).toHaveBeenCalledWith(0);
        } finally {
            exitSpy.mockRestore();
            writeSpy.mockRestore();
        }
    });
});

describe("bootstrapWithCore：登录前置（qrOnly / QR 透出 / 账号横幅）", () => {
    it("NAPUTO_QR_ONLY=1 → qrOnly:true 且不传 quickUin（跳过快速登录）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        vi.stubEnv("NAPUTO_QR_ONLY", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        const opts = h.loginCalls[0];
        expect(opts?.["qrOnly"]).toBe(true);
        expect("quickUin" in (opts as Record<string, unknown>)).toBe(false);
    });

    it("登录回调 QR 阶段：非 IPC 模式 → stdout NAPUTO_QR 标记行（cli 终端渲染）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
            chunks.push(String(c));
            return true;
        });
        try {
            const mod = await freshModule();
            await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
            const qrLine = chunks.find((c) => c.startsWith("NAPUTO_QR "));
            expect(qrLine).toBeDefined();
            expect(JSON.parse((qrLine as string).slice("NAPUTO_QR ".length))).toEqual({
                pngBase64: "cG5n",
                qrcodeUrl: "https://qr/x",
            });
        } finally {
            spy.mockRestore();
        }
    });

    it("登录回调 QR 阶段：IPC 模式 → sendQr（不写 stdout 标记行）", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
            chunks.push(String(c));
            return true;
        });
        try {
            const mod = await freshModule();
            await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
            expect(h.qrs).toEqual([{ pngBase64: "cG5n", qrcodeUrl: "https://qr/x" }]);
            expect(chunks.some((c) => c.startsWith("NAPUTO_QR "))).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("bootstrapWithCore：NapukettoCore.create 选项折叠", () => {
    it("[log] 段折叠进 create 选项（级别/格式/时间戳/颜色/文件）；IPC 模式 consoleLog:false", async () => {
        stubBootEnv();
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        vi.stubEnv("NAPUTO_QUICK_UIN", "10001");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
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
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect("consoleLog" in (h.createOptions[0] as Record<string, unknown>)).toBe(false);
    });
});

describe("bootstrapWithCore：探测与录制相位", () => {
    it("NAPUTO_PROBE=1 → 立即探测 + 35s 晚探测（napuketto-probe-late.json）", async () => {
        vi.useFakeTimers();
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        vi.stubEnv("NAPUTO_PROBE", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(h.probeCalls).toEqual([undefined]); // 立即探测（缺省文件名）
        await vi.advanceTimersByTimeAsync(35000);
        expect(h.probeCalls).toEqual([undefined, "napuketto-probe-late.json"]);
    });

    it("NAPUTO_PROBE=1 但 probeRuntime 抛错 → 日志留痕不崩", async () => {
        vi.useFakeTimers();
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        vi.stubEnv("NAPUTO_PROBE", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core, {
            probeRuntime: (ctx: unknown, filename?: string) => {
                void ctx;
                h.probeCalls.push(filename);
                throw new Error("探测断言");
            },
        });
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(h.probeCalls).toEqual([undefined]);
        await vi.advanceTimersByTimeAsync(35000);
        expect(h.probeCalls).toEqual([undefined, "napuketto-probe-late.json"]);
    });

    it("NAPUTO_LISTENER_RECORD=1 → 录制器挂起（先于探测），失败服务逐条留痕", async () => {
        vi.useFakeTimers();
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        vi.stubEnv("NAPUTO_LISTENER_RECORD", "1");
        vi.stubEnv("NAPUTO_PROBE", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core, {
            startListenerRecording: () => {
                h.listenerRecordCalls += 1;
                return {
                    file: "napuketto-listener-record.jsonl",
                    registered: {
                        Msg: { ok: true },
                        Group: { ok: false, error: "绑定失败" },
                    },
                };
            },
        });
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(h.listenerRecordCalls).toBe(1);
        // 录制先于探测（时序硬约束）
        expect(h.probeCalls).toEqual([undefined]);
    });

    it("NAPUTO_LISTENER_RECORD=1 但 kernel 缺录制器 → 告警（kernel 过旧）不崩", async () => {
        vi.useFakeTimers();
        stubBootEnv();
        vi.stubEnv("NAPUTO_SELF_HOST", "1");
        vi.stubEnv("NAPUTO_LISTENER_RECORD", "1");
        const { core } = fakeCore(LOGIN_RESULT);
        const kernel = fakeKernel(core);
        delete (kernel as unknown as Record<string, unknown>)["startListenerRecording"];
        const mod = await freshModule();
        await mod.bootstrapWithCore(kernel, freshState(), BOOT_ENV, 537376818);
        expect(h.listenerRecordCalls).toBe(0);
        expect(h.events).toContain("startProtocols:10001");
    });
});
