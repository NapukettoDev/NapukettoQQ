/**
 * adapter.test.ts：NapukettoKurobotAdapter 适配器级全链路（任务书阶段 2/4，无 QQ）。
 *
 * 假 kurobridge-ws 服务端 + ProtocolConfig（seed 模式）+ 桩 msgChannel/msgApi：
 * [accounts.kurobot] 配置生效 → 连入握手 → QQ 群消息出帧（chat/command、自消息
 * 过滤、非绑定群不发）→ 服务端帧渲染回群（chat/join/leave/death/command_result、
 * status 只缓存）→ 绑定更新（bindings_updated / query_result）热生效。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MsgEventChannel } from "@napuketto/kernel";
import { afterAll, describe, expect, it } from "vitest";
import { ProtocolConfig } from "../core/index.js";
import { type KurobotMsgApi, NapukettoKurobotAdapter } from "./adapter.js";
import { kurobotConfigDefaults, kurobotConfigSchema } from "./config.js";
import { type FakeKurobotServer, startFakeKurobotServer, waitFor } from "./test-support.js";

let tmpRoot = "";

function tempDir(): string {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-kurobot-adapter-"));
    }
    return tmpRoot;
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
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
}, 10_000);

/** 桩消息事件通道（捕获 onRecvMsg 处理器，供用例注入合成消息）。 */
function stubMsgChannel(): { channel: MsgEventChannel; emit: (msgs: unknown) => void } {
    let handler: ((msgs: unknown) => void) | null = null;
    const channel = {
        on: (_event: string, cb: (msgs: unknown) => void) => {
            handler = cb;
            return () => undefined;
        },
    } as unknown as MsgEventChannel;
    return {
        channel,
        emit: (msgs) => {
            handler?.(msgs);
        },
    };
}

/** 桩消息 API（记录 sendMessage 调用）。 */
function stubMsgApi(): { api: KurobotMsgApi; calls: { target: unknown; text: string }[] } {
    const calls: { target: unknown; text: string }[] = [];
    const api: KurobotMsgApi = {
        sendMessage: async (target, elements) => {
            const first = elements[0];
            calls.push({
                target,
                text: first !== undefined && first.type === "text" ? first.text : "",
            });
            return { msgId: "1" };
        },
    };
    return { api, calls };
}

/** 合成群消息（onRecvMsg 数组透传形态）。 */
function groupMsg(
    channel: string,
    senderUin: string,
    text: string,
    sendMemberName?: string,
): unknown {
    return [
        {
            msgId: "1",
            msgSeq: "1",
            msgTime: "0",
            msgType: 2,
            chatType: 2,
            peerUid: channel,
            peerUin: channel,
            senderUid: `u_${senderUin}`,
            senderUin,
            peerName: "测试群",
            sendNickName: "昵称",
            ...(sendMemberName !== undefined ? { sendMemberName } : {}),
            elements: [{ elementType: 1, textElement: { content: text } }],
        },
    ];
}

/** 服务端：hello 自动 ack（绑定快照可配）。 */
function ackHello(s: FakeKurobotServer, bindings: string[]): void {
    s.onClientFrame = (frame, conn) => {
        if (frame.header.type === "hello" && typeof frame.header.id === "string") {
            s.send(conn, {
                type: "hello_ack",
                id: frame.header.id,
                body: {
                    ok: true,
                    serverId: "fake",
                    version: "1.0.0",
                    protocolVersion: "0.4.0",
                    channelBindings: bindings,
                },
            });
        }
    };
}

interface Harness {
    adapter: NapukettoKurobotAdapter;
    emit: (msgs: unknown) => void;
    calls: { target: unknown; text: string }[];
}

/** 构建适配器（seed 模式指向假服务端）并 start + 等握手。 */
async function harness(s: FakeKurobotServer): Promise<Harness> {
    const { channel: msgChannel, emit } = stubMsgChannel();
    const { api: msgApi, calls } = stubMsgApi();
    const adapter = new NapukettoKurobotAdapter({
        config: new ProtocolConfig({
            path: join(tempDir(), "kurobot.toml"),
            schema: kurobotConfigSchema,
            defaults: kurobotConfigDefaults(),
            seed: kurobotConfigSchema.parse({ url: `ws://127.0.0.1:${s.port}` }),
        }),
        msgChannel,
        msgApi,
        self: { uin: "10001", nickname: "机器人" },
    });
    await adapter.start();
    await waitFor(() => (adapter.isConnected() ? true : null));
    return { adapter, emit, calls };
}

describe("NapukettoKurobotAdapter 全链路", () => {
    it("配置生效连入 + QQ→MC（chat/command/自消息过滤/非绑定群不发）+ 命令链渲染回群", async () => {
        const s = await server();
        s.frames.length = 0;
        s.onClientFrame = (frame, conn) => {
            if (frame.header.type === "hello" && typeof frame.header.id === "string") {
                s.send(conn, {
                    type: "hello_ack",
                    id: frame.header.id,
                    body: {
                        ok: true,
                        serverId: "fake",
                        version: "1.0.0",
                        protocolVersion: "0.4.0",
                        channelBindings: ["808"],
                    },
                });
                return;
            }
            // command → 回 command_result（ok 带输出）
            if (frame.header.type === "command" && typeof frame.header.id === "string") {
                s.send(conn, {
                    type: "command_result",
                    id: frame.header.id,
                    body: { ok: true, output: ["line1", "line2"] },
                });
            }
        };
        const { adapter, emit, calls } = await harness(s);
        // hello 身份：peerId=账号 uin、client 自报、协议 0.3.1
        const hello = s.frames.find((f) => f.header.type === "hello");
        expect(hello?.body).toMatchObject({
            peerId: "10001",
            platform: "qq",
            protocolVersion: "0.4.0",
        });
        expect(hello?.body).toHaveProperty("client");

        // QQ 群文字 → chat 帧（channel=群号、sender=群名片、事件无 id）
        emit(groupMsg("808", "20002", "大家好", "小明"));
        const chat = await waitFor(() => s.frames.find((f) => f.header.type === "chat") ?? null);
        expect(chat?.header.id).toBeUndefined();
        expect(chat?.body).toEqual({ channel: "808", sender: "小明", content: "大家好" });

        // 自己发的消息 → 不发（防回环）；非绑定群 → 不发
        emit(groupMsg("808", "10001", "自己说的"));
        emit(groupMsg("999", "20002", "别的群"));
        await new Promise((r) => setTimeout(r, 60));
        expect(s.frames.filter((f) => f.header.type === "chat")).toHaveLength(1);

        // 命令前缀 → command 帧（source 正确，非 chat）
        emit(groupMsg("808", "20002", "/whitelist list"));
        const cmd = await waitFor(() => s.frames.find((f) => f.header.type === "command") ?? null);
        expect(cmd?.body).toEqual({
            command: "whitelist list",
            source: { channel: "808", userId: "20002" },
        });
        // command_result → 渲染回群（output \n 合并）
        await waitFor(() => (calls.length > 0 ? calls[0] : null));
        expect(calls[0]?.target).toEqual({ chatType: 2, peerUid: "808" });
        expect(calls[0]?.text).toBe("line1\nline2");

        // 空命令（只有前缀）→ 忽略
        emit(groupMsg("808", "20002", "/"));
        await new Promise((r) => setTimeout(r, 60));
        expect(s.frames.filter((f) => f.header.type === "command")).toHaveLength(1);

        await adapter.stop();
    });

    it("MC→QQ 渲染：chat/join/leave/death(空串)/status 只缓存；error 分支与 1500 截断", async () => {
        const s = await server();
        s.frames.length = 0;
        ackHello(s, ["808"]);
        const { adapter, emit, calls } = await harness(s);
        const conn = s.connections[s.connections.length - 1];
        if (conn === undefined) {
            throw new Error("假服务端无连接");
        }
        // chat：缺省模板 [{player}] {content}
        s.send(conn, {
            type: "chat",
            body: { channel: "808", playerName: "Steve", content: "hi" },
        });
        await waitFor(() => (calls.length > 0 ? calls[0] : null));
        expect(calls[0]?.text).toBe("[Steve] hi");
        // join / leave
        s.send(conn, { type: "join", body: { channel: "808", playerName: "Alex" } });
        await waitFor(() => (calls.length > 1 ? calls[1] : null));
        expect(calls[1]?.text).toBe("Alex 加入了服务器");
        s.send(conn, { type: "leave", body: { channel: "808", playerName: "Alex" } });
        await waitFor(() => (calls.length > 2 ? calls[2] : null));
        expect(calls[2]?.text).toBe("Alex 离开了服务器");
        // death：message 空串 → 「死亡了」
        s.send(conn, { type: "death", body: { channel: "808", player: "Alex", message: "" } });
        await waitFor(() => (calls.length > 3 ? calls[3] : null));
        expect(calls[3]?.text).toBe("Alex 死亡了");
        // status：只缓存不发群
        s.send(conn, { type: "status", body: { tps: 19.9, onlinePlayers: 2, uptimeSeconds: 60 } });
        await waitFor(() => (adapter.getLastStatus() !== null ? adapter.getLastStatus() : null));
        expect(adapter.getLastStatus()).toEqual({ tps: 19.9, onlinePlayers: 2, uptimeSeconds: 60 });
        const callsBeforeStatus = calls.length;
        await new Promise((r) => setTimeout(r, 60));
        expect(calls.length).toBe(callsBeforeStatus);

        // command_result error 分支：命令失败：{error}
        const cmdCountBefore = s.frames.filter((f) => f.header.type === "command").length;
        emit(groupMsg("808", "20002", "/ban griefers"));
        const cmd = await waitFor(() => {
            const list = s.frames.filter((f) => f.header.type === "command");
            return list.length > cmdCountBefore ? (list.at(-1) ?? null) : null;
        });
        const cmdId = cmd?.header.id;
        expect(cmdId).toEqual(expect.any(String));
        s.send(conn, {
            type: "command_result",
            id: cmdId as string,
            body: { ok: false, error: "not allowed" },
        });
        const callsBeforeError = calls.length;
        await waitFor(() => (calls.length > callsBeforeError ? calls[callsBeforeError] : null));
        expect(calls[callsBeforeError]?.text).toBe("命令失败：not allowed");

        // 1500 截断：command_result 超长 output
        const cmdCountBefore2 = s.frames.filter((f) => f.header.type === "command").length;
        emit(groupMsg("808", "20002", "/long"));
        const cmd2 = await waitFor(() => {
            const list = s.frames.filter((f) => f.header.type === "command");
            return list.length > cmdCountBefore2 ? (list.at(-1) ?? null) : null;
        });
        const cmd2Id = cmd2?.header.id;
        expect(cmd2Id).toEqual(expect.any(String));
        s.send(conn, {
            type: "command_result",
            id: cmd2Id as string,
            body: { ok: true, output: ["y".repeat(1600)] },
        });
        const callsBeforeTrunc = calls.length;
        await waitFor(() => (calls.length > callsBeforeTrunc ? calls[callsBeforeTrunc] : null));
        expect(calls[callsBeforeTrunc]?.text.endsWith("…(截断)")).toBe(true);

        // bindings_updated 全量替换：清空绑定后群消息不再出帧
        s.send(conn, { type: "bindings_updated", body: { channelBindings: [] } });
        await new Promise((r) => setTimeout(r, 60));
        const chatsBefore = s.frames.filter((f) => f.header.type === "chat").length;
        emit(groupMsg("808", "20002", "应该不发"));
        await new Promise((r) => setTimeout(r, 80));
        expect(s.frames.filter((f) => f.header.type === "chat").length).toBe(chatsBefore);

        await adapter.stop();
    });

    it("query 能力：query 帧到服务端，query_result(bindings) 刷新绑定集", async () => {
        const s = await server();
        s.frames.length = 0;
        s.onClientFrame = (frame, conn) => {
            if (frame.header.type === "hello" && typeof frame.header.id === "string") {
                s.send(conn, {
                    type: "hello_ack",
                    id: frame.header.id,
                    body: {
                        ok: true,
                        serverId: "fake",
                        version: "1.0.0",
                        protocolVersion: "0.4.0",
                        channelBindings: [],
                    },
                });
                return;
            }
            if (frame.header.type === "query" && typeof frame.header.id === "string") {
                s.send(conn, {
                    type: "query_result",
                    id: frame.header.id,
                    body: { ok: true, data: ["808"] },
                });
            }
        };
        const { adapter, emit } = await harness(s);
        // 初始绑定空 → chat 不发（空快照 = 全部不发）
        emit(groupMsg("808", "20002", "先不发"));
        await new Promise((r) => setTimeout(r, 60));
        expect(s.frames.filter((f) => f.header.type === "chat")).toHaveLength(0);
        // query bindings → 服务端回 ["808"] → 绑定生效
        expect(adapter.query("bindings")).toBe(true);
        await waitFor(() => s.frames.find((f) => f.header.type === "query") ?? null);
        await new Promise((r) => setTimeout(r, 60));
        emit(groupMsg("808", "20002", "现在发"));
        const chat = await waitFor(() => s.frames.find((f) => f.header.type === "chat") ?? null);
        expect(chat?.body).toMatchObject({ channel: "808" });
        await adapter.stop();
    });
});
