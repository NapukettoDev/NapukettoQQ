/**
 * server.test.ts：IPC 服务端单测。
 *
 *  - handleControl：控制指令分派（纯函数，mock 回调）
 *  - startIpcServer：用 PassThrough 提供物理行。action 行 → result 响应、
 *    ping → pong、control 各指令、非法行忽略、心跳定时发送、stop 清理。
 *    stdout spy 捕获 JSON 行（enableIpc 后走真实 sender）。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { encodeIpcMessage } from "../codec.js";
import { enableIpc, sendStatus } from "../sender.js";
import { handleControl, startIpcServer } from "../server.js";

describe("handleControl", () => {
    it("stop → onExit", () => {
        const onExit = vi.fn();
        handleControl({ command: "stop" }, onExit);
        expect(onExit).toHaveBeenCalledOnce();
    });

    it("restart → onExit", () => {
        const onExit = vi.fn();
        handleControl({ command: "restart" }, onExit);
        expect(onExit).toHaveBeenCalledOnce();
    });

    it("login qr=true → onLogin { qr: true }（强制扫码）", () => {
        const onLogin = vi.fn();
        handleControl({ command: "login", qr: true }, vi.fn(), onLogin);
        expect(onLogin).toHaveBeenCalledWith({ qr: true });
    });

    it("login uin → onLogin { uin }（指定账号）", () => {
        const onLogin = vi.fn();
        handleControl({ command: "login", uin: "3567141148" }, vi.fn(), onLogin);
        expect(onLogin).toHaveBeenCalledWith({ uin: "3567141148" });
    });

    it("login 无参数 → onLogin {}", () => {
        const onLogin = vi.fn();
        handleControl({ command: "login" }, vi.fn(), onLogin);
        expect(onLogin).toHaveBeenCalledWith({});
    });

    it("login 未提供 onLogin → 不抛（忽略）", () => {
        expect(() => handleControl({ command: "login" }, vi.fn())).not.toThrow();
    });

    it("status → 不触发 onExit，重播最近一条 status（stdout 拦截验证）", () => {
        const onExit = vi.fn();
        const lines: string[] = [];
        const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            lines.push(String(chunk));
            return true;
        });
        try {
            enableIpc();
            sendStatus("sessioning", "装配中");
            const sentBefore = lines.length;
            handleControl({ command: "status" }, onExit);
            expect(onExit).not.toHaveBeenCalled();
            expect(lines).toHaveLength(sentBefore + 1);
            expect(lines.at(-1)).toBe(lines[sentBefore]); // 重播内容与原条一致
        } finally {
            write.mockRestore();
        }
    });
});

describe("startIpcServer", () => {
    /** 动作表（最简单可断言 handler）。 */
    function actions(): Map<string, (params: Record<string, unknown>) => Promise<unknown>> {
        return new Map([["self.get", async () => ({ uin: "10001" })]]);
    }

    /** stdout 捕获。 */
    function capture(): { chunks: string[]; restore(): void } {
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            chunks.push(String(chunk));
            return true;
        });
        return { chunks, restore: () => spy.mockRestore() };
    }

    it("action 行 → 动作执行 → result 响应（id 匹配）", async () => {
        enableIpc();
        const cap = capture();
        const input = new PassThrough();
        const stop = startIpcServer({ input, actions: actions(), heartbeatMs: 60_000 });
        try {
            input.write(
                encodeIpcMessage({
                    v: 1,
                    type: "action",
                    id: 7,
                    payload: { action: "self.get", params: {} },
                }),
            );
            await vi.waitFor(() => {
                expect(cap.chunks).toHaveLength(1);
            });
            const msg = JSON.parse(cap.chunks[0] as string) as Record<string, unknown>;
            expect(msg["type"]).toBe("result");
            expect(msg["id"]).toBe(7);
            expect(msg["payload"]).toEqual({ ok: true, value: { uin: "10001" } });
        } finally {
            stop();
            cap.restore();
        }
    });

    it("ping 行 → pong；非法行忽略（不崩不写）", async () => {
        enableIpc();
        const cap = capture();
        const input = new PassThrough();
        const stop = startIpcServer({ input, actions: actions(), heartbeatMs: 60_000 });
        try {
            input.write("不是 json\n");
            input.write(encodeIpcMessage({ v: 1, type: "ping" }));
            await vi.waitFor(() => {
                expect(cap.chunks).toHaveLength(1);
            });
            expect(JSON.parse(cap.chunks[0] as string)).toMatchObject({ type: "pong" });
        } finally {
            stop();
            cap.restore();
        }
    });

    it("control stop → onExit；control login → onLogin（uin/qr 透传）", () => {
        const onExit = vi.fn();
        const onLogin = vi.fn();
        const input = new PassThrough();
        const stop = startIpcServer({
            input,
            actions: actions(),
            heartbeatMs: 60_000,
            onExit,
            onLogin,
        });
        try {
            input.write(
                encodeIpcMessage({
                    v: 1,
                    type: "control",
                    payload: { command: "login", uin: "1", qr: true },
                }),
            );
            expect(onLogin).toHaveBeenCalledWith({ uin: "1", qr: true });
            input.write(
                encodeIpcMessage({ v: 1, type: "control", payload: { command: "stop" } }) +
                    encodeIpcMessage({ v: 1, type: "control", payload: { command: "login" } }),
            );
            expect(onExit).toHaveBeenCalledTimes(1);
            expect(onLogin).toHaveBeenCalledTimes(1);
        } finally {
            stop();
        }
    });

    it("control status → 重播最近一条 status", async () => {
        enableIpc();
        sendStatus("booting");
        const cap = capture();
        const input = new PassThrough();
        const stop = startIpcServer({ input, actions: actions(), heartbeatMs: 60_000 });
        try {
            const before = cap.chunks.length;
            input.write(
                encodeIpcMessage({ v: 1, type: "control", payload: { command: "status" } }),
            );
            await vi.waitFor(() => {
                expect(cap.chunks.length).toBe(before + 1);
            });
            expect(JSON.parse(cap.chunks[cap.chunks.length - 1] as string)).toMatchObject({
                type: "status",
                payload: { phase: "booting" },
            });
        } finally {
            stop();
            cap.restore();
        }
    });

    it("心跳：heartbeatMs 到点发 ping；stop 后停止输入和心跳", async () => {
        vi.useFakeTimers();
        enableIpc();
        const cap = capture();
        const input = new PassThrough();
        const stop = startIpcServer({ input, actions: actions(), heartbeatMs: 1000 });
        try {
            await vi.advanceTimersByTimeAsync(1000);
            expect(cap.chunks).toHaveLength(1);
            expect(JSON.parse(cap.chunks[0] as string)).toMatchObject({ type: "ping" });
            stop();
            expect(input.listenerCount("data")).toBe(0);
            await vi.advanceTimersByTimeAsync(5000);
            expect(cap.chunks).toHaveLength(1); // 心跳停止
        } finally {
            cap.restore();
            vi.useRealTimers();
        }
    });
    it("物理字节上限覆盖分片、CRLF 与超长后恢复；EOF 尾帧丢弃", async () => {
        enableIpc();
        const input = new PassThrough();
        const cap = capture();
        const onExit = vi.fn();
        const ping = encodeIpcMessage({ v: 1, type: "ping" }).trimEnd();
        const stop = startIpcServer({
            input,
            actions: actions(),
            maxLineBytes: Buffer.byteLength(ping) + 1,
            onExit,
        });
        try {
            input.write(Buffer.from("界".repeat(6)));
            input.write(Buffer.from("界".repeat(8)));
            input.end(`\n${ping}\r\n${ping}`);
            await vi.waitFor(() =>
                expect(onExit).toHaveBeenCalledExactlyOnceWith("IPC stdin 已断开"),
            );
            expect(cap.chunks.map((line) => JSON.parse(line))).toEqual([{ v: 1, type: "pong" }]);
        } finally {
            stop();
            cap.restore();
        }
    });

    it("在途饱和按请求 id 拒绝，心跳继续，关停后丢弃迟到结果", async () => {
        enableIpc();
        const input = new PassThrough();
        const cap = capture();
        const held = Promise.withResolvers<string>();
        const action = vi.fn(() => held.promise);
        const stop = startIpcServer({ input, actions: new Map([["hold", action]]), maxPending: 1 });
        const frame = (id: number) =>
            encodeIpcMessage({ v: 1, type: "action", id, payload: { action: "hold" } });
        try {
            input.write(frame(1) + frame(2) + encodeIpcMessage({ v: 1, type: "ping" }));
            expect(action).toHaveBeenCalledOnce();
            expect(cap.chunks.map((line) => JSON.parse(line))).toMatchObject([
                { type: "result", id: 2, payload: { ok: false, error: { code: "IPC_BUSY" } } },
                { type: "pong" },
            ]);
            stop();
            held.resolve("complete");
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(cap.chunks).toHaveLength(2);
        } finally {
            stop();
            cap.restore();
        }
    });
});
