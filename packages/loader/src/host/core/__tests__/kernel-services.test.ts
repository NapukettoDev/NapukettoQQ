/**
 * kernel-services.test.ts：loader logger 装配参数单测（2026-09-10 T2：
 * cli 非 IPC 模式也落盘 logs/loader.log）。
 *
 * createKernelServices 对 kernel.createLogger 的传参断言：
 *   - IPC 模式（NAPUTO_IPC=1）：console=false（stdout 协议保护，2026-09-06
 *     事故根因，不可回退）+ file=<cfgDir>/logs/loader.log
 *   - cli 模式（NAPUTO_IPC≠1）：console=true + file 同路径（2026-09-10 前无
 *     file，poke/Buddy 校准数据丢失）
 *   - NAPUTO_CFG_DIR 未设：file 兜底 tmpdir()/napuketto-loader.log
 *
 * env.ts 是模块加载时的 process.env 快照——vi.stubEnv + vi.resetModules +
 * 每用例动态 import（与 bootstrap.test.ts 同套路）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreContextLike, KernelLike, LoggerLike, LoginResultLike } from "../../types.js";

/** 通用假节点：记录构造参数，register/unregister/on 可断言。 */
class FakeNode {
    readonly args: unknown[];
    readonly register = vi.fn();
    readonly unregister = vi.fn();
    readonly on = vi.fn(() => undefined);
    readonly setOnlineStatus = vi.fn(() =>
        failOnlineStatus ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    constructor(...args: unknown[]) {
        this.args = args;
        instances.push(this);
    }
}

interface LoggerCall {
    console: boolean;
    file?: string;
    fileLevel?: string;
    base?: Record<string, unknown>;
}

const tmpRoots: string[] = [];
let loggerCalls: LoggerCall[];
let instances: FakeNode[];
/** 置 true = setOnlineStatus 拒绝（失败容忍路径用例）。 */
let failOnlineStatus = false;

/** kernel PascalCase 类成员名（计算键规避 useNamingConvention，同 msg-log.test.ts）。 */
const KERNEL_MEMBERS = {
    ntEventChannel: "NTEventChannel",
    msgBridge: "MsgBridge",
    groupBridge: "GroupBridge",
    friendBridge: "FriendBridge",
    recentContactBridge: "RecentContactBridge",
    loginBridge: "LoginBridge",
    groupApi: "GroupApi",
    msgApi: "MsgApi",
    friendApi: "FriendApi",
    groupCache: "GroupCache",
    buddyCache: "BuddyCache",
    groupNotifyApi: "GroupNotifyApi",
    ticketApi: "TicketApi",
    richMediaApi: "RichMediaApi",
    recentContactApi: "RecentContactApi",
    profileApi: "ProfileApi",
    profileLikeApi: "ProfileLikeApi",
    webApi: "WebApi",
    chatType: "ChatType",
} as const;

function stubKernel(): KernelLike {
    loggerCalls = [];
    instances = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerLike;
    return {
        createLogger: (opts: LoggerCall) => {
            loggerCalls.push(opts);
            return logger;
        },
        [KERNEL_MEMBERS.ntEventChannel]: FakeNode,
        [KERNEL_MEMBERS.msgBridge]: FakeNode,
        [KERNEL_MEMBERS.groupBridge]: FakeNode,
        [KERNEL_MEMBERS.friendBridge]: FakeNode,
        [KERNEL_MEMBERS.recentContactBridge]: FakeNode,
        [KERNEL_MEMBERS.loginBridge]: FakeNode,
        [KERNEL_MEMBERS.groupApi]: FakeNode,
        [KERNEL_MEMBERS.msgApi]: FakeNode,
        [KERNEL_MEMBERS.friendApi]: FakeNode,
        [KERNEL_MEMBERS.groupCache]: FakeNode,
        [KERNEL_MEMBERS.buddyCache]: FakeNode,
        [KERNEL_MEMBERS.groupNotifyApi]: FakeNode,
        [KERNEL_MEMBERS.ticketApi]: FakeNode,
        [KERNEL_MEMBERS.richMediaApi]: FakeNode,
        [KERNEL_MEMBERS.recentContactApi]: FakeNode,
        [KERNEL_MEMBERS.profileApi]: FakeNode,
        [KERNEL_MEMBERS.profileLikeApi]: FakeNode,
        [KERNEL_MEMBERS.webApi]: FakeNode,
        [KERNEL_MEMBERS.chatType]: { GROUP: 1, C2C: 2 },
        toCanonicalElements: (msg: unknown) => {
            const raw = msg as { elements?: unknown };
            return (Array.isArray(raw.elements) ? raw.elements : []) as never[];
        },
    } as unknown as KernelLike;
}

function stubCtx(): CoreContextLike {
    return { session: {}, engine: {} };
}

async function assemble(): Promise<void> {
    const { createKernelServices } = await import("../kernel-services.js");
    const services = await createKernelServices(stubKernel(), stubCtx(), {
        uin: "10000",
        uid: "u1",
        nick: "tester",
    } satisfies LoginResultLike);
    expect(services).not.toBeNull();
}

/** 临时 CFG_DIR（每用例独立，收尾统一清理）。 */
function freshCfgDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "napuketto-ksvc-test-"));
    tmpRoots.push(dir);
    return dir;
}

beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    failOnlineStatus = false;
});

afterAll(() => {
    for (const dir of tmpRoots) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("createKernelServices logger 装配", () => {
    it("IPC 模式：console=false + file=<cfgDir>/logs/loader.log（stdout 协议保护不回退）", async () => {
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        await assemble();
        expect(loggerCalls).toHaveLength(1);
        expect(loggerCalls[0]?.console).toBe(false);
        expect(loggerCalls[0]?.file).toBe(
            join(tmpRoots[tmpRoots.length - 1] ?? "", "logs", "loader.log"),
        );
    });

    it("cli 模式（NAPUTO_IPC≠1）：console=true + 同一 file 路径（2026-09-10 新增落盘）", async () => {
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        await assemble();
        expect(loggerCalls).toHaveLength(1);
        expect(loggerCalls[0]?.console).toBe(true);
        expect(loggerCalls[0]?.file).toBe(
            join(tmpRoots[tmpRoots.length - 1] ?? "", "logs", "loader.log"),
        );
    });

    it("NAPUTO_CFG_DIR 未设：file 兜底 tmpdir()/napuketto-loader.log", async () => {
        vi.stubEnv("NAPUTO_IPC", "1");
        await assemble();
        expect(loggerCalls[0]?.file).toBe(join(tmpdir(), "napuketto-loader.log"));
    });
});

describe("createKernelServices dispose 面（顺带回归：装配产物完整）", () => {
    it("dispose 清理五桥 + 两缓存", async () => {
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        const { createKernelServices } = await import("../kernel-services.js");
        const services = await createKernelServices(
            stubKernel(),
            // wrapper.loginService 注入：Login 桥注册路径一并覆盖
            { ...stubCtx(), wrapper: { loginService: {} } },
            {
                uin: "10000",
                uid: "u1",
            } satisfies LoginResultLike,
        );
        expect(services).not.toBeNull();
        services?.dispose();
        // dispose 面 = 五桥（Msg/Group/Buddy/RecentContact/Login）+ GroupCache +
        // BuddyCache（API/Channel 实例不在清理面；批次三 2026-11-01 增两桥）
        const disposed = instances.filter((n) => n.unregister.mock.calls.length > 0);
        expect(disposed).toHaveLength(7);
    });
});

describe("createKernelServices 在线状态注册（2026-09-15 发现 I：半在线无推送修复）", () => {
    it("装配即注册在线状态，参数对齐 OB11 set_online_status 动作缺省（status=10）", async () => {
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        await assemble();
        const called = instances.filter((n) => n.setOnlineStatus.mock.calls.length > 0);
        expect(called).toHaveLength(1);
        expect(called[0]?.setOnlineStatus).toHaveBeenCalledWith({
            status: 10,
            extStatus: 0,
            batteryStatus: 0,
            customStatus: { faceId: "", wording: "", faceType: "1" },
        });
    });

    it("setOnlineStatus 拒绝不阻断装配（告警后继续，服务完整返回可用）", async () => {
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        failOnlineStatus = true;
        const { createKernelServices } = await import("../kernel-services.js");
        const services = await createKernelServices(stubKernel(), stubCtx(), {
            uin: "10000",
            uid: "u1",
        } satisfies LoginResultLike);
        expect(services).not.toBeNull();
        expect(services?.msgApi).toBeDefined();
        services?.dispose();
    });
});

describe("createKernelServices 批次三通道与 ob11 子 logger", () => {
    it("ctx.wrapper.loginService 缺失 → Login 桥跳过（通道保留，dispose 面少一个）", async () => {
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        const { createKernelServices } = await import("../kernel-services.js");
        const services = await createKernelServices(stubKernel(), stubCtx(), {
            uin: "10000",
            uid: "u1",
        } satisfies LoginResultLike);
        expect(services).not.toBeNull();
        // recentContact/login 通道仍在（事件为空但通道保留）
        expect(services?.recentContactChannel).toBeDefined();
        expect(services?.loginChannel).toBeDefined();
        services?.dispose();
        const disposed = instances.filter((n) => n.unregister.mock.calls.length > 0);
        expect(disposed).toHaveLength(6); // 无 Login 桥
    });

    it("logger.child 可用 → calibLogger = child({module:ob11})（级别随 [log.levels].ob11）", async () => {
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        const { createKernelServices } = await import("../kernel-services.js");
        const childCalls: Array<{
            bindings: Record<string, unknown>;
            options?: { level?: string };
        }> = [];
        const childLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const kernel = stubKernel() as unknown as KernelLike & {
            createLogger: (opts: unknown) => LoggerLike;
        };
        const originalCreateLogger = kernel.createLogger.bind(kernel);
        (kernel as unknown as { createLogger: (opts: unknown) => LoggerLike }).createLogger = (
            opts: unknown,
        ) => {
            originalCreateLogger(opts);
            return {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
                child: (bindings: Record<string, unknown>, options?: { level?: string }) => {
                    childCalls.push({ bindings, ...(options !== undefined ? { options } : {}) });
                    return childLogger;
                },
            };
        };
        const services = await createKernelServices(
            kernel,
            stubCtx(),
            { uin: "10000", uid: "u1" } satisfies LoginResultLike,
            {
                level: "info",
                banner: true,
                unboundReceive: true,
                levels: { ob11: "debug" },
            },
        );
        expect(childCalls).toHaveLength(1);
        expect(childCalls[0]?.bindings).toEqual({ module: "ob11" });
        expect(childCalls[0]?.options).toEqual({ level: "debug" });
        expect(services?.calibLogger).toBe(childLogger);
    });

    it("kernel 缺 createLogger（老版本）→ logger 兜底 undefined，calibLogger = 静默 logger", async () => {
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        const { createKernelServices } = await import("../kernel-services.js");
        const kernel = stubKernel() as unknown as Record<string, unknown>;
        delete kernel["createLogger"];
        const services = await createKernelServices(kernel as unknown as KernelLike, stubCtx(), {
            uin: "10000",
            uid: "u1",
        } satisfies LoginResultLike);
        expect(services).not.toBeNull();
        expect(services?.logger).toBeUndefined();
        // NOOP_LOGGER 兜底：四级别可调不抛
        expect(() => services?.calibLogger.info({})).not.toThrow();
        expect(() => services?.calibLogger.warn({})).not.toThrow();
        expect(() => services?.calibLogger.error({})).not.toThrow();
        expect(() => services?.calibLogger.debug({})).not.toThrow();
        services?.dispose();
    });

    it("[log.file] 配置 → createLogger file 走 resolveLogFilePath 展开路径", async () => {
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_CFG_DIR", freshCfgDir());
        const { createKernelServices } = await import("../kernel-services.js");
        const services = await createKernelServices(
            stubKernel(),
            stubCtx(),
            { uin: "10000", uid: "u1" } satisfies LoginResultLike,
            {
                level: "info",
                banner: true,
                unboundReceive: true,
                levels: {},
                file: { path: "logs/custom.log", level: "error" },
            },
        );
        expect(services).not.toBeNull();
        expect(loggerCalls[0]?.file).toContain("custom.log");
        expect(loggerCalls[0]?.fileLevel).toBe("error");
    });
});
