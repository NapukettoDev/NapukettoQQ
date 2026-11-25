// biome-ignore-all lint/style/useNamingConvention: 对象键名为包模块导出面（EventBroadcaster 等 PascalCase 类名），必须原样保留
/**
 * ob11-bridge.test.ts：OB11 动作桥装配与实际动作验证。
 */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { callIpcAction, type IpcActionHandler } from "../../../src/host/ipc/actions.js";
import { attachOb11IpcBridge, type Ob11BridgeEnv } from "../../../src/host/ipc/ob11-bridge.js";
import { env } from "../../../src/host/runtime/env.js";
import { ConfigError } from "../../../src/host/runtime/errors.js";
import type { KernelServices } from "../../../src/host/runtime/service-types.js";

/** 伪造 broadcaster（与 @napuketto/network EventBroadcaster 同语义的最小实现）。 */
class FakeBroadcaster {
    readonly adapters = new Set<{ send: (payload: unknown) => void }>();
    register(adapter: { send: (payload: unknown) => void }): void {
        this.adapters.add(adapter);
    }
    unregister(adapter: { send: (payload: unknown) => void }): void {
        this.adapters.delete(adapter);
    }
    emit(event: unknown): void {
        for (const adapter of this.adapters) {
            adapter.send(event);
        }
    }
}

/** 伪造 OB11 adapter（记录构造参数；subscribeOnly/unsubscribeOnly 可断言）。 */
class FakeOb11Adapter {
    static lastInstance: FakeOb11Adapter | null = null;
    static readonly constructOptions: Record<string, unknown>[] = [];
    /** registry.get 返回 undefined 的动作名（挂载跳过分支用；null = 全部存在）。 */
    static undefinedActionName: string | null = null;
    static readonly subscribe = vi.fn(async () => undefined);
    readonly subscribeOnly = vi.fn(async () => await FakeOb11Adapter.subscribe());
    readonly unsubscribeOnly = vi.fn();
    readonly broadcaster: FakeBroadcaster;
    readonly registry;
    constructor(options: Record<string, unknown>) {
        FakeOb11Adapter.constructOptions.push(options);
        FakeOb11Adapter.lastInstance = this;
        this.broadcaster = options["broadcaster"] as FakeBroadcaster;
        this.registry = {
            names: ["send_like", "get_login_info"],
            get: (name: string) => {
                if (FakeOb11Adapter.undefinedActionName === name) {
                    return undefined;
                }
                return {
                    handle: async (params: unknown) => ({
                        retcode: 0,
                        status: "ok",
                        data: { action: name, params },
                        message: "",
                    }),
                } as { handle: (payload: unknown) => Promise<unknown> };
            },
        };
    }
}

/** 假模块集（importModule 按 URL 关键字分发）。 */
function fakeModules(): Record<string, unknown> {
    return {
        network: { EventBroadcaster: FakeBroadcaster },
        onebot11: {
            ob11ConfigSchema: { parse: (input: unknown) => input },
            NapukettoOneBot11Adapter: FakeOb11Adapter,
        },
        core: {
            ProtocolConfig: class {
                readonly options: Record<string, unknown>;
                constructor(options: Record<string, unknown>) {
                    this.options = options;
                }
            },
        },
    };
}

/** importModule 假实现（按 URL 关键字返回对应模块）。 */
function fakeImport(fails = false): (url: string) => Promise<unknown> {
    const modules = fakeModules();
    return async (url: string) => {
        if (fails) {
            throw new Error("import 失败");
        }
        if (url.includes("onebot11")) {
            return modules["onebot11"];
        }
        if (url.includes("/core/")) {
            return modules["core"];
        }
        return modules["network"];
    };
}

/** mock KernelServices（桥只消费 channel/apis/self/groupCache/kernel.PathWrapper）。 */
function mockServices(): KernelServices {
    return {
        kernel: {
            PathWrapper: class {
                clearCache(): void {
                    // 桩：clean_cache 动作回调（本测试不触发）
                }
            },
        },
        channel: { on: vi.fn(() => () => undefined) },
        groupApi: {},
        friendApi: {},
        groupCache: {},
        msgApi: {},
        groupNotifyApi: {},
        ticketApi: {},
        richMediaApi: {},
        profileApi: {},
        profileLikeApi: {},
        webApi: {},
        self: { uin: "10001", nickname: "测试号" },
    } as unknown as KernelServices;
}

/** 标准环境（两个入口齐备）。 */
const baseEnv: Ob11BridgeEnv = {
    adapterEntry: "C:/repo/packages/adapter/dist/index.mjs",
    networkEntry: "C:/repo/packages/network/dist/index.mjs",
    qqVersion: "9.9.33-51802",
    dataRoot: "C:/data",
    cfgDir: "C:/data/10001",
};

/** 装配（注入假 import + 捕获 emitEvent）。 */
async function attach(
    envOverrides: Partial<Ob11BridgeEnv> = {},
    options: { fails?: boolean } = {},
): Promise<{
    stop: () => void;
    actions: Map<string, IpcActionHandler>;
    events: Array<{ service: string; name: string; args: unknown[] }>;
}> {
    const actions = new Map<string, IpcActionHandler>();
    const events: Array<{ service: string; name: string; args: unknown[] }> = [];
    const stop = await attachOb11IpcBridge(actions, mockServices(), {
        importModule: fakeImport(options.fails),
        emitEvent: (service, name, args) => events.push({ service, name, args }),
        env: { ...baseEnv, ...envOverrides },
    });
    return { stop, actions, events };
}

describe("attachOb11IpcBridge", () => {
    it("入口未注入 → noop（不挂动作）", async () => {
        const { stop, actions } = await attach({ adapterEntry: undefined });
        expect(actions.size).toBe(0);
        expect(stop()).toBeUndefined();
    });

    it("network 入口缺失 → noop", async () => {
        const { actions } = await attach({ networkEntry: "" });
        expect(actions.size).toBe(0);
    });

    it("整表挂载：registry 名单平铺合并 + 信封透传", async () => {
        const { actions } = await attach();
        expect([...actions.keys()].sort()).toEqual(["get_login_info", "send_like"]);
        // 既有 kernel 动作不被覆盖（命名空间不冲突）
        actions.set("msg.sendMessage", async () => "kernel");
        const result = await callIpcAction(actions, "send_like", { user_id: 1, times: 10 });
        expect(result).toEqual({
            ok: true,
            value: {
                retcode: 0,
                status: "ok",
                data: { action: "send_like", params: { user_id: 1, times: 10 } },
                message: "",
            },
        });
        expect(await actions.get("msg.sendMessage")?.({})).toBe("kernel");
    });

    it("构造参数：seed 缺省段 + system/九 api/self/groupCache 注入", async () => {
        FakeOb11Adapter.constructOptions.length = 0;
        await attach();
        const options = FakeOb11Adapter.constructOptions[0] as Record<string, unknown>;
        expect(options["self"]).toEqual({ uin: "10001", nickname: "测试号" });
        expect(options["msgChannel"]).toBeDefined();
        expect(options["groupCache"]).toBeDefined();
        expect(options["config"]).toMatchObject({
            options: { seed: { media: { outboundPolicy: "public-only" } } },
        });
        const system = options["system"] as { appVersion: string };
        expect(system.appVersion).toBe("9.9.33-51802");
    });

    it("只把实际登录账号的媒体配置传给动态注入的动作桥", async () => {
        const original = env.NAPUKETTO_CONFIG_JSON;
        env.NAPUKETTO_CONFIG_JSON = JSON.stringify({
            accounts: [
                { qq: "10002", onebot11: { media: { outboundPolicy: "public-only" } } },
                {
                    qq: "10001",
                    onebot11: {
                        media: { outboundPolicy: "compat" },
                        httpServers: [{ enabled: true, port: 3000 }],
                    },
                },
            ],
        });
        try {
            const { stop } = await attach();
            expect(FakeOb11Adapter.constructOptions.at(-1)?.["config"]).toMatchObject({
                options: { seed: { media: { outboundPolicy: "compat" } } },
            });
            const config = FakeOb11Adapter.constructOptions.at(-1)?.["config"];
            expect(config).not.toMatchObject({
                options: { seed: { httpServers: expect.anything() } },
            });
            stop();
        } finally {
            env.NAPUKETTO_CONFIG_JSON = original;
        }
    });

    it("不挂载会丢弃媒体策略的旧版 OB11 模块", async () => {
        const load = fakeImport();
        const actions = new Map<string, IpcActionHandler>();
        await attachOb11IpcBridge(actions, mockServices(), {
            env: baseEnv,
            importModule: async (url) =>
                url.includes("onebot11")
                    ? {
                          NapukettoOneBot11Adapter: FakeOb11Adapter,
                          ob11ConfigSchema: {
                              parse: () => ({ media: { outboundPolicy: "public-only" } }),
                          },
                      }
                    : await load(url),
        });
        expect(actions.size).toBe(0);
    });

    it("IPC 使用线上协议 schema 校验，非法模式返回配置错误", async () => {
        const original = env.NAPUKETTO_CONFIG_JSON;
        env.NAPUKETTO_CONFIG_JSON = JSON.stringify({
            accounts: [{ qq: "10001", onebot11: { media: { outboundPolicy: "typo" } } }],
        });
        const load = fakeImport();
        const actions = new Map<string, IpcActionHandler>();
        try {
            await expect(
                attachOb11IpcBridge(actions, mockServices(), {
                    env: baseEnv,
                    importModule: async (url) =>
                        url.includes("onebot11")
                            ? await import("@napuketto/adapter/onebot11")
                            : await load(url),
                }),
            ).rejects.toBeInstanceOf(ConfigError);
            expect(actions.size).toBe(0);
        } finally {
            env.NAPUKETTO_CONFIG_JSON = original;
        }
    });

    it("注入真实 OB11 动作后，IPC download_file 默认拒绝环回且支持显式 compat", async () => {
        const cfgDir = await mkdtemp(join(tmpdir(), "nk-ob11-ipc-media-"));
        const request = vi.fn();
        const server = createServer((req, res) => {
            request(req.headers.authorization);
            res.end("test media");
        });
        const original = env.NAPUKETTO_CONFIG_JSON;
        try {
            await once(server.listen(0, "127.0.0.1"), "listening");
            const address = server.address();
            if (address === null || typeof address === "string")
                throw new Error("Missing TCP port");
            for (const outboundPolicy of ["public-only", "compat"]) {
                env.NAPUKETTO_CONFIG_JSON = JSON.stringify({
                    accounts: [
                        {
                            qq: "10001",
                            ...(outboundPolicy === "compat"
                                ? { onebot11: { media: { outboundPolicy } } }
                                : {}),
                        },
                    ],
                });
                const actions = new Map<string, IpcActionHandler>();
                const stop = await attachOb11IpcBridge(actions, mockServices(), {
                    env: { ...baseEnv, cfgDir },
                    importModule: async (url) => {
                        if (url.includes("onebot11"))
                            return await import("@napuketto/adapter/onebot11");
                        if (url.includes("/core/")) return await import("@napuketto/adapter/core");
                        return { EventBroadcaster: FakeBroadcaster };
                    },
                });
                try {
                    const result = await actions.get("download_file")?.({
                        url: `http://127.0.0.1:${address.port}/media.png`,
                        headers: { ["Authorization"]: "Bearer test" },
                    });
                    if (outboundPolicy === "compat") {
                        expect(result).toMatchObject({ status: "ok" });
                        expect(request).toHaveBeenCalledExactlyOnceWith("Bearer test");
                    } else {
                        expect(result).toMatchObject({
                            status: "failed",
                            message: expect.stringContaining("公网下载策略拒绝"),
                        });
                        expect(request).not.toHaveBeenCalled();
                    }
                } finally {
                    stop();
                }
            }
        } finally {
            env.NAPUKETTO_CONFIG_JSON = original;
            server.close();
            await once(server, "close");
            await rm(cfgDir, { recursive: true, force: true });
        }
    });

    it("真实 OB11 IPC 只授权登录账号的本地导出目录", async () => {
        const dir = await mkdtemp(join(tmpdir(), "nk-ob11-ipc-local-"));
        const exports = join(dir, "exports");
        const other = join(dir, "other");
        const source = join(exports, "avatar.png");
        const foreignFile = join(other, "avatar.png");
        await mkdir(exports);
        await mkdir(other);
        await writeFile(source, "login account");
        await writeFile(foreignFile, "other account");
        const setHeader = vi.fn(async (path: string) => {
            expect(path).not.toBe(source);
            expect(await readFile(path, "utf8")).toBe("login account");
        });
        const services = { ...mockServices(), profileApi: { setHeader } };
        const original = env.NAPUKETTO_CONFIG_JSON;
        try {
            for (const enabled of [false, true]) {
                env.NAPUKETTO_CONFIG_JSON = JSON.stringify({
                    accounts: [
                        { qq: "10002", onebot11: { media: { localMediaRoots: ["other"] } } },
                        {
                            qq: "10001",
                            ...(enabled
                                ? { onebot11: { media: { localMediaRoots: ["exports"] } } }
                                : {}),
                        },
                    ],
                });
                const actions = new Map<string, IpcActionHandler>();
                const stop = await attachOb11IpcBridge(actions, services, {
                    env: { ...baseEnv, cfgDir: dir, dataRoot: dir },
                    importModule: async (url) => {
                        if (url.includes("onebot11"))
                            return await import("@napuketto/adapter/onebot11");
                        if (url.includes("/core/")) return await import("@napuketto/adapter/core");
                        return { EventBroadcaster: FakeBroadcaster };
                    },
                });
                try {
                    await expect(
                        actions.get("set_qq_avatar")?.({ file: foreignFile }),
                    ).resolves.toMatchObject({ retcode: 105 });
                    await expect(
                        actions.get("set_qq_avatar")?.({ file: source }),
                    ).resolves.toMatchObject({
                        retcode: enabled ? 0 : 105,
                    });
                } finally {
                    stop();
                }
            }
            expect(setHeader).toHaveBeenCalledTimes(1);
        } finally {
            env.NAPUKETTO_CONFIG_JSON = original;
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("subscribeOnly 被调用（不调 start/传输）", async () => {
        const { stop } = await attach();
        expect(FakeOb11Adapter.lastInstance?.subscribeOnly).toHaveBeenCalledTimes(1);
        stop();
        expect(FakeOb11Adapter.lastInstance?.unsubscribeOnly).toHaveBeenCalledTimes(1);
    });

    it("broadcaster 事件 → ob11 通道（name=post_type），stop 后不再透出", async () => {
        const { stop, events } = await attach();
        const broadcaster = FakeOb11Adapter.lastInstance?.broadcaster;
        expect(broadcaster).toBeDefined();
        broadcaster?.emit({ post_type: "notice", notice_type: "poke" });
        expect(events).toEqual([
            {
                service: "ob11",
                name: "notice",
                args: [{ post_type: "notice", notice_type: "poke" }],
            },
        ]);
        stop();
        broadcaster?.emit({ post_type: "message" });
        expect(events).toHaveLength(1);
    });

    it("post_type 异常事件 → name=unknown 兜底", async () => {
        const { events } = await attach();
        FakeOb11Adapter.lastInstance?.broadcaster.emit({ foo: 1 });
        expect(events[0]?.name).toBe("unknown");
    });

    it("import 失败 → fail-soft（noop 不抛，动作表为空）", async () => {
        const { stop, actions } = await attach({}, { fails: true });
        expect(actions.size).toBe(0);
        expect(stop()).toBeUndefined();
    });

    it("subscribeOnly 失败时退订部分装配并保留纯 kernel 动作面", async () => {
        FakeOb11Adapter.subscribe.mockRejectedValueOnce(new Error("接收链路初始化失败"));
        const { actions, events, stop } = await attach();
        const instance = FakeOb11Adapter.lastInstance;
        expect(instance?.unsubscribeOnly).toHaveBeenCalledOnce();
        expect(actions.size).toBe(0);
        instance?.broadcaster.emit({ post_type: "message" });
        expect(events).toHaveLength(0);
        stop();
        expect(instance?.unsubscribeOnly).toHaveBeenCalledOnce();
    });

    it("registry act 缺失 → 跳过挂载，stop 只移除已挂载的动作", async () => {
        FakeOb11Adapter.undefinedActionName = "send_like";
        try {
            const { actions, stop } = await attach();
            expect([...actions.keys()].sort()).toEqual(["get_login_info"]);
            stop();
            expect(actions.size).toBe(0);
        } finally {
            FakeOb11Adapter.undefinedActionName = null;
        }
    });

    it("stop 移除挂载的动作条目（软重登重装配清理；不误删既有 kernel 动作）", async () => {
        const actions = new Map<string, IpcActionHandler>();
        actions.set("msg.sendMessage", async () => "kernel");
        const stop = await attachOb11IpcBridge(actions, mockServices(), {
            importModule: fakeImport(),
            emitEvent: () => undefined,
            env: { ...baseEnv },
        });
        expect(actions.has("send_like")).toBe(true);
        stop();
        expect(actions.has("send_like")).toBe(false);
        expect(await actions.get("msg.sendMessage")?.({})).toBe("kernel");
    });

    it("qqVersion 为空串 → system.appVersion 兜底 unknown", async () => {
        FakeOb11Adapter.constructOptions.length = 0;
        await attach({ qqVersion: "" });
        const system = FakeOb11Adapter.constructOptions[0]?.["system"] as { appVersion: string };
        expect(system.appVersion).toBe("unknown");
    });

    it("system.cleanCache → PathWrapper(dataRoot, account=uin) + clearCache", async () => {
        const cleared: Record<string, unknown>[] = [];
        const services = mockServices();
        (services as unknown as Record<string, unknown>)["kernel"] = {
            PathWrapper: class {
                options: Record<string, unknown>;
                constructor(options: Record<string, unknown>) {
                    this.options = options;
                }
                clearCache(): void {
                    cleared.push(this.options);
                }
            },
        };
        FakeOb11Adapter.constructOptions.length = 0;
        const actions = new Map<string, IpcActionHandler>();
        await attachOb11IpcBridge(actions, services, {
            importModule: fakeImport(),
            emitEvent: () => undefined,
            env: { ...baseEnv },
        });
        const system = FakeOb11Adapter.constructOptions[0]?.["system"] as {
            cleanCache: () => Promise<void>;
        };
        await system.cleanCache();
        expect(cleared).toEqual([{ dataRoot: "C:/data", account: "10001" }]);
    });

    it("system.exit / restart → 统一关停（driver 重启机制接管）", async () => {
        FakeOb11Adapter.constructOptions.length = 0;
        const shutdown = await import("../../../src/lifecycle/shutdown.js");
        const exitSpy = vi.spyOn(shutdown, "requestShutdown").mockResolvedValue();
        try {
            await attach();
            const system = FakeOb11Adapter.constructOptions[0]?.["system"] as {
                exit: () => Promise<void>;
                restart: () => Promise<void>;
            };
            await system.exit();
            await system.restart();
            expect(exitSpy).toHaveBeenCalledWith("OB11 进程控制请求");
            expect(exitSpy).toHaveBeenCalledTimes(2);
        } finally {
            exitSpy.mockRestore();
        }
    });

    it("mediaBaseDir：ctx.wrapper.exports 经 resolveQqUserDataRoot 解析（T5 基准）", async () => {
        const services = mockServices();
        (services as unknown as Record<string, unknown>)["ctx"] = {
            wrapper: { exports: {} },
        };
        (services as unknown as Record<string, unknown>)["kernel"] = {
            resolveQqUserDataRoot: () => "C:/qqroot",
            resolveQqGlobalPath: (root: string) => `${root}/global`,
            PathWrapper: class {
                clearCache(): void {
                    // 桩
                }
            },
        };
        FakeOb11Adapter.constructOptions.length = 0;
        await attachOb11IpcBridge(new Map(), services, {
            importModule: fakeImport(),
            emitEvent: () => undefined,
            env: { ...baseEnv },
        });
        const system = FakeOb11Adapter.constructOptions[0]?.["system"] as Record<string, unknown>;
        expect(system["mediaBaseDir"]).toBe("C:/qqroot/global");
    });

    it("ctx 无 wrapper → mediaBaseDir 不注入（字段缺省）", async () => {
        const services = mockServices();
        (services as unknown as Record<string, unknown>)["ctx"] = {};
        (services as unknown as Record<string, unknown>)["kernel"] = {
            PathWrapper: class {
                clearCache(): void {
                    // 桩
                }
            },
        };
        FakeOb11Adapter.constructOptions.length = 0;
        await attachOb11IpcBridge(new Map(), services, {
            importModule: fakeImport(),
            emitEvent: () => undefined,
            env: { ...baseEnv },
        });
        const system = FakeOb11Adapter.constructOptions[0]?.["system"] as Record<string, unknown>;
        expect("mediaBaseDir" in system).toBe(false);
    });
});
