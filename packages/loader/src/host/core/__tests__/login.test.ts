/**
 * login.test.ts：登录流程单测（login.ts pickLoginAccount / doLogin 全分支）。
 *
 * 覆盖：
 *  - pickLoginAccount：列表打印与目标选择（forcedUin 优先 / isQuickLogin 默认 /
 *    首个账号兜底）、指定账号不在列表、空列表（boot 阶段未 initConfig）、
 *    listLoginAccounts 抛错吞掉
 *  - doLogin：快速登录成功；快速登录失败 → qrFallback 回退成功；QR 也失败 → null；
 *    core.login 返回 null 透传
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreContextLike, KernelLike } from "../../types.js";
import { doLogin, pickLoginAccount } from "../login.js";

/** log 收集器（vi.mock host/util）。 */
const h = vi.hoisted(() => {
    return { logs: [] as string[] };
});

vi.mock("../../util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../util.js")>();
    return {
        ...actual,
        log: (msg: string) => {
            h.logs.push(msg);
        },
    };
});

beforeEach(() => {
    h.logs.length = 0;
});

/** 最小 ctx。 */
function ctx(loginService?: CoreContextLike["loginService"]): CoreContextLike {
    return loginService === undefined ? { session: {} } : { session: {}, loginService };
}

/** kernel 桩（可注入账号列表与抛错）。 */
function kernelOf(
    accounts: Array<{ uin: string; nickName?: string; isQuickLogin?: boolean }> | Error,
): KernelLike {
    return {
        listLoginAccounts: () =>
            accounts instanceof Error ? Promise.reject(accounts) : Promise.resolve(accounts),
    } as unknown as KernelLike;
}

describe("pickLoginAccount", () => {
    const accounts = [
        { uin: "10001", nickName: "甲", isQuickLogin: false },
        { uin: "20002", nickName: "乙", isQuickLogin: true },
        { uin: "30003" },
    ];

    it("有列表：打印横幅，自动选第一个可快速登录账号", async () => {
        const ref = { targetUin: undefined };
        await pickLoginAccount(kernelOf(accounts), ctx(), ref);
        expect(ref.targetUin).toBe("20002");
        expect(h.logs.some((l) => l.includes("可用于快速登录 of QQ（3 个）"))).toBe(true);
        expect(h.logs.some((l) => l.includes("1. 10001 甲"))).toBe(true);
        expect(h.logs.some((l) => l.includes("2. 20002 乙（默认）"))).toBe(true);
        expect(h.logs.some((l) => l.includes("3. 30003 30003"))).toBe(true);
        expect(h.logs.some((l) => l.includes("正在快速登录 20002"))).toBe(true);
    });

    it("forcedUin 优先命中列表", async () => {
        const ref = { targetUin: undefined };
        await pickLoginAccount(kernelOf(accounts), ctx(), ref, "30003");
        expect(ref.targetUin).toBe("30003");
        expect(h.logs.some((l) => l.includes("正在快速登录 30003"))).toBe(true);
    });

    it("forcedUin 不在列表 → 不设目标，留提示（登录流程将报错）", async () => {
        const ref = { targetUin: undefined };
        await pickLoginAccount(kernelOf(accounts), ctx(), ref, "99999");
        expect(ref.targetUin).toBeUndefined();
        expect(h.logs.some((l) => l.includes("指定账号 99999 不在登录列表"))).toBe(true);
    });

    it("无 isQuickLogin 项 → 自动选第一个账号", async () => {
        const ref = { targetUin: undefined };
        await pickLoginAccount(kernelOf([{ uin: "10001" }, { uin: "20002" }]), ctx(), ref);
        expect(ref.targetUin).toBe("10001");
    });

    it("空列表（boot 阶段未 initConfig）→ 账号选择交给登录流程", async () => {
        const ref = { targetUin: undefined };
        await pickLoginAccount(kernelOf([]), ctx(), ref);
        expect(ref.targetUin).toBeUndefined();
        expect(h.logs.some((l) => l.includes("登录列表暂不可用"))).toBe(true);
    });

    it("listLoginAccounts 抛错 → 吞掉记日志（不阻塞登录）", async () => {
        const ref = { targetUin: undefined };
        await pickLoginAccount(kernelOf(new Error("服务未就绪")), ctx(), ref);
        expect(ref.targetUin).toBeUndefined();
        expect(h.logs.some((l) => l.includes("获取登录列表失败") && l.includes("服务未就绪"))).toBe(
            true,
        );
    });
});

describe("doLogin", () => {
    /** 可编程 core.login（按调用次序出队行为）。 */
    function coreOf(behaviors: Array<"ok" | "null" | Error>): {
        core: Parameters<typeof doLogin>[0];
        loginCalls: Record<string, unknown>[];
    } {
        const loginCalls: Record<string, unknown>[] = [];
        const queue = [...behaviors];
        const core = {
            login: (opts: Record<string, unknown>) => {
                loginCalls.push(opts);
                const behavior = queue.shift();
                if (behavior === "ok") {
                    return Promise.resolve({ uin: "10001", uid: "u1", nick: "甲" });
                }
                if (behavior === "null") {
                    return Promise.resolve(null);
                }
                if (behavior instanceof Error) {
                    return Promise.reject(behavior);
                }
                return Promise.reject(new Error("未配置行为"));
            },
        } as unknown as Parameters<typeof doLogin>[0];
        return { core, loginCalls };
    }

    it("快速登录成功 → 直接返回结果（不走 QR 回退）", async () => {
        const { core, loginCalls } = coreOf(["ok"]);
        const result = await doLogin(core, { appid: 537376818 });
        expect(result).toEqual({ uin: "10001", uid: "u1", nick: "甲" });
        expect(loginCalls).toHaveLength(1);
        expect(loginCalls[0]).toEqual({ appid: 537376818 });
    });

    it("快速登录失败 → qrFallback 重试成功（opts 展开）", async () => {
        const { core, loginCalls } = coreOf([new Error("连接异常"), "ok"]);
        const result = await doLogin(core, { appid: 1, quickUin: "10001" });
        expect(result).toEqual({ uin: "10001", uid: "u1", nick: "甲" });
        expect(loginCalls).toHaveLength(2);
        expect(loginCalls[1]).toEqual({ appid: 1, quickUin: "10001", qrFallback: true });
        expect(h.logs.some((l) => l.includes("快速登录失败") && l.includes("连接异常"))).toBe(true);
        expect(h.logs.some((l) => l.includes("尝试 QR 登录"))).toBe(true);
    });

    it("QR 回退也失败 → null（不抛出）", async () => {
        const { core } = coreOf([new Error("风控"), new Error("二维码超时")]);
        const result = await doLogin(core, {});
        expect(result).toBeNull();
        expect(h.logs.some((l) => l.includes("QR 登录也失败") && l.includes("二维码超时"))).toBe(
            true,
        );
    });

    it("core.login 返回 null → 透传 null（不触发 QR 回退）", async () => {
        const { core, loginCalls } = coreOf(["null"]);
        const result = await doLogin(core, {});
        expect(result).toBeNull();
        expect(loginCalls).toHaveLength(1);
    });
});
