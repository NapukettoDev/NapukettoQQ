/**
 * connection.test.ts：KurobotConnection 全链路单测（任务书 KUROBOT-PROMPT 阶段 2）。
 *
 * 用假 kurobot-ws 服务端（ws 库真端口，握手校验复刻 KuroAdapter NodeWsServer）驱动：
 * 带子协议握手 / 不带被拒 / hello 0.3.1 + client + token / 应用层 ping / 断线指数退避
 * 重连且重发 hello / hello_ack 拒绝与 close 1002、1008 停止重连 / 未知帧容忍。
 * 重连节奏用测试快值（retryBaseDelayMs=20ms），不拖慢用例。
 */

import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
    ConnectionEndedReason,
    KurobotConnectionOptions,
    ServerEventMessage,
} from "./connection.js";
import { KurobotConnection } from "./connection.js";
import { type HelloAckOkBody, WS_SUBPROTOCOL } from "./schema.js";
import { type FakeKurobotServer, startFakeKurobotServer, waitFor } from "./test-support.js";

/** 测试快参数（重连/心跳/握手超时全部加速）。 */
const FAST = {
    pingIntervalMs: 30,
    helloTimeoutMs: 1000,
    retryBaseDelayMs: 20,
    retryMaxDelayMs: 60,
} as const;

/** 捕获回调的连接工厂。 */
function makeConnection(
    url: string,
    overrides?: Partial<KurobotConnectionOptions>,
): {
    conn: KurobotConnection;
    established: HelloAckOkBody[];
    frames: ServerEventMessage[];
    ended: ConnectionEndedReason[];
} {
    const established: HelloAckOkBody[] = [];
    const frames: ServerEventMessage[] = [];
    const ended: ConnectionEndedReason[] = [];
    const conn = new KurobotConnection({
        url,
        hello: {
            peerId: "10001",
            platform: "qq",
            version: "0.2.1",
            protocolVersion: "0.3.1",
            client: "napukettoqq/0.2.1",
        },
        ...FAST,
        onEstablished: (ack) => established.push(ack),
        onFrame: (msg) => frames.push(msg),
        onEnded: (reason) => ended.push(reason),
        ...overrides,
    });
    return { conn, established, frames, ended };
}

/** 服务端自动应答 hello（ok + 绑定快照）。 */
function autoAck(server: FakeKurobotServer, bindings: string[], serverId = "fake-server"): void {
    server.onClientFrame = (frame, conn) => {
        if (frame.header.type === "hello" && frame.header.id !== undefined) {
            server.send(conn, {
                type: "hello_ack",
                id: frame.header.id,
                body: {
                    ok: true,
                    serverId,
                    version: "1.0.0",
                    protocolVersion: "0.3.1",
                    channelBindings: bindings,
                },
            });
        }
    };
}

let shared: FakeKurobotServer | null = null;

async function server(): Promise<FakeKurobotServer> {
    if (shared === null) {
        shared = await startFakeKurobotServer();
    }
    return shared;
}

afterAll(async () => {
    await shared?.stop();
}, 10_000);

describe("KurobotConnection 握手", () => {
    it("带子协议握手成功：hello 0.3.1 + client 到位，ack 后建立并拿到绑定快照", async () => {
        const s = await server();
        s.frames.length = 0;
        s.handshakes.length = 0;
        autoAck(s, ["808", "10086"]);
        const { conn, established } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        const conn0 = await s.nextConnection();
        await waitFor(() => (established.length > 0 ? established[0] : null));
        // 子协议已带上（服务端 handleProtocols 捕获）
        expect(s.handshakes[0]).toBe(WS_SUBPROTOCOL);
        // hello 帧逐字段
        const hello = s.frames.find((f) => f.header.type === "hello");
        expect(hello).toBeDefined();
        expect(hello?.header.id).toEqual(expect.any(String));
        expect(hello?.body).toMatchObject({
            peerId: "10001",
            platform: "qq",
            version: "0.2.1",
            protocolVersion: "0.3.1",
            client: "napukettoqq/0.2.1",
        });
        // ack ok：绑定快照透出
        expect(established[0]?.channelBindings).toEqual(["808", "10086"]);
        conn.stop();
        void conn0;
    });

    it("token 非空才携带：配置了 token 的 hello 带 token，缺省不带", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, []);
        // 带 token
        const withToken = makeConnection(`ws://127.0.0.1:${s.port}`, {
            hello: {
                peerId: "10001",
                platform: "qq",
                version: "0.2.1",
                protocolVersion: "0.3.1",
                token: "secret-token",
            },
        });
        withToken.conn.start();
        await s.nextConnection();
        await waitFor(() => withToken.established[0]);
        const hello1 = s.frames.find((f) => f.header.type === "hello");
        expect((hello1?.body as { token?: string } | undefined)?.token).toBe("secret-token");
        withToken.conn.stop();
        // 缺省（空 token）：不带 token 字段
        s.frames.length = 0;
        const noToken = makeConnection(`ws://127.0.0.1:${s.port}`);
        noToken.conn.start();
        await s.nextConnection();
        await waitFor(() => noToken.established[0]);
        const hello2 = s.frames.filter((f) => f.header.type === "hello").at(-1);
        expect(hello2).toBeDefined();
        expect((hello2?.body as { token?: string } | undefined)?.token).toBeUndefined();
        noToken.conn.stop();
    });

    it("子协议不匹配 → 被拒（真实复现服务端 handleProtocols 返回 false 的 401 行为）", async () => {
        const s = await server();
        const result = await new Promise<{ ok: boolean; err?: Error }>((resolve) => {
            // 带错误子协议（handleProtocols 返回 false → 401）。
            // 注：ws 库只在客户端携带 Sec-WebSocket-Protocol 头时才调用 handleProtocols
            //（裸连接不会被 ws lib 主动 abort）——本客户端恒带正确子协议，不受影响。
            const raw = new WebSocket(`ws://127.0.0.1:${s.port}`, "some-other-protocol.v1");
            raw.on("open", () => {
                resolve({ ok: true });
                raw.close();
            });
            raw.on("error", (err) => {
                resolve({ ok: false, err });
            });
        });
        expect(result.ok).toBe(false);
        // 实测 ws 库行为：服务端不回显子协议 → 客户端校验失败拒绝连接
        //（错误串 "Server sent no subprotocol"；对端等效于「握手不可用」）
        expect(result.err?.message).toMatch(/subprotocol|401/);
    });
});

describe("KurobotConnection 心跳与出站", () => {
    it("建立后按 pingIntervalMs 发应用层 ping 帧（服务端只认应用层入帧）", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, []);
        const { conn } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        await s.nextConnection();
        // FAST.pingIntervalMs=30ms，等 5 个周期
        await waitFor(() =>
            s.frames.filter((f) => f.header.type === "ping").length >= 3 ? true : null,
        );
        const pings = s.frames.filter((f) => f.header.type === "ping");
        expect(pings[0]?.header.id).toEqual(expect.any(String));
        expect((pings[0]?.body as { timestamp: number } | undefined)?.timestamp).toBeGreaterThan(0);
        conn.stop();
    });

    it("established 才能发送：chat 帧到服务端；未建立时 send 返回 false", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, []);
        const { conn } = makeConnection(`ws://127.0.0.1:${s.port}`);
        expect(conn.send({ type: "chat", body: { channel: "1", sender: "x", content: "y" } })).toBe(
            false,
        );
        conn.start();
        await s.nextConnection();
        await waitFor(() => (conn.isEstablished() ? true : null));
        expect(
            conn.send({ type: "chat", body: { channel: "808", sender: "小明", content: "你好" } }),
        ).toBe(true);
        await waitFor(() => s.frames.find((f) => f.header.type === "chat") ?? null);
        const chat = s.frames.find((f) => f.header.type === "chat");
        expect(chat?.header.id).toBeUndefined(); // 事件帧无 id
        expect(chat?.body).toEqual({ channel: "808", sender: "小明", content: "你好" });
        conn.stop();
    });

    it("pong 透传 onFrame（消费方忽略）；未知请求帧回 <type>_result 失败回执，未知事件帧忽略", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, []);
        const { conn, frames } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        const conn0 = await s.nextConnection();
        await waitFor(() => (conn.isEstablished() ? true : null));
        s.frames.length = 0;
        // pong（响应帧）
        s.send(conn0, {
            type: "pong",
            id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            body: { timestamp: 1 },
        });
        // 未知请求帧（带 id）→ 应回执
        s.send(conn0, { type: "mystery", id: "3fa85f64-5717-4562-b3fc-2c963f66afa7", body: {} });
        // 未知事件帧（无 id）→ 忽略不回执
        s.send(conn0, { type: "future_event", body: { x: 1 } });
        await waitFor(() => frames.find((f) => f.type === "pong") ?? null);
        await waitFor(() => s.frames.find((f) => f.header.type === "mystery_result") ?? null);
        const reply = s.frames.find((f) => f.header.type === "mystery_result");
        expect(reply?.header.id).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa7");
        expect(reply?.body).toEqual({ ok: false, error: "unknown frame type" });
        await new Promise((r) => setTimeout(r, 50));
        expect(s.frames.find((f) => f.header.type === "future_event_result")).toBeUndefined();
        conn.stop();
    });
});

describe("KurobotConnection 重连与停止", () => {
    it("断线后指数退避重连且重发 hello（每次连接都重新握手）", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, ["808"]);
        const { conn, established } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        const conn0 = await s.nextConnection();
        await waitFor(() => (established.length === 1 ? true : null));
        // 服务端主动断开（1001 空闲超时语义）→ 应退避重连
        s.close(conn0, 1001, "idle timeout");
        const conn1 = await s.nextConnection();
        await waitFor(() => (established.length === 2 ? true : null));
        const hellos = s.frames.filter((f) => f.header.type === "hello");
        expect(hellos.length).toBe(2);
        // 两次 hello 的 UUID 不同（独立请求）
        expect(hellos[0]?.header.id).not.toBe(hellos[1]?.header.id);
        conn.stop();
        void conn1;
    });

    it("hello_ack ok:false（auth failed）→ 停止重连 + onEnded(permanent)", async () => {
        const s = await server();
        s.frames.length = 0;
        s.handshakes.length = 0;
        s.onClientFrame = (frame, conn) => {
            if (frame.header.type === "hello" && frame.header.id !== undefined) {
                s.send(conn, {
                    type: "hello_ack",
                    id: frame.header.id,
                    body: { ok: false, reason: "auth failed" },
                });
                s.close(conn, 1008, "auth failed");
            }
        };
        const { conn, established, ended } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        await s.nextConnection();
        await waitFor(() => (ended.length > 0 ? ended[0] : null));
        expect(established).toHaveLength(0);
        expect(ended[0]?.permanent).toBe(true);
        // 等若干退避周期：不应有第二次连接
        await new Promise((r) => setTimeout(r, 150));
        expect(s.handshakes.length).toBe(1);
        conn.stop();
    });

    it("close 1002（版本不匹配）→ 停止重连；close 1008 → 停止重连", async () => {
        const s = await server();
        s.frames.length = 0;
        s.handshakes.length = 0;
        // 服务端直接关（不回 ack），先 1002
        s.onClientFrame = (_frame, conn) => {
            s.close(conn, 1002, "protocol version mismatch");
        };
        const { conn, ended } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        await s.nextConnection();
        await waitFor(() => (ended.length > 0 ? ended[0] : null));
        expect(ended[0]).toMatchObject({ permanent: true, code: 1002 });
        await new Promise((r) => setTimeout(r, 100));
        expect(s.handshakes.length).toBe(1);
        conn.stop();

        // 再验 1008
        const { conn: conn2, ended: ended2 } = makeConnection(`ws://127.0.0.1:${s.port}`);
        s.onClientFrame = (_frame, conn) => {
            s.close(conn, 1008, "auth failed");
        };
        conn2.start();
        await s.nextConnection();
        await waitFor(() => (ended2.length > 0 ? ended2[0] : null));
        expect(ended2[0]).toMatchObject({ permanent: true, code: 1008 });
        conn2.stop();
    });

    it("普通关闭（1000/1001）持续退避：多次重连不停止", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, []);
        const { conn, established } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        const conn0 = await s.nextConnection();
        await waitFor(() => (established.length === 1 ? true : null));
        s.close(conn0, 1000, "server shutdown");
        const conn1 = await s.nextConnection();
        await waitFor(() => (established.length === 2 ? true : null));
        s.close(conn1, 1000, "server shutdown");
        await s.nextConnection();
        await waitFor(() => (established.length === 3 ? true : null));
        conn.stop();
    });

    it("用户 stop()：不再重连、不触发 onEnded", async () => {
        const s = await server();
        s.frames.length = 0;
        autoAck(s, []);
        const { conn, ended } = makeConnection(`ws://127.0.0.1:${s.port}`);
        conn.start();
        const conn0 = await s.nextConnection();
        await waitFor(() => (conn.isEstablished() ? true : null));
        conn.stop();
        // stop 后服务端关连接，不应产生 onEnded 或重连
        s.close(conn0, 1001, "idle");
        await new Promise((r) => setTimeout(r, 120));
        expect(ended).toHaveLength(0);
        const handshakesBefore = s.handshakes.length;
        await new Promise((r) => setTimeout(r, 80));
        expect(s.handshakes.length).toBe(handshakesBefore);
    });
});
