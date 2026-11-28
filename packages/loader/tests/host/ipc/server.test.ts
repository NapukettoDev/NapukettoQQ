import { once } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import type { IpcActionHandler } from "../../../src/host/ipc/actions.js";
import { enableIpc } from "../../../src/host/ipc/sender.js";
import { type IpcServerOptions, startIpcServer } from "../../../src/host/ipc/server.js";

function actionFrame(id: number, text: string): Buffer {
    const message = { v: 1, type: "action", id, payload: { action: "echo", params: { text } } };
    return Buffer.from(`${JSON.stringify(message)}\n`);
}

function successFrame(id: number, value: string) {
    return { v: 1, type: "result", id, payload: { ok: true, value } };
}

function startServer(
    handler: IpcActionHandler,
    options: Pick<IpcServerOptions, "maxLineBytes" | "maxPending" | "onExit"> = {},
) {
    const input = new PassThrough();
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
    });
    enableIpc();
    const stop = startIpcServer({
        input,
        actions: new Map([["echo", handler]]),
        heartbeatMs: 60_000,
        ...options,
    });
    onTestFinished(() => {
        stop();
        input.destroy();
        stdout.mockRestore();
    });
    return {
        input,
        stop,
        takeFrames: (): unknown[] =>
            writes.splice(0).map((line) => {
                expect(line.endsWith("\n")).toBe(true);
                const frame: unknown = JSON.parse(line);
                return frame;
            }),
    };
}

it("跨 Buffer 解码 UTF-8，丢弃超长帧后继续读取同一 Buffer 中的多帧", async () => {
    const maxLineBytes = 128;
    const { input, takeFrames } = startServer(async (params) => params["text"], { maxLineBytes });
    const splitFrame = actionFrame(11, "甲🙂乙");
    const splitAt = splitFrame.indexOf(Buffer.from("🙂")) + 2;
    input.write(splitFrame.subarray(0, splitAt));
    input.write(splitFrame.subarray(splitAt));

    // 这条合法 JSON 的字符数低于上限，UTF-8 字节数超过上限。
    const oversized = actionFrame(12, "界".repeat(32));
    input.write(oversized.subarray(0, 96));
    input.write(oversized.subarray(96, maxLineBytes + 1));
    input.write(
        Buffer.concat([
            oversized.subarray(maxLineBytes + 1),
            actionFrame(13, "恢复"),
            actionFrame(14, "同块下一帧"),
        ]),
    );

    await setImmediate();
    expect(takeFrames()).toEqual([
        successFrame(11, "甲🙂乙"),
        successFrame(13, "恢复"),
        successFrame(14, "同块下一帧"),
    ]);
});

it("在途配额耗尽时按请求 ID 返回 IPC_BUSY，动作完成后释放名额", async () => {
    const held = Promise.withResolvers<string>();
    const { input, takeFrames } = startServer(
        async (params) => (params["text"] === "占用名额" ? held.promise : params["text"]),
        { maxPending: 1 },
    );
    input.write(Buffer.concat([actionFrame(21, "占用名额"), actionFrame(22, "超出配额")]));

    await setImmediate();
    expect(takeFrames()).toEqual([
        {
            v: 1,
            type: "result",
            id: 22,
            payload: { ok: false, error: { code: "IPC_BUSY", message: "IPC 在途动作已达上限" } },
        },
    ]);

    held.resolve("动作完成");
    await setImmediate();
    expect(takeFrames()).toEqual([successFrame(21, "动作完成")]);

    input.write(actionFrame(23, "新请求"));
    await setImmediate();
    expect(takeFrames()).toEqual([successFrame(23, "新请求")]);
});

it.each([
    { mode: "显式 stop()", explicitStop: true, expectedReasons: [] },
    { mode: "stdin EOF", explicitStop: false, expectedReasons: ["IPC stdin 已断开"] },
])(
    "$mode 遵循退出回调语义，丢弃已执行动作的迟到响应",
    async ({ explicitStop, expectedReasons }) => {
        const entered = Promise.withResolvers<unknown>();
        const held = Promise.withResolvers<string>();
        const exitReasons: string[] = [];
        const { input, stop, takeFrames } = startServer(
            (params) => {
                entered.resolve(params["text"]);
                return held.promise;
            },
            { onExit: (reason) => exitReasons.push(reason) },
        );

        input.write(actionFrame(31, "在途"));
        expect(await entered.promise).toBe("在途");
        expect(takeFrames()).toEqual([]);

        const closed = once(input, "close");
        if (explicitStop) {
            stop();
            input.resume(); // stop() 暂停了读取，恢复流动才能在测试中继续触发真实 EOF。
        }
        input.end();
        await closed;

        held.resolve("迟到结果");
        // 下一个事件循环回合开始前，动作和调度器的 Promise continuation 已执行。
        await setImmediate();
        expect(exitReasons).toEqual(expectedReasons);
        expect(takeFrames(), "动作完成后不应写出迟到响应").toEqual([]);
    },
);
