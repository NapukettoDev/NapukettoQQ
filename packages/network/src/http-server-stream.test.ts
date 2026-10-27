/**
 * HttpServer 流式响应 + 同端口 WS 升级集成测试（SSE 原语承接面，Milky /event 前置）
 *
 * 真端口起服务：onRawRequest 短路返回 SSE 流；onUpgrade 同端口完成 WS 握手；
 * 常规 JSON 路由不受影响；鉴权仍先于 onRawRequest。
 */

import { afterAll, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import { HttpServer } from "./http-server.js";
import { createSseResponse } from "./sse.js";

const PORT = 36110;

/** SSE 客户端推送退订（SseClient 闭包转发）。 */
let push: ((data: string) => void) | null = null;

const server = new HttpServer({ host: "127.0.0.1", port: PORT });
server.onRawRequest = (ctx) => {
    if (ctx.path !== "/event" || ctx.method !== "GET") {
        return undefined;
    }
    return createSseResponse((client) => {
        push = (data) => client.send(data, "milky_event");
    });
};
server.onPathRequest = (_ctx, req, respond) => {
    respond({ echo: req });
};
server.onUpgrade = (req, accept) => {
    if (req.url?.startsWith("/event?")) {
        accept(() => {
            // 连接建立后推一条（简化：由测试直连后收）
        });
    } else {
        // 不接受：挂起（测试不覆盖）
    }
};

afterAll(async () => {
    await server.close();
});

describe("HttpServer 流式注入点", () => {
    it("onRawRequest 短路：GET /event 返回 SSE 流并可推送", async () => {
        await server.open();
        const res = await fetch(`http://127.0.0.1:${PORT}/event`);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        // 未推送前 read 挂起：先推再读（微任务让渡）
        push?.('{"event_type":"message_receive"}');
        const { value } = (await reader?.read()) ?? { value: undefined };
        expect(decoder.decode(value ?? new Uint8Array())).toBe(
            'event: milky_event\ndata: {"event_type":"message_receive"}\n\n',
        );
        await reader?.cancel();
    });

    it("onUpgrade 同端口完成 WS 握手（upgrade 事件接管）", async () => {
        await server.open();
        const opened = await new Promise<boolean>((resolve, reject) => {
            const ws = new WsClient(`ws://127.0.0.1:${PORT}/event?access_token=x`);
            ws.once("open", () => {
                ws.close();
                resolve(true);
            });
            ws.once("error", (err) => reject(err));
        });
        expect(opened).toBe(true);
    });

    it("常规 JSON 路由不受注入点影响", async () => {
        await server.open();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/x`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ a: 1 }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ echo: { a: 1 } });
    });
});
