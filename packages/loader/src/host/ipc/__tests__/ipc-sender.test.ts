/**
 * ipc-sender.test.ts：sendStatus 快照 + replayStatus 重播单测。
 *
 * enabled / lastStatus 是模块级状态——vi.resetModules + 动态 import 每用例
 * 取全新模块，避免串扰；stdout 用 spy 拦截（enable 后真实写会污染测试输出）。
 */
import { describe, expect, it, vi } from "vitest";

/** 取全新 ipc-sender 模块（隔离模块级 enabled / lastStatus 状态）。 */
async function freshSender(): Promise<typeof import("../ipc-sender.js")> {
    vi.resetModules();
    return await import("../ipc-sender.js");
}

/** 拦截 stdout 写并按行收集（返回收集数组）。 */
function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
    });
    return lines;
}

describe("ipc-sender status 快照与重播", () => {
    it("未 enable（非 IPC 模式）不写 stdout", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.sendStatus("ready");
            sender.replayStatus();
            expect(lines).toHaveLength(0);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it("sendStatus 写 JSON 行，replayStatus 重播同一条", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.enableIpc();
            sender.sendStatus("ready");
            expect(lines).toHaveLength(1);
            sender.replayStatus();
            expect(lines).toHaveLength(2);
            expect(lines[1]).toBe(lines[0]);
            // 内容正确：JSON 行协议（v=1 + type=status + payload.phase）
            expect(JSON.parse(lines[0] as string)).toEqual({
                v: 1,
                type: "status",
                payload: { phase: "ready" },
            });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it("从未发送 status 时 replayStatus 不写", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.enableIpc();
            sender.replayStatus();
            expect(lines).toHaveLength(0);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it("快照随最新 status 更新（booting → ready 重播 ready）", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.enableIpc();
            sender.sendStatus("booting");
            sender.sendStatus("ready");
            sender.replayStatus();
            expect(lines).toHaveLength(3);
            expect(JSON.parse(lines[2] as string)).toEqual({
                v: 1,
                type: "status",
                payload: { phase: "ready" },
            });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it("failed 携带 message/error 时快照完整保留", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.enableIpc();
            sender.sendStatus("failed", "登录失败", { code: "NOT_LOGIN", message: "登录失败" });
            sender.replayStatus();
            expect(JSON.parse(lines[1] as string)).toEqual({
                v: 1,
                type: "status",
                payload: {
                    phase: "failed",
                    message: "登录失败",
                    error: { code: "NOT_LOGIN", message: "登录失败" },
                },
            });
        } finally {
            vi.restoreAllMocks();
        }
    });
});

describe("lastIpcStatusPhase / shouldSendGenericBootFailed（引导失败决策）", () => {
    it("从未发送 status 时 lastIpcStatusPhase 为 null", async () => {
        const sender = await freshSender();
        expect(sender.lastIpcStatusPhase()).toBeNull();
    });

    it("lastIpcStatusPhase 跟随最新 phase（未 enable 也更新快照）", async () => {
        const sender = await freshSender();
        sender.sendStatus("booting");
        expect(sender.lastIpcStatusPhase()).toBe("booting");
        sender.sendStatus("failed", "登录失败", { code: "NOT_LOGIN", message: "登录失败" });
        expect(sender.lastIpcStatusPhase()).toBe("failed");
    });

    it("非 IPC 模式（ipcMode=false）恒不补发通用 failed", async () => {
        const sender = await freshSender();
        expect(sender.shouldSendGenericBootFailed(false, null)).toBe(false);
        expect(sender.shouldSendGenericBootFailed(false, "booting")).toBe(false);
        expect(sender.shouldSendGenericBootFailed(false, "ready")).toBe(false);
    });

    it("IPC 模式且最近非 failed → 补发通用 failed", async () => {
        const sender = await freshSender();
        expect(sender.shouldSendGenericBootFailed(true, null)).toBe(true);
        expect(sender.shouldSendGenericBootFailed(true, "booting")).toBe(true);
        expect(sender.shouldSendGenericBootFailed(true, "logging")).toBe(true);
    });

    it("IPC 模式但最近已 failed → 不覆盖更具体的错误码", async () => {
        const sender = await freshSender();
        expect(sender.shouldSendGenericBootFailed(true, "failed")).toBe(false);
    });
});

describe("其余 IPC 消息 wire 格式（登录/二维码/事件/日志/动作响应/心跳）", () => {
    it("sendLogin：state/selfInfo/message 条件展开", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.enableIpc();
            sender.sendLogin("logged_in", { uin: "10001", uid: "u1", nick: "甲" });
            sender.sendLogin("failed", undefined, "登录失败");
            sender.sendLogin("waiting_scan");
            expect(lines).toHaveLength(3);
            expect(JSON.parse(lines[0] as string)).toEqual({
                v: 1,
                type: "login",
                payload: { state: "logged_in", selfInfo: { uin: "10001", uid: "u1", nick: "甲" } },
            });
            expect(JSON.parse(lines[1] as string)).toEqual({
                v: 1,
                type: "login",
                payload: { state: "failed", message: "登录失败" },
            });
            expect(JSON.parse(lines[2] as string)).toEqual({
                v: 1,
                type: "login",
                payload: { state: "waiting_scan" },
            });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it("sendQr / sendEvent / sendLog / sendResult / sendPong / sendPing wire", async () => {
        const sender = await freshSender();
        const lines = captureStdout();
        try {
            sender.enableIpc();
            sender.sendQr("cG5n", "https://qr.example/x");
            sender.sendEvent("Msg", "onRecvMsg", [{ msgId: "m1" }]);
            sender.sendLog("warn", "告警文本");
            sender.sendResult(3, { ok: true, value: 1 });
            sender.sendPong();
            sender.sendPing();
            const parsed = lines.map((l) => JSON.parse(l as string) as Record<string, unknown>);
            expect(parsed[0]).toMatchObject({
                type: "qr",
                payload: { pngBase64: "cG5n", qrcodeUrl: "https://qr.example/x" },
            });
            expect(parsed[1]).toMatchObject({
                type: "event",
                payload: { service: "Msg", name: "onRecvMsg", args: [{ msgId: "m1" }] },
            });
            expect(parsed[2]).toMatchObject({
                type: "log",
                payload: { level: "warn", message: "告警文本" },
            });
            expect(parsed[3]).toMatchObject({
                type: "result",
                id: 3,
                payload: { ok: true, value: 1 },
            });
            expect(parsed[4]).toMatchObject({ type: "pong" });
            expect(parsed[5]).toMatchObject({ type: "ping" });
        } finally {
            vi.restoreAllMocks();
        }
    });

    it("stdout 写异常 → 静默（不阻塞引导）", async () => {
        const sender = await freshSender();
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
            throw new Error("EPIPE");
        });
        try {
            sender.enableIpc();
            expect(() => sender.sendStatus("ready")).not.toThrow();
            expect(() => sender.sendPing()).not.toThrow();
        } finally {
            spy.mockRestore();
        }
    });
});
