// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * probe.ts probeRuntime 编排测试（此前从未进覆盖率报告；全 mock，绝不加载真实二进制）：
 *  - startup 链路：create 成功（Map sessionId 提取 + nt_ 优先主 session）/ 缺 create
 *    → startup null / 无 Map 数据 → 候选名兜底
 *  - enumerateSessionIds：getNTWrapperSession 缺失 → 空；命中 id 记录方法面
 *  - probeSession：主目标选择（own-create 优先 / 回退 mainSession）/ services 收集
 *    （names-only + getter 失败记录）/ 落选候选概要
 *  - probeRuntime 产物：exports/engine 方法面 + 落盘（NAPUTO_CFG_DIR）+ probeFile
 *  - 落盘失败 → probeFileError 不抛
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../../wrapper-loader.js";
import { probeRuntime } from "../probe.js";

const tmpDirs: string[] = [];
let savedCfgDir: string | undefined;

beforeEach(() => {
    savedCfgDir = process.env["NAPUTO_CFG_DIR"];
    const dir = mkdtempSync(join(tmpdir(), "nk-test-probe-"));
    tmpDirs.push(dir);
    process.env["NAPUTO_CFG_DIR"] = dir;
});

afterEach(() => {
    if (savedCfgDir === undefined) {
        delete process.env["NAPUTO_CFG_DIR"];
    } else {
        process.env["NAPUTO_CFG_DIR"] = savedCfgDir;
    }
});

afterAll(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** 构造带完整启动链路的假 ctx（session getter 面可覆写）。 */
function makeCtx(
    overrides: {
        startupCreate?: () => unknown;
        getNTWrapperSession?: (id: string) => unknown;
        session?: unknown;
        engineMethods?: Record<string, () => unknown>;
        loginGet?: () => unknown;
    } = {},
): WrapperContext {
    const sessionCtor: Record<string, unknown> = {
        get: () => null,
        create: () => null,
    };
    if (overrides.getNTWrapperSession !== undefined) {
        sessionCtor["getNTWrapperSession"] = overrides.getNTWrapperSession;
    }
    const exports: Record<string, unknown> = {
        NodeIQQNTWrapperSession: sessionCtor,
        NodeIQQNTStartupSessionWrapper: overrides.startupCreate
            ? { create: overrides.startupCreate }
            : { noCreate: 1 },
        NodeQQNTWrapperUtil: { get: () => null },
        NodeIKernelLoginService: { get: overrides.loginGet ?? (() => null) },
        NodeIO3MiscService: { get: () => null },
    };
    const engine: Record<string, unknown> = {
        initWithDeskTopConfig: () => undefined,
        ...(overrides.engineMethods ?? {}),
    };
    return {
        exports: exports as unknown as WrapperContext["exports"],
        engine: engine as unknown as WrapperContext["engine"],
        versionInfo: { fullVersion: "9.9.33-52230", buildVersion: "52230" },
        session: (overrides.session ?? null) as WrapperContext["session"],
        startupSession: null,
        loginService: null,
    } as unknown as WrapperContext;
}

/** 带 getMsgService 的假主 session（startup 链路产物）。 */
function fakeSession(msgService: Record<string, unknown> | null = { sendMsg: () => 0 }) {
    return {
        getMsgService: () => msgService,
        getGroupService: () => ({ addKernelGroupListener: () => 1 }),
        // 非 get*Service 命名：不应进 services 面
        startNT: () => undefined,
    };
}

describe("startup 链路", () => {
    it("create 成功 + Map sessionId：start/枚举/主 session 方法面齐全", () => {
        const main = fakeSession();
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () =>
                    new Map([
                        ["nt", "nt_3"],
                        ["gpro", "gpro_1"],
                    ]),
            }),
            getNTWrapperSession: (id: string) => (id === "nt_3" ? main : null),
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(startup["sessionIds"]).toEqual(["nt_3", "gpro_1"]);
        expect(startup["mainSessionId"]).toBe("nt_3");
        // 主 session 方法面：methods + ownKeys
        const mainFace = startup["mainSession"] as Record<string, unknown>;
        expect(mainFace["methods"]).toContain("getMsgService");
        expect(Array.isArray(mainFace["ownKeys"])).toBe(true);
    });

    it("无 nt_ 前缀 sessionId → 取第一个作主 session", () => {
        const main = fakeSession();
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => new Map([["main", "main_1"]]),
            }),
            getNTWrapperSession: () => main,
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(startup["mainSessionId"]).toBe("main_1");
    });

    it("缺 NodeIQQNTStartupSessionWrapper.create → startup null", () => {
        const ctx = makeCtx();
        const result = probeRuntime(ctx);
        expect(result["startup"]).toBeNull();
    });

    it("create 返回空值（无实例链）→ getNTWrapperSession 候选名兜底", () => {
        // created 为空时 probeCreatedChain 不并入 → out.sessionIds 未定义 → 走候选名兜底
        const ctx = makeCtx({
            startupCreate: () => null,
            getNTWrapperSession: () => fakeSession(),
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(startup["sessionIds"]).toBeUndefined();
        const fallback = startup["getNTWrapperSession"] as Record<string, unknown>;
        expect(Object.keys(fallback).sort()).toEqual([
            "<empty>",
            "default",
            "main",
            "primary",
            "session1",
        ]);
    });

    it("create 失败 → create 面记 error 不炸", () => {
        const ctx = makeCtx({
            startupCreate: () => {
                throw new Error("create boom");
            },
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect((startup["create"] as Record<string, unknown>)["error"]).toContain("create boom");
    });
});

describe("enumerateSessionIds", () => {
    it("getNTWrapperSession 缺失 → enumSessionIds 空", () => {
        const ctx = makeCtx({
            startupCreate: () => ({ start: () => undefined, getSessionIdList: () => new Map() }),
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(startup["enumSessionIds"]).toEqual({});
    });

    it("命中 sessionId（nt_0/gpro_0）记录 getter 存在性与 msgService 调用", () => {
        const ctx = makeCtx({
            startupCreate: () => ({ start: () => undefined, getSessionIdList: () => new Map() }),
            getNTWrapperSession: (id: string) => {
                if (id === "nt_0") {
                    return fakeSession({ sendMsg: () => 0 });
                }
                if (id === "gpro_0") {
                    return { getMsgService: () => null };
                }
                return null;
            },
        });
        const result = probeRuntime(ctx);
        const enumOut = (result["startup"] as Record<string, unknown>)["enumSessionIds"] as Record<
            string,
            unknown
        >;
        const nt0 = enumOut["nt_0"] as Record<string, unknown>;
        expect(nt0["hasMsgServiceGetter"]).toBe(true);
        expect(nt0["msgServiceOk"]).toBe(true);
        expect(nt0["msgServiceMethods"]).toBeGreaterThan(0);
        const gpro0 = enumOut["gpro_0"] as Record<string, unknown>;
        expect(gpro0["msgServiceOk"]).toBe(false);
        // getNTWrapperSession 抛错的 id 不进结果
        expect("nt_1" in enumOut).toBe(false);
    });

    it("getMsgService 抛错 → msgError 记录", () => {
        const ctx = makeCtx({
            startupCreate: () => ({ start: () => undefined, getSessionIdList: () => new Map() }),
            getNTWrapperSession: () => ({
                getMsgService: () => {
                    throw new Error("service boom");
                },
            }),
        });
        const result = probeRuntime(ctx);
        const nt0 = (
            (result["startup"] as Record<string, unknown>)["enumSessionIds"] as Record<
                string,
                unknown
            >
        )["nt_0"] as Record<string, unknown>;
        expect(nt0["msgServiceOk"]).toBe(false);
        expect(nt0["msgError"]).toContain("service boom");
    });
});

describe("probeSession 主目标选择", () => {
    it("own session 存在 → sessionSource=own-create，services 收集（names-only）", () => {
        const ctx = makeCtx({
            session: fakeSession({ sendMsg: () => 0 }),
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => new Map([["nt", "nt_3"]]),
            }),
            getNTWrapperSession: () => fakeSession(),
        });
        const result = probeRuntime(ctx);
        expect(result["sessionSource"]).toBe("own-create");
        const sessionFace = result["session"] as Record<string, unknown>;
        expect(sessionFace["methods"]).toContain("getMsgService");
        const services = result["services"] as Record<string, unknown>;
        // get*Service 命名约定的 getter 才进 services；成功项记录方法面（names-only）
        expect(services["getMsgService"]).toMatchObject({ methods: ["sendMsg"] });
        expect(services["getGroupService"]).toMatchObject({
            methods: ["addKernelGroupListener"],
        });
        // 非 service getter（startNT）不进
        expect("startNT" in services).toBe(false);
        // 落选候选概要（own + main 都存在时记录）
        const alternates = result["sessionAlternates"] as Record<string, unknown>[];
        expect(alternates).toHaveLength(1);
        expect(alternates[0]?.["source"]).toBe("mainSession(getNTWrapperSession)");
    });

    it("无 own session → 回退 mainSession 主目标", () => {
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => new Map([["nt", "nt_3"]]),
            }),
            getNTWrapperSession: () => fakeSession(),
        });
        const result = probeRuntime(ctx);
        expect(result["sessionSource"]).toBe("mainSession");
        expect(result["sessionAlternates"]).toBeUndefined();
    });

    it("service getter 返回 null → 记 null/undefined 错误", () => {
        const ctx = makeCtx({
            session: {
                getMsgService: () => null,
                getGroupService: () => {
                    throw new Error("getter boom");
                },
            },
        });
        const result = probeRuntime(ctx);
        const services = result["services"] as Record<string, unknown>;
        expect(services["getMsgService"]).toMatchObject({
            ok: true,
            error: "null/undefined",
        });
        expect(services["getGroupService"]).toMatchObject({
            ok: false,
            error: "getter boom",
        });
    });
});

describe("落盘与产物", () => {
    it("probeFile 写入 NAPUTO_CFG_DIR，JSON 可读", () => {
        const ctx = makeCtx({ session: fakeSession() });
        const result = probeRuntime(ctx);
        const probeFile = result["probeFile"] as string;
        expect(existsSync(probeFile)).toBe(true);
        const parsed = JSON.parse(readFileSync(probeFile, "utf8")) as Record<string, unknown>;
        expect(parsed["sessionSource"]).toBe("own-create");
        // 顶层产物：exports / engine 方法面
        expect(result["exports"]).toContain("NodeIQQNTWrapperSession");
        expect(result["engineMethods"]).toContain("initWithDeskTopConfig");
        expect(typeof result["timestamp"]).toBe("string");
    });

    it("自定义文件名生效；每次服务收集后增量落盘（persist）", () => {
        const dir = process.env["NAPUTO_CFG_DIR"] ?? "";
        const ctx = makeCtx({
            session: fakeSession({ sendMsg: () => 0 }),
        });
        const result = probeRuntime(ctx, "custom-probe.json");
        expect((result["probeFile"] as string).endsWith("custom-probe.json")).toBe(true);
        expect(existsSync(join(dir, "custom-probe.json"))).toBe(true);
    });

    it("NAPUTO_CFG_DIR 不可写 → probeFileError 不抛", () => {
        process.env["NAPUTO_CFG_DIR"] = join(tmpDirs[0] ?? "", "no-such-dir/forbidden/file");
        // 把 mkdir 目标造成一个文件路径，触发 mkdir 失败
        const blocker = join(tmpDirs[0] ?? tmpdir(), "blocked");
        rmSync(blocker, { force: true });
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(blocker, "not a dir");
        process.env["NAPUTO_CFG_DIR"] = blocker;
        const ctx = makeCtx();
        const result = probeRuntime(ctx);
        expect(typeof result["probeFileError"]).toBe("string");
        expect(result["probeFile"]).toBeUndefined();
    });
});

describe("engine 与 login 探测", () => {
    it("engine 调用成功记方法面，失败记 error", () => {
        const ctx = makeCtx({
            engineMethods: {
                getDeviceInfo: () => ({ deviceName: "d" }),
                getECDHService: () => {
                    throw new Error("ecdh boom");
                },
            },
        });
        const result = probeRuntime(ctx);
        const engineCalls = result["engineCalls"] as Record<string, unknown>;
        const device = engineCalls["getDeviceInfo"] as Record<string, unknown>;
        expect(device["value"]).toEqual({ deviceName: "d" });
        const ecdh = engineCalls["getECDHService"] as Record<string, unknown>;
        expect(ecdh["error"]).toContain("ecdh boom");
    });

    it("LoginService get 缺失 → loginService null；命中记方法面与 getter 形状", () => {
        const ctx = makeCtx({ loginGet: () => null });
        expect(probeRuntime(ctx)["loginService"]).toEqual({ get: "null/undefined" });
        const ctx2 = makeCtx({
            loginGet: () => ({
                getUin: () => "3567141148",
                getAccountInfo: () => null,
            }),
        });
        const login = probeRuntime(ctx2)["loginService"] as Record<string, unknown>;
        expect(login["methods"]).toContain("getUin");
        expect(login["getUin"]).toBe("3567141148");
        expect(login["getAccountInfo"]).toBeNull();
    });
});

describe("startup 边界与异常分支补充", () => {
    it("getSessionIdList 返回非 Map → sessionIds 空，候选名兜底不炸", () => {
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => ({ list: [1, 2] }),
            }),
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(startup["sessionIds"]).toEqual([]);
        // createdGetSessionIdList 记序列化值
        expect(startup["createdGetSessionIdList"]).toBeDefined();
    });

    it("created.start / getSessionIdList 抛错 → 各自记 error", () => {
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => {
                    throw new Error("start refused");
                },
                getSessionIdList: () => {
                    throw new Error("ids refused");
                },
            }),
        });
        const startup = probeRuntime(ctx)["startup"] as Record<string, unknown>;
        expect(startup["start"]).toMatchObject({ error: "start refused" });
        expect(startup["createdGetSessionIdList"]).toMatchObject({ error: "ids refused" });
    });

    it("sessionId Map 值非字符串（数字）→ 退化取键名", () => {
        const main = fakeSession();
        const seenIds: string[] = [];
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => new Map([["nt_9", 42]]),
            }),
            getNTWrapperSession: (id: string) => {
                seenIds.push(id);
                return main;
            },
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(startup["sessionIds"]).toEqual(["nt_9"]);
        expect(seenIds).toContain("nt_9");
    });

    it("getMsgService 抛非 Error 值 → msgError 记字符串化结果", () => {
        const ctx = makeCtx({
            startupCreate: () => ({ start: () => undefined, getSessionIdList: () => new Map() }),
            getNTWrapperSession: () => ({
                getMsgService: () => {
                    throw "raw-msg-crash";
                },
            }),
        });
        const result = probeRuntime(ctx);
        const nt0 = (
            (result["startup"] as Record<string, unknown>)["enumSessionIds"] as Record<
                string,
                unknown
            >
        )["nt_0"] as Record<string, unknown>;
        expect(nt0["msgServiceOk"]).toBe(false);
        expect(nt0["msgError"]).toBe("raw-msg-crash");
    });

    it("getNTWrapperSession 抛错（Error 与非 Error）→ 方法面记 error", () => {
        const ctx = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => new Map([["nt_1", "nt_1"]]),
            }),
            getNTWrapperSession: () => {
                throw new Error("session lookup failed");
            },
        });
        const result = probeRuntime(ctx);
        const startup = result["startup"] as Record<string, unknown>;
        expect(JSON.stringify(startup)).toContain("session lookup failed");

        const ctx2 = makeCtx({
            startupCreate: () => ({
                start: () => undefined,
                getSessionIdList: () => new Map([["nt_1", "nt_1"]]),
            }),
            getNTWrapperSession: () => {
                throw "raw-session-crash";
            },
        });
        const result2 = probeRuntime(ctx2);
        expect(JSON.stringify(result2["startup"])).toContain("raw-session-crash");
    });

    it("NAPUTO_CFG_DIR 未设 → 落盘到 cwd（进程工作目录）", () => {
        const cwdTmp = mkdtempSync(join(tmpdir(), "nk-test-probe-cwd-"));
        tmpDirs.push(cwdTmp);
        delete process.env["NAPUTO_CFG_DIR"];
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdTmp);
        try {
            const result = probeRuntime(makeCtx());
            expect((result["probeFile"] as string).startsWith(cwdTmp)).toBe(true);
        } finally {
            cwdSpy.mockRestore();
        }
    });
});
