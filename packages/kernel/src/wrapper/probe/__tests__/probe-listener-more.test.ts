// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * probe-listener.ts 扩展测试（基线之外的方法选取与失败分支）：
 *  - findAddMethod：精确名 addKernel<简称>Listener 优先（2026-11-01 首录 bug：
 *    MsgService 有 5 个 add*Listener，正则按字母序误选 ImportTool）→ 回退正则
 *  - findRemoveMethod：精确名 / 正则 / 缺失
 *  - recordService 分支：getter 非函数 / 服务 null / add 非函数 / getter 抛错
 *  - attachRecordingListener：无 add 方法 / add 方法非函数
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../../wrapper-loader.js";
import { startListenerRecording } from "../probe-listener.js";

const tmpDirs: string[] = [];
let savedCfgDir: string | undefined;

beforeEach(() => {
    savedCfgDir = process.env["NAPUTO_CFG_DIR"];
    const dir = mkdtempSync(join(tmpdir(), "nk-test-listener-"));
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

/** 构造 ctx（session / exports 覆写）。 */
function makeCtx(session: unknown, loginService?: unknown): WrapperContext {
    return {
        exports: {
            NodeIKernelLoginService: { get: () => loginService ?? null },
        } as unknown as WrapperContext["exports"],
        engine: {} as unknown as WrapperContext["engine"],
        versionInfo: { fullVersion: "9.9.33", buildVersion: "52230" },
        session: session as WrapperContext["session"],
        startupSession: null,
        loginService: null,
    } as unknown as WrapperContext;
}

describe("add 方法选取（精确名优先）", () => {
    it("addKernelMsgImportToolListener 存在时不误选——精确名 addKernelMsgListener 优先", () => {
        // 2026-11-01 首录实锤的 bug 回归：正则按字母序会选中 ImportTool
        const addCalls: string[] = [];
        const msgService = {
            addKernelMsgImportToolListener: vi.fn(() => 99),
            addKernelMsgListener: vi.fn(() => {
                addCalls.push("addKernelMsgListener");
                return 1;
            }),
            removeKernelMsgListener: vi.fn(),
        };
        const ctx = makeCtx({ getMsgService: () => msgService }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({ ok: true, listenerId: 1 });
        expect(msgService.addKernelMsgListener).toHaveBeenCalled();
        expect(msgService.addKernelMsgImportToolListener).not.toHaveBeenCalled();
    });

    it("无精确名时回退正则（裸 addListener）", () => {
        const bareService = {
            addListener: vi.fn(() => 7),
            removeListener: vi.fn(),
        };
        const ctx = makeCtx({ getBdhUploadService: () => bareService }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["BdhUpload"]).toMatchObject({ ok: true, listenerId: 7 });
        expect(bareService.addListener).toHaveBeenCalled();
        const lines = readFileSync(result.file, "utf8").trim().split("\n");
        const registered = lines
            .map((l) => JSON.parse(l) as { event: string; args: unknown[] })
            .find((r) => r.event === "<registered>" && r.args[0] !== null);
        expect(registered).toBeDefined();
        const addArg = registered?.args?.[0] as Record<string, unknown> | undefined;
        expect(addArg?.["addMethod"]).toBe("addListener");
    });
});

describe("remove 方法选取（registered 事件记录）", () => {
    it("精确名 removeKernel<简称>Listener 优先；缺失记 null", () => {
        const service = {
            addKernelMsgListener: vi.fn(() => 1),
            removeKernelMsgListener: vi.fn(),
        };
        const ctx = makeCtx({ getMsgService: () => service }, null);
        const result = startListenerRecording(ctx);
        const lines = readFileSync(result.file, "utf8").trim().split("\n");
        const reg = lines
            .map((l) => JSON.parse(l) as { event: string; service: string; args: unknown[] })
            .find((r) => r.event === "<registered>" && r.service === "Msg");
        const removeArg = reg?.args?.[0] as Record<string, unknown> | undefined;
        expect(removeArg?.["removeMethod"]).toBe("removeKernelMsgListener");

        const service2 = { addKernelMsgListener: vi.fn(() => 1) };
        const ctx2 = makeCtx({ getMsgService: () => service2 }, null);
        const result2 = startListenerRecording(ctx2);
        const reg2 = readFileSync(result2.file, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { event: string; service: string; args: unknown[] })
            .find((r) => r.event === "<registered>" && r.service === "Msg");
        const removeArg2 = reg2?.args?.[0] as Record<string, unknown> | undefined;
        expect(removeArg2?.["removeMethod"]).toBeNull();
    });
});

describe("recordService 失败分支", () => {
    it("getter 非函数（属性存在但不是方法）→ 记 typeof", () => {
        const ctx = makeCtx({ getMsgService: 42 }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({
            ok: false,
            error: "getter 缺失（typeof=number）",
        });
    });

    it("服务实例为 null → 记 null/undefined", () => {
        const ctx = makeCtx({ getMsgService: () => null }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({ ok: false, error: "null/undefined" });
    });

    it("getter 抛错 → 记错误消息", () => {
        const ctx = makeCtx(
            {
                getMsgService: () => {
                    throw new Error("service crash");
                },
            },
            null,
        );
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({ ok: false, error: "service crash" });
    });

    it("服务无 add*Listener 方法 → 记无方法", () => {
        const ctx = makeCtx({ getMsgService: () => ({ sendMsg: () => 0 }) }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({
            ok: false,
            error: "无 add*Listener 方法",
        });
    });

    it("add 方法非函数（正则命中但值非函数）→ 记非函数", () => {
        const ctx = makeCtx({ getMsgService: () => ({ addKernelMsgListener: 42 }) }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({
            ok: false,
            error: "addKernelMsgListener 非函数",
        });
    });

    it("listenerId 非数值（如对象）不进摘要 listenerId 键", () => {
        const service = { addKernelMsgListener: vi.fn(() => "not-a-number") };
        const ctx = makeCtx({ getMsgService: () => service }, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({ ok: true });
        expect("listenerId" in (result.registered["Msg"] ?? {})).toBe(false);
    });
});

describe("recordLoginService 分支", () => {
    it("ctor undefined → 记缺失", () => {
        const ctx = makeCtx(null);
        (ctx.exports as unknown as Record<string, unknown>)["NodeIKernelLoginService"] = undefined;
        const result = startListenerRecording(ctx);
        expect(result.registered["Login"]).toMatchObject({
            ok: false,
            error: "NodeIKernelLoginService.get 缺失",
        });
    });

    it("get() 抛错 → 记错误", () => {
        const ctx = makeCtx(null);
        (ctx.exports as unknown as Record<string, unknown>)["NodeIKernelLoginService"] = {
            get: () => {
                throw new Error("login boom");
            },
        };
        const result = startListenerRecording(ctx);
        expect(result.registered["Login"]).toMatchObject({ ok: false, error: "login boom" });
    });

    it("loginService null → 记 null/undefined", () => {
        const ctx = makeCtx(null, null);
        const result = startListenerRecording(ctx);
        expect(result.registered["Login"]).toMatchObject({ ok: false, error: "null/undefined" });
    });

    it("loginService 无 add 方法 → 记无方法", () => {
        const ctx = makeCtx(null, { getUin: () => "1" });
        const result = startListenerRecording(ctx);
        expect(result.registered["Login"]).toMatchObject({
            ok: false,
            error: "无 add*Listener 方法",
        });
    });
});

describe("录制边界补充", () => {
    it("has 陷阱：字符串键记录 <has>，Symbol 键不记录", () => {
        const capturedRef: { listener?: Record<string | symbol, unknown> } = {};
        const msgService = {
            addKernelMsgListener: vi.fn((listener: unknown) => {
                capturedRef.listener = listener as Record<string | symbol, unknown>;
                return 1;
            }),
        };
        const ctx = makeCtx({ getMsgService: () => msgService }, null);
        const result = startListenerRecording(ctx);
        const captured = capturedRef.listener;
        if (captured === undefined) {
            throw new Error("listener 未被捕获");
        }
        // 字符串 prop 触发 <has> 记录；Symbol prop 不触发（typeof 检查）
        void ("onRecvMsg" in captured);
        void (Symbol.for("nk-symbol-probe") in captured);
        const lines = readFileSync(result.file, "utf8").trim().split("\n");
        const hasLines = lines.filter((l) => l.includes("<has>"));
        expect(hasLines.some((l) => l.includes("onRecvMsg"))).toBe(true);
        expect(hasLines.some((l) => l.includes("nk-symbol-probe"))).toBe(false);
    });

    it("getter 抛非 Error 值 → 记字符串化结果", () => {
        const ctx = makeCtx(
            {
                getMsgService: () => {
                    throw "raw-getter-crash";
                },
            },
            null,
        );
        const result = startListenerRecording(ctx);
        expect(result.registered["Msg"]).toMatchObject({ ok: false, error: "raw-getter-crash" });
    });

    it("LoginService get 抛非 Error 值 → 记字符串化结果", () => {
        const ctx = makeCtx(null, null);
        (ctx.exports as unknown as Record<string, unknown>)["NodeIKernelLoginService"] = {
            get: () => {
                throw "raw-login-crash";
            },
        };
        const result = startListenerRecording(ctx);
        expect(result.registered["Login"]).toMatchObject({ ok: false, error: "raw-login-crash" });
    });

    it("NAPUTO_CFG_DIR 未设 → 产物落 cwd（进程工作目录）", () => {
        const cwdTmp = mkdtempSync(join(tmpdir(), "nk-test-listener-cwd-"));
        tmpDirs.push(cwdTmp);
        delete process.env["NAPUTO_CFG_DIR"];
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdTmp);
        try {
            const result = startListenerRecording(makeCtx(null, null));
            expect(result.file.startsWith(cwdTmp)).toBe(true);
        } finally {
            cwdSpy.mockRestore();
        }
    });
});
