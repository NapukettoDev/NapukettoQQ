/**
 * OB11 传输装配分支补全（承接 transport.test.ts 的真端口集成）：
 *
 * - enabled=false 的 httpServers / wsServers 实例不装配（对照启用项计数）
 * - wsServers 实例缺 token → 协议级 config.token 兜底（?? 右支）
 * - wsServers 协议级也无 token → 匿名连入可正常请求（authorize 未装配分支）
 * - Host 头构造成非法 URL → hasAccessTokenQuery 解析失败兜底 false（catch 分支，401）
 *
 * 端口固定（37243+，与其他传输测试错开；CI 两平台同端口）。
 */
import { connect } from "node:net";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket as WsTestClient } from "ws";
import type { OB11Config } from "../helper/index.js";
import { ob11ConfigSchema } from "../helper/index.js";
import { assembleOb11Transports, type Ob11TransportSet } from "../transport.js";

const TOKEN = "tok-x";
const WS_CONFIG_TOKEN_PORT = 37243;
const WS_NO_TOKEN_PORT = 37244;
const RAW_PROBE_PORT = 37245;

/** 组装（zod 补全默认值；handleRequest 回显 echo）。 */
function assemble(seed: Record<string, unknown>): {
    set: Ob11TransportSet;
    broadcaster: EventBroadcaster;
} {
    const broadcaster = new EventBroadcaster();
    const set = assembleOb11Transports({
        config: ob11ConfigSchema.parse(seed) as OB11Config,
        broadcaster,
        selfUin: "10001",
        handleRequest: (req, respond) => {
            const r = req as { echo?: unknown };
            respond({ retcode: 0, status: "ok", data: null, message: "", echo: r.echo });
        },
    });
    return { set, broadcaster };
}

/** 关闭全部装配（有则关；幂等）。 */
async function closeAll(...sets: Array<Ob11TransportSet | undefined>): Promise<void> {
    for (const set of sets) {
        if (set !== undefined) {
            await set.close();
        }
    }
}

/** WS 连入并发一条请求，收集首个响应帧（解析为 JSON）。 */
function wsRequest(
    port: number,
    headers: Record<string, string> = {},
): Promise<{ retcode?: number; echo?: unknown }> {
    return new Promise((resolve, reject) => {
        const ws = new WsTestClient(`ws://127.0.0.1:${port}`, { headers });
        ws.on("open", () => {
            ws.send(JSON.stringify({ action: "get_status", echo: "branch" }));
        });
        ws.on("message", (raw) => {
            try {
                resolve(JSON.parse(raw.toString()) as { retcode?: number; echo?: unknown });
            } finally {
                ws.close();
            }
        });
        ws.on("error", (err: Error) => reject(err));
        setTimeout(() => {
            ws.terminate();
            reject(new Error("WS 响应超时"));
        }, 3000);
    });
}

describe("enabled=false 实例不装配", () => {
    it("httpServers / wsServers 混合开关 → 只装配 enabled 实例", async () => {
        const { set } = assemble({
            httpServers: [
                { enabled: false, host: "127.0.0.1", port: 1 },
                { enabled: true, host: "127.0.0.1", port: RAW_PROBE_PORT },
            ],
            wsServers: [
                { enabled: true, host: "127.0.0.1", port: WS_NO_TOKEN_PORT },
                { enabled: false, host: "127.0.0.1", port: 1 },
            ],
        });
        // 2 个反向 server（1 HTTP + 1 WS），禁用项被跳过
        expect(set.servers).toHaveLength(2);
        expect(set.transports).toHaveLength(0);
        await closeAll(set);
    });
});

describe("wsServers token 兜底链", () => {
    it("实例无 token + 协议级 config.token → Bearer 连入成功（?? 右支兜底）", async () => {
        const { set } = assemble({
            token: TOKEN,
            wsServers: [{ enabled: true, host: "127.0.0.1", port: WS_CONFIG_TOKEN_PORT }],
        });
        try {
            await set.servers[0]?.open();
            const reply = await wsRequest(WS_CONFIG_TOKEN_PORT, {
                authorization: `Bearer ${TOKEN}`,
            });
            expect(reply.retcode).toBe(0);
            expect(reply.echo).toBe("branch");
        } finally {
            await closeAll(set);
        }
    });

    it("协议级与实例都无 token → 匿名连入可请求（authorize 未装配）", async () => {
        const { set } = assemble({
            wsServers: [{ enabled: true, host: "127.0.0.1", port: WS_NO_TOKEN_PORT }],
        });
        try {
            await set.servers[0]?.open();
            const reply = await wsRequest(WS_NO_TOKEN_PORT);
            expect(reply.retcode).toBe(0);
        } finally {
            await closeAll(set);
        }
    });
});

describe("hasAccessTokenQuery 解析失败兜底（恶意请求行）", () => {
    const { set } = assemble({
        token: TOKEN,
        wsServers: [{ enabled: true, host: "127.0.0.1", port: RAW_PROBE_PORT }],
    });

    afterAll(async () => {
        await closeAll(set);
    });

    it("WS 升级行构造成非法 URL → 鉴权按 false 处理（升级后收 4401 关闭帧，不抛错）", async () => {
        await set.servers[0]?.open();
        // ws 库的 connection 事件在 101 升级完成后触发——鉴权失败走应用层
        // close(4401, "unauthorized")：关闭帧 = 0x88 + 长度 0x0E（2+12 字节）+ 关闭码 0x1131
        const sawRejectFrame = await new Promise<boolean>((resolve, reject) => {
            const raw = connect({ host: "127.0.0.1", port: RAW_PROBE_PORT }, () => {
                // 请求目标 "//[::1?..." → new URL 抛 TypeError，
                // hasAccessTokenQuery catch 兜底 false → 4401 关闭帧
                raw.write(
                    `GET //[::1?access_token=${TOKEN} HTTP/1.1\r\n` +
                        "Host: 127.0.0.1\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
                        "Sec-WebSocket-Version: 13\r\n\r\n",
                );
            });
            raw.on("data", (chunk: Buffer) => {
                if (chunk.includes(Buffer.from([0x88, 0x0e, 0x11, 0x31]))) {
                    raw.destroy();
                    resolve(true);
                }
            });
            raw.on("error", (err: Error) => reject(err));
            setTimeout(() => {
                raw.destroy();
                resolve(false);
            }, 3000);
        });
        expect(sawRejectFrame).toBe(true);
    });
});
