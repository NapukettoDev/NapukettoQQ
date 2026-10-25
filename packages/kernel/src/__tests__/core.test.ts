/**
 * core.test.ts：NapukettoCore 装配/登录编排单测（2026-10-25 覆盖补强）。
 *
 * quickLogin / QrLoginSession / startNapuketto 注入假实现（vi.mock），覆盖：
 * create 装配（目录 + 文件日志）、未装配 wrapper 登录拒绝、attachWrapper、
 * 快速登录成功（参数透传）/失败（qrFallback 开关）、QR 回退与强制扫码
 * （假状态机出码/扫码/失败）、登录进度转发（waiting_scan/failed 附原因）、
 * 二维码 png 写盘、refreshQr 句柄、requireQrSelfInfo 空值拒绝、setSession、
 * loginService.initConfig 装配链。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 假 QR 会话（vi.hoisted：vi.mock 工厂提升后仍可引用）
const { FakeQrSession } = vi.hoisted(() => {
    class FakeQrSession {
        static instances: FakeQrSession[] = [];
        qrHandlers: Array<(qr: unknown) => void> = [];
        stateHandlers: Array<(state: string) => void> = [];
        selfInfo: { uin: string; uid: string; nick: string } | null = null;
        failureReason: string | null = null;
        started = false;
        stopped = false;
        refreshCount = 0;
        constructor() {
            FakeQrSession.instances.push(this);
        }
        onQrCode(cb: (qr: unknown) => void): () => void {
            this.qrHandlers.push(cb);
            return () => {
                // 退订桩（测试内无退订需求）
            };
        }
        onStateChange(cb: (state: string) => void): () => void {
            this.stateHandlers.push(cb);
            return () => {
                // 退订桩（测试内无退订需求）
            };
        }
        start(): void {
            this.started = true;
        }
        stop(): void {
            this.stopped = true;
        }
        refresh(): void {
            this.refreshCount += 1;
        }
        emitState(state: string): void {
            for (const cb of [...this.stateHandlers]) {
                cb(state);
            }
        }
        emitQr(qr: unknown): void {
            for (const cb of [...this.qrHandlers]) {
                cb(qr);
            }
        }
    }
    // biome-ignore lint/style/useNamingConvention: 键须与 hoisted 变量名一致
    return { FakeQrSession };
});

vi.mock("../login/index.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    // biome-ignore lint/style/useNamingConvention: 覆写 kernel 导出名（类导出为 PascalCase）
    return { ...actual, QrLoginSession: FakeQrSession, quickLogin: vi.fn() };
});

vi.mock("../wrapper/wrapper-loader.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, startNapuketto: vi.fn() };
});

import { type LoginProgress, NapukettoCore } from "../core.js";
import type { LoginResult } from "../login/index.js";
import { quickLogin } from "../login/index.js";
import type { WrapperContext } from "../wrapper/wrapper-loader.js";
import { startNapuketto } from "../wrapper/wrapper-loader.js";

const quickLoginMock = vi.mocked(quickLogin);
const startNapukettoMock = vi.mocked(startNapuketto);

let tmp = "";

function freshRoot(): string {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-core-test-"));
    return tmp;
}

afterEach(() => {
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
    quickLoginMock.mockReset();
    startNapukettoMock.mockReset();
    FakeQrSession.instances.length = 0;
});

/** 建已装配 wrapper 的 core（loginService 空对象：QR 可用，initConfig 走 warn 跳过）。 */
function attachedCore(): { core: NapukettoCore; wrapper: WrapperContext } {
    const core = NapukettoCore.create({ paths: { dataRoot: freshRoot() }, consoleLog: false });
    const wrapper = {
        session: null,
        loginService: {},
        engine: {},
        exports: {},
        versionInfo: { fullVersion: "9.9.9-12345" },
    } as unknown as WrapperContext;
    startNapukettoMock.mockReturnValueOnce(wrapper);
    const attached = core.attachWrapper({} as never, { qqVersion: "9.9.9", dataDir: tmp } as never);
    return { core, wrapper: attached };
}

/** 假 QR 会话实例类型（vi.hoisted 值的类型侧）。 */
type FakeQrSessionInstance = InstanceType<typeof FakeQrSession>;

/** 取唯一假会话（未创建即断言失败，替代裸索引的 undefined 收窄）。 */
function onlySession(): FakeQrSessionInstance {
    const session = FakeQrSession.instances.at(-1);
    if (session === undefined) {
        throw new Error("假 QR 会话未创建（登录未进入 QR 路径）");
    }
    return session;
}

/** 推进假 QR 会话到登录成功。 */
function qrLoginSucceed(session: FakeQrSessionInstance): void {
    session.emitQr({ pngBase64: "", qrcodeUrl: "https://qq.example/qr" });
    session.selfInfo = { uin: "20002", uid: "uid-2", nick: "QR 党" };
    session.emitState("logged_in");
}

describe("NapukettoCore.create / attachWrapper", () => {
    it("create 装配：目录建立 + 文件日志落盘 + ctx 初始态", () => {
        const root = freshRoot();
        const core = NapukettoCore.create({ paths: { dataRoot: root }, consoleLog: false });
        expect(existsSync(join(root, "logs"))).toBe(true);
        expect(existsSync(join(root, "config"))).toBe(true);
        core.ctx.logger.info("core-test-hello");
        const logText = readFileSync(join(root, "logs", "napuketto.log"), "utf8");
        expect(logText).toContain("core-test-hello");
        expect(core.ctx.wrapper).toBeNull();
        expect(core.ctx.login).toBeNull();
    });

    it("attachWrapper：startNapuketto 结果挂 ctx.wrapper 并返回", () => {
        const { core, wrapper } = attachedCore();
        expect(startNapukettoMock).toHaveBeenCalledOnce();
        expect(core.ctx.wrapper).toBe(wrapper);
        expect(wrapper).toBe(wrapper);
    });

    it("setSession：未装配时拒绝；装配后写入 wrapper.session", () => {
        const bare = NapukettoCore.create({ paths: { dataRoot: freshRoot() }, consoleLog: false });
        expect(() => bare.setSession({} as never)).toThrow(/wrapper 未装配/);
        const { core, wrapper } = attachedCore();
        core.setSession({ mark: 1 } as never);
        expect((wrapper as { session: unknown }).session).toEqual({ mark: 1 });
    });
});

describe("NapukettoCore.login 快速登录路径", () => {
    it("未装配 wrapper 登录直接拒绝（INVALID_STATE）", async () => {
        const core = NapukettoCore.create({ paths: { dataRoot: freshRoot() }, consoleLog: false });
        await expect(core.login({ appid: "537" })).rejects.toThrow(/wrapper 未装配/);
    });

    it("快速登录成功：quickUin/超时透传，ctx.login 填充", async () => {
        const { core } = attachedCore();
        quickLoginMock.mockResolvedValueOnce({
            uin: "10001",
            uid: "uid-1",
            nick: "睦",
        } as LoginResult);
        const result = await core.login({
            appid: "537",
            quickUin: "10001",
            quickLoginTimeoutMs: 1234,
        });
        expect(result.uin).toBe("10001");
        expect(core.ctx.login?.uin).toBe("10001");
        const opts = quickLoginMock.mock.calls[0]?.[1] as {
            uin?: string;
            quickLoginTimeoutMs?: number;
        };
        expect(opts.uin).toBe("10001");
        expect(opts.quickLoginTimeoutMs).toBe(1234);
    });

    it("未指定 quickUin 时快速登录参数为空对象", async () => {
        const { core } = attachedCore();
        quickLoginMock.mockResolvedValueOnce({
            uin: "10001",
            uid: "uid-1",
            nick: "",
        } as LoginResult);
        await core.login({ appid: "537" });
        const opts = quickLoginMock.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(Object.keys(opts)).toEqual([]);
    });

    it("快速登录失败且未开 qrFallback：原样抛出", async () => {
        const { core } = attachedCore();
        quickLoginMock.mockRejectedValueOnce(new Error("快速登录失败: 挂起"));
        await expect(core.login({ appid: "537" })).rejects.toThrow("快速登录失败: 挂起");
    });
});

describe("NapukettoCore.login QR 路径", () => {
    it("qrFallback 回退：出码进度转发 → 扫码成功返回 selfInfo → 会话收尾", async () => {
        const { core } = attachedCore();
        quickLoginMock.mockRejectedValueOnce(new Error("快速登录失败: 挂起"));
        const progress: LoginProgress[] = [];
        const loginPromise = core.login({
            appid: "537",
            qrFallback: true,
            onLoginProgress: (p) => {
                progress.push(p);
            },
        });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        const session = onlySession();
        expect(session.started).toBe(true);
        qrLoginSucceed(session);
        const result = await loginPromise;
        expect(result.uin).toBe("20002");
        expect(result.nick).toBe("QR 党");
        expect(session.stopped).toBe(true);
        expect(core.ctx.login?.uin).toBe("20002");
        const scan = progress.find((p) => p.state === "waiting_scan");
        expect(scan?.qr?.qrcodeUrl).toBe("https://qq.example/qr");
    });

    it("qrOnly：跳过快速登录直接 QR，quickLogin 不被调用", async () => {
        const { core } = attachedCore();
        const loginPromise = core.login({ appid: "537", qrOnly: true });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        qrLoginSucceed(onlySession());
        const result = await loginPromise;
        expect(result.uin).toBe("20002");
        expect(quickLoginMock).not.toHaveBeenCalled();
    });

    it("QR failed 状态：登录失败 + 进度附 failureReason", async () => {
        const { core } = attachedCore();
        quickLoginMock.mockRejectedValueOnce(new Error("快速登录失败: 挂起"));
        const progress: LoginProgress[] = [];
        const loginPromise = core.login({
            appid: "537",
            qrFallback: true,
            onLoginProgress: (p) => {
                progress.push(p);
            },
        });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        const session = onlySession();
        session.failureReason = "登录超时，请刷新页面重试";
        session.emitState("failed");
        await expect(loginPromise).rejects.toThrow("QR 登录失败");
        expect(session.stopped).toBe(true);
        const failed = progress.find((p) => p.state === "failed");
        expect(failed?.message).toBe("登录超时，请刷新页面重试");
    });

    it("非 failed 状态进度不带 message 键", async () => {
        const { core } = attachedCore();
        const progress: LoginProgress[] = [];
        const loginPromise = core.login({
            appid: "537",
            qrOnly: true,
            onLoginProgress: (p) => {
                progress.push(p);
            },
        });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        onlySession().emitState("scanned");
        qrLoginSucceed(onlySession());
        await loginPromise;
        const scanned = progress.find((p) => p.state === "scanned");
        expect(scanned).toBeDefined();
        expect("message" in (scanned ?? {})).toBe(false);
    });

    it("logged_in 但 selfInfo 为空：按 INVALID_STATE 拒绝", async () => {
        const { core } = attachedCore();
        const loginPromise = core.login({ appid: "537", qrOnly: true });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        onlySession().emitState("logged_in");
        await expect(loginPromise).rejects.toThrow(/selfInfo 为空/);
    });

    it("pngBase64 非空时二维码写盘（qrCodePath 显式指定）", async () => {
        const { core } = attachedCore();
        const qrPath = join(freshRoot(), "qr.png");
        const loginPromise = core.login({ appid: "537", qrOnly: true, qrCodePath: qrPath });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        const session = onlySession();
        session.emitQr({ pngBase64: Buffer.from("png-bytes").toString("base64"), qrcodeUrl: "u" });
        qrLoginSucceed(session);
        await loginPromise;
        expect(readFileSync(qrPath, "utf8")).toBe("png-bytes");
    });
});

describe("NapukettoCore.refreshQr", () => {
    it("扫码期间刷新直达会话；登录结束后句柄清空", async () => {
        const { core } = attachedCore();
        expect(core.refreshQr()).toBe(false);
        const loginPromise = core.login({ appid: "537", qrOnly: true });
        await vi.waitFor(() => expect(FakeQrSession.instances.length).toBe(1));
        const session = onlySession();
        expect(core.refreshQr()).toBe(true);
        expect(session.refreshCount).toBe(1);
        qrLoginSucceed(session);
        await loginPromise;
        expect(core.refreshQr()).toBe(false);
    });
});

describe("loginService.initConfig 装配链", () => {
    it("loginService 可用时 initConfig 收到登录握手配置", async () => {
        const core = NapukettoCore.create({ paths: { dataRoot: freshRoot() }, consoleLog: false });
        const initConfig = vi.fn();
        const wrapper = {
            session: null,
            loginService: { initConfig },
            engine: {},
            exports: {},
            versionInfo: { fullVersion: "9.9.9-12345" },
        } as unknown as WrapperContext;
        startNapukettoMock.mockReturnValueOnce(wrapper);
        core.attachWrapper({} as never, { qqVersion: "9.9.9", dataDir: tmp } as never);
        quickLoginMock.mockResolvedValueOnce({
            uin: "10001",
            uid: "uid-1",
            nick: "",
        } as LoginResult);
        await core.login({ appid: "537" });
        expect(initConfig).toHaveBeenCalledOnce();
    });
});
