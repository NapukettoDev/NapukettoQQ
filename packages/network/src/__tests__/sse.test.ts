/**
 * SSE 原语测试（协议无关传输原语，Milky /event 前置）
 *
 * 锁定：帧格式（event: 行 + data: 行 + 空行）、事件名缺省、
 * 断开清理（cancel → 退订）、close 后 send 静默。
 */
import { describe, expect, it, vi } from "vitest";
import { createSseResponse, type SseClient } from "../sse.js";

/** 读流全部文本（读到流关闭为止）。 */
async function readAll(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (reader === undefined) {
        throw new Error("无 body");
    }
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            return out;
        }
        out += decoder.decode(value);
    }
}

/** 拿到 reader（首个 chunk 读取 + 不关闭，供断开清理用例控制 cancel 时机）。 */
async function openReader(res: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const reader = res.body?.getReader();
    if (reader === undefined) {
        throw new Error("无 body");
    }
    await reader.read();
    return reader;
}

describe("createSseResponse", () => {
    it("响应头为 text/event-stream，send 帧含 event 行 + data 行 + 空行", async () => {
        const res = createSseResponse((client) => {
            client.send(JSON.stringify({ a: 1 }), "milky_event");
            client.close();
        });
        expect(res.headers.get("Content-Type")).toContain("text/event-stream");
        const text = await readAll(res);
        expect(text).toBe('event: milky_event\ndata: {"a":1}\n\n');
    });

    it("缺省事件名（不带 event: 行）+ 多次推送连续帧", async () => {
        const res = createSseResponse((client) => {
            client.send("one");
            client.send("two");
            client.close();
        });
        const text = await readAll(res);
        expect(text).toBe("data: one\n\ndata: two\n\n");
    });

    it("handler 返回退订函数：断开（cancel）时调用", async () => {
        const off = vi.fn();
        const res = createSseResponse((client) => {
            client.send("x");
            return off;
        });
        const reader = await openReader(res);
        expect(off).not.toHaveBeenCalled();
        await reader.cancel();
        await new Promise((r) => setTimeout(r, 0));
        expect(off).toHaveBeenCalledTimes(1);
    });

    it("close 后 send 静默（不抛错）", async () => {
        const res = createSseResponse((client) => {
            client.send("before");
            client.close();
            client.send("after");
        });
        const text = await readAll(res);
        expect(text).toBe("data: before\n\n");
    });

    it("流被 cancel 后 send → enqueue 抛错被吞、退订等价触发（断开竞态兜底）", async () => {
        const off = vi.fn();
        let held: SseClient | undefined;
        const res = createSseResponse((client) => {
            held = client;
            return off;
        });
        // handler 未推送：直接 cancel（无首块可读，不能走 openReader）
        await res.body?.getReader()?.cancel();
        await new Promise((r) => setTimeout(r, 0));
        // cancel 已置位：此 send 走早退分支，退订只触发一次
        held?.send("after-cancel");
        expect(off).toHaveBeenCalledTimes(1);
    });

    it("直接对流体 cancel（不经 reader）→ 退订等价触发，send 早退不重复", async () => {
        const off = vi.fn();
        let held: SseClient | undefined;
        const res = createSseResponse((client) => {
            held = client;
            return off;
        });
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 0));
        held?.send("x"); // 已置位：早退，不重复退订
        expect(off).toHaveBeenCalledTimes(1);
    });

    it("cancel 后 close 静默（不重复触发退订）", async () => {
        const off = vi.fn();
        let held: SseClient | undefined;
        const res = createSseResponse((client) => {
            held = client;
            return off;
        });
        await res.body?.getReader()?.cancel();
        await new Promise((r) => setTimeout(r, 0));
        held?.close();
        expect(off).toHaveBeenCalledTimes(1);
    });
});
