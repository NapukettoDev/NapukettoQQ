/**
 * assemble-protocols.test.ts：OB11/Satori/Kurobot/Milky 协议装配单测（assemble-protocols.ts）。
 *
 * 策略：假 adapter/network 以真实 ESM .mjs 文件写进临时目录（每用例独立目录，
 * 动态 import URL 不同不命中模块缓存），env 快照隔离（vi.stubEnv + vi.resetModules +
 * 动态 import）。假 adapter 构造参数记录到 globalThis.__fakeAdapters，供断言：
 *  - 入口未注入 → 返回 no-op 停止函数，不触发任何 import
 *  - 四协议装配（内联配置 seed）+ 停止函数逐个 stop
 *  - kurobot 段 seed 校验失败 → ConfigError（78 退出码契约）
 *  - import 失败 → 抛出（装配失败判引导失败，不吞错）
 *  - QQ NT global 目录解析（mediaBaseDir）/ cleanCache（PathWrapper）/ exit 回调
 */
// biome-ignore-all lint/style/useNamingConvention: 对象键名为 kernel/wrapper 导出面（PascalCase 类名），必须原样保留

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelLike } from "../../types.js";
import type { KernelServices } from "../kernel-services.js";

/** 假 adapter 记录面（假模块写入 / 测试读取，同一 worker 全局共享）。 */
interface FakeAdapterRecord {
    kind: string;
    adapter: { started: number; stopped: number; options: Record<string, unknown> };
}

/** 假 PathWrapper 记录面。 */
interface FakePathWrapperRecord {
    options: Record<string, unknown>;
    clearCacheCalls: number;
}

/** 读取 globalThis 记录（假模块与测试间的共享通道）。 */
function fakeAdapters(): FakeAdapterRecord[] {
    return ((globalThis as Record<string, unknown>)["__fakeAdapters"] as FakeAdapterRecord[]) ?? [];
}

function fakePathWrappers(): FakePathWrapperRecord[] {
    return (
        ((globalThis as Record<string, unknown>)[
            "__fakePathWrappers"
        ] as FakePathWrapperRecord[]) ?? []
    );
}

/** 假 adapter 通用脚本片段（构造记录 + start/stop 计数）。 */
const ADAPTER_TAIL = `
export class FakeAdapterBase {
    constructor(kind, options) {
        this.kind = kind;
        this.options = options;
        this.started = 0;
        this.stopped = 0;
        globalThis.__fakeAdapters = globalThis.__fakeAdapters || [];
        globalThis.__fakeAdapters.push({ kind, adapter: this });
    }
    async start() { this.started += 1; return { started: true }; }
    async stop() { this.stopped += 1; }
}
`;

/** 假 onebot11 模块源码。 */
const ONEBOT11_MJS = `globalThis.__fakeAdapters = globalThis.__fakeAdapters || [];
export const ob11ConfigSchema = {
    parse(input) {
        if (input && input.__invalid) { throw new Error("onebot11 字段非法"); }
        return { ...(input ?? {}) };
    },
};
${ADAPTER_TAIL}
export class NapukettoOneBot11Adapter extends FakeAdapterBase {
    constructor(options) { super("ob11", options); }
}
`;

/** 假 satori 模块源码。 */
const SATORI_MJS = `globalThis.__fakeAdapters = globalThis.__fakeAdapters || [];
export const satoriConfigSchema = { parse(input) { return { ...(input ?? {}) }; } };
${ADAPTER_TAIL}
export class NapukettoSatoriAdapter extends FakeAdapterBase {
    constructor(options) { super("satori", options); }
}
`;

/** 假 kurobot 模块源码（schema 支持 __invalid 抛错，测 seed 校验失败）。 */
const KUROBOT_MJS = `globalThis.__fakeAdapters = globalThis.__fakeAdapters || [];
export const kurobotConfigSchema = {
    parse(input) {
        if (input && input.__invalid) { throw new Error("url 必填"); }
        return { ...(input ?? {}) };
    },
};
export function kurobotConfigDefaults() { return { url: "" }; }
${ADAPTER_TAIL}
export class NapukettoKurobotAdapter extends FakeAdapterBase {
    constructor(options) { super("kurobot", options); }
}
`;

/** 假 milky 模块源码。 */
const MILKY_MJS = `globalThis.__fakeAdapters = globalThis.__fakeAdapters || [];
export const milkyConfigSchema = { parse(input) { return { ...(input ?? {}) }; } };
${ADAPTER_TAIL}
export class NapukettoMilkyAdapter extends FakeAdapterBase {
    constructor(options) { super("milky", options); }
}
`;

/** 假 adapter core（ProtocolConfig 框架）模块源码。 */
const CORE_MJS = `
export class ProtocolConfig {
    constructor(options) { this.options = options; }
}
`;

/** 假 network 模块源码（EventBroadcaster register/unregister 记录）。 */
const NETWORK_MJS = `
export class EventBroadcaster {
    constructor() { this.adapters = []; }
    register(adapter) { this.adapters.push(adapter); }
    unregister(adapter) { this.adapters = this.adapters.filter((a) => a !== adapter); }
}
`;

/** 临时目录（每用例独立）。 */
let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-assemble-test-"));
    // 假模块目录树
    const adapterDir = join(tmpRoot, "adapter");
    for (const sub of ["onebot11", "satori", "kurobot", "milky", "core"]) {
        mkdirSync(join(adapterDir, sub), { recursive: true });
    }
    mkdirSync(join(tmpRoot, "network"), { recursive: true });
    writeFileSync(join(adapterDir, "onebot11", "index.mjs"), ONEBOT11_MJS, "utf8");
    writeFileSync(join(adapterDir, "satori", "index.mjs"), SATORI_MJS, "utf8");
    writeFileSync(join(adapterDir, "kurobot", "index.mjs"), KUROBOT_MJS, "utf8");
    writeFileSync(join(adapterDir, "milky", "index.mjs"), MILKY_MJS, "utf8");
    writeFileSync(join(adapterDir, "core", "index.mjs"), CORE_MJS, "utf8");
    writeFileSync(join(tmpRoot, "network", "index.mjs"), NETWORK_MJS, "utf8");
    // 环境快照：入口指向假模块
    vi.stubEnv("NAPUTO_ADAPTER_ENTRY", join(adapterDir, "index.mjs"));
    vi.stubEnv("NAPUTO_NETWORK_ENTRY", join(tmpRoot, "network", "index.mjs"));
    vi.stubEnv("NAPUTO_QQ_VERSION", "9.9.33-51802");
    vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "account"));
    vi.stubEnv("NAPKETTO_DATA", tmpRoot);
    // 全局记录清零
    (globalThis as Record<string, unknown>)["__fakeAdapters"] = [];
    (globalThis as Record<string, unknown>)["__fakePathWrappers"] = [];
});

afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** 取全新 assemble 模块（隔离 env 快照）。 */
async function freshAssemble(): Promise<typeof import("../assemble-protocols.js")> {
    vi.resetModules();
    return await import("../assemble-protocols.js");
}

/** 假 kernel（QQ 数据根解析 + PathWrapper 记录）。 */
function fakeKernel(): KernelLike {
    return {
        resolveQqUserDataRoot: () => join(tmpRoot, "qqroot"),
        resolveQqGlobalPath: (root: string) => join(root, "global"),
        PathWrapper: class {
            options: Record<string, unknown>;
            clearCacheCalls = 0;
            constructor(options: Record<string, unknown>) {
                this.options = options;
                fakePathWrappers().push(this as unknown as FakePathWrapperRecord);
            }
            clearCache(): void {
                this.clearCacheCalls += 1;
            }
        },
    } as unknown as KernelLike;
}

/** 假 kernel 服务集合（装配只消费通道/缓存/apis/self/ctx）。 */
function fakeServices(): KernelServices {
    return {
        kernel: fakeKernel(),
        ctx: { session: {}, wrapper: { exports: {} } },
        logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        },
        calibLogger: { debug: () => undefined, warn: () => undefined, info: () => undefined },
        channel: { on: () => () => undefined },
        groupChannel: { on: () => () => undefined },
        friendChannel: { on: () => () => undefined },
        recentContactChannel: { on: () => () => undefined },
        loginChannel: { on: () => () => undefined },
        groupCache: { listGroupsRefreshed: async () => [] },
        buddyCache: { events: { on: () => () => undefined } },
        msgApi: {},
        groupApi: {},
        groupNotifyApi: {},
        friendApi: {},
        ticketApi: {},
        richMediaApi: {},
        recentContactApi: {},
        profileApi: {},
        profileLikeApi: {},
        webApi: {},
        self: { uin: "10001", nickname: "测试号", uid: "u1" },
    } as unknown as KernelServices;
}

const LOGIN = { uin: "10001", uid: "u1", nick: "测试号" };

/** 按账号段注入内联配置（NAPKETTO_CONFIG_JSON）。 */
function stubInlineConfig(account: Record<string, unknown>): void {
    vi.stubEnv("NAPKETTO_CONFIG_JSON", JSON.stringify({ accounts: [{ qq: "10001", ...account }] }));
}

/** 按 kind 找假 adapter。 */
function adapterOf(kind: string): FakeAdapterRecord["adapter"] | undefined {
    return fakeAdapters().find((r) => r.kind === kind)?.adapter;
}

describe("assembleOb11AndSatori", () => {
    it("入口未注入 → 返回 no-op 停止函数，不触发 import", async () => {
        vi.stubEnv("NAPUTO_ADAPTER_ENTRY", "");
        vi.stubEnv("NAPUTO_NETWORK_ENTRY", "");
        const assemble = await freshAssemble();
        const stop = await assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN);
        expect(fakeAdapters()).toHaveLength(0);
        await expect(stop()).resolves.toBeUndefined();
    });

    it("四协议装配（内联 seed）+ 停止函数逐个 stop", async () => {
        stubInlineConfig({
            kurobot: { url: "ws://127.0.0.1:9/ws" },
            milky: { enabled: true },
            satori: { cacheDir: join(tmpRoot, "satori-cache") },
        });
        const assemble = await freshAssemble();
        const stop = await assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN);
        expect(fakeAdapters().map((r) => r.kind)).toEqual(["ob11", "satori", "kurobot", "milky"]);
        for (const record of fakeAdapters()) {
            expect(record.adapter.started).toBe(1);
        }
        // 内联来源：cfgFile 哨兵值
        const ob11 = adapterOf("ob11");
        const ob11Config = ob11?.options["config"] as { options?: Record<string, unknown> };
        expect(ob11Config?.options?.["path"]).toBe("<inline>");
        // satori 段 cacheDir 自定义
        const satori = adapterOf("satori");
        expect(satori?.options["cacheDir"]).toBe(join(tmpRoot, "satori-cache"));
        // 停止：逐个 stop 幂等调用
        await stop();
        for (const record of fakeAdapters()) {
            expect(record.adapter.stopped).toBe(1);
        }
    });

    it("kurobot/milky 段为空 → 不装配对应协议", async () => {
        stubInlineConfig({});
        const assemble = await freshAssemble();
        await assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN);
        expect(fakeAdapters().map((r) => r.kind)).toEqual(["ob11", "satori"]);
    });

    it("kurobot 段 seed 校验失败 → ConfigError（消息含段名与 zod 明细）", async () => {
        stubInlineConfig({ kurobot: { __invalid: true } });
        const assemble = await freshAssemble();
        await expect(
            assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN),
        ).rejects.toMatchObject({
            name: "ConfigError",
            message: expect.stringContaining("协议配置 kurobot 段校验失败"),
        });
    });

    it("network 入口损坏（文件缺失）→ import 失败抛出（不吞错）", async () => {
        vi.stubEnv("NAPUTO_NETWORK_ENTRY", join(tmpRoot, "network", "missing.mjs"));
        const assemble = await freshAssemble();
        await expect(
            assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN),
        ).rejects.toThrow();
    });

    it("QQ NT global 目录解析：mediaBaseDir 注入 ob11.system（get_image 基准）", async () => {
        stubInlineConfig({});
        const assemble = await freshAssemble();
        await assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN);
        const ob11 = adapterOf("ob11");
        const system = ob11?.options["system"] as Record<string, unknown>;
        expect(system["mediaBaseDir"]).toBe(join(tmpRoot, "qqroot", "global"));
        expect(system["cacheDir"]).toBe(join(tmpRoot, "account", "cache"));
        expect(system["appVersion"]).toBe("9.9.33-51802");
    });

    it("system.cleanCache → PathWrapper(dataRoot, account=uin) + clearCache", async () => {
        stubInlineConfig({});
        const assemble = await freshAssemble();
        await assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN);
        const system = adapterOf("ob11")?.options["system"] as {
            cleanCache: () => Promise<void>;
        };
        await system.cleanCache();
        const wrappers = fakePathWrappers();
        expect(wrappers).toHaveLength(1);
        expect(wrappers[0]?.options).toEqual({ dataRoot: tmpRoot, account: "10001" });
        expect(wrappers[0]?.clearCacheCalls).toBe(1);
    });

    it("system.exit / restart 回调 → 退出进程（bot_exit / set_restart）", async () => {
        stubInlineConfig({});
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            const assemble = await freshAssemble();
            await assemble.assembleOb11AndSatori(fakeKernel(), fakeServices(), LOGIN);
            const system = adapterOf("ob11")?.options["system"] as {
                exit: () => Promise<void>;
                restart: () => Promise<void>;
            };
            await system.exit();
            await system.restart();
            expect(exitSpy).toHaveBeenCalledWith(0);
            expect(exitSpy).toHaveBeenCalledTimes(2);
        } finally {
            exitSpy.mockRestore();
        }
    });
});
