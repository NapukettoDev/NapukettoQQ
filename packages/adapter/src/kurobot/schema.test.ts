/**
 * schema.test.ts：kurobot-ws 镜像 schema golden 帧对表（任务书 KUROBOT-PROMPT 阶段 2）。
 *
 * ⚠️ 对表来源：KuroAdapter `bridge/protocol`（SSOT）master commit **b0809ef**
 * （协议 0.3.1，hello 可选 client）。下方 golden 字符串 = 各帧的线格式字面量
 * （与 KuroAdapter encodeFrame 输出逐字段一致），双向校验：
 * 镜像 schema 解析 golden → 扁平消息；扁平消息 encodeFrame → golden 原文。
 * `@kurobot/protocol` 发版后切换真依赖时，用例迁移为对真 schema 互验。
 */
import { describe, expect, it } from "vitest";
import {
    bindingsUpdatedFrame,
    commandFrame,
    commandResultFrame,
    deathFrame,
    encodeFrame,
    gameChatFrame,
    helloAckFrame,
    helloFrame,
    isProtocolVersionCompatible,
    joinFrame,
    leaveFrame,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    pingFrame,
    platformChatFrame,
    pongFrame,
    queryFrame,
    queryResultFrame,
    statusFrame,
    WS_SUBPROTOCOL,
    wireFrameSchema,
} from "./schema.js";

/** 请求帧测试用固定 UUID（golden 锁线格式用）。 */
const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UUID_B = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

/** golden 往返：线格式原文 → schema 解析 → encodeFrame → 原文。 */
function expectGoldenRoundTrip(
    schema: { safeParse(json: unknown): { success: boolean; data?: unknown } },
    golden: string,
): void {
    const wire = JSON.parse(golden) as unknown;
    // 骨架可达（两段式解析第一段）
    expect(wireFrameSchema.safeParse(wire).success).toBe(true);
    const parsed = schema.safeParse(wire);
    expect(parsed.success).toBe(true);
    // encodeFrame(扁平) === golden 原文（header 在前 + type/id/body 键序一致）
    expect(encodeFrame(parsed.data as { type: string; body: unknown; id?: string })).toBe(golden);
}

describe("协议元信息（对表 b0809ef）", () => {
    it("协议名 / 版本 0.3.1 / 子协议 kurobot-ws.v1", () => {
        expect(PROTOCOL_NAME).toBe("kurobot-ws");
        expect(PROTOCOL_VERSION).toBe("0.3.1");
        expect(WS_SUBPROTOCOL).toBe("kurobot-ws.v1");
    });

    it("主版本相同即兼容（镜像 isProtocolVersionCompatible）", () => {
        expect(isProtocolVersionCompatible("0.3.1", "0.3.0")).toBe(true);
        expect(isProtocolVersionCompatible("0.2.0", "0.3.1")).toBe(true);
        expect(isProtocolVersionCompatible("1.0.0", "0.3.1")).toBe(false);
        expect(isProtocolVersionCompatible("bad", "0.3.1")).toBe(false);
    });
});

describe("golden 帧对表：Peer → Server", () => {
    it("hello（含可选 token/client，MVP-3 0.3.1 形状）", () => {
        const golden =
            `{"header":{"type":"hello","id":"${UUID_A}"},"body":{"peerId":"10001","platform":"qq",` +
            `"version":"0.2.1","protocolVersion":"0.3.1","token":"secret","client":"napukettoqq/0.2.1"}}`;
        expectGoldenRoundTrip(helloFrame, golden);
        const body = (
            helloFrame.safeParse(JSON.parse(golden) as unknown) as {
                data: { body: { peerId: string; token?: string; client?: string } };
            }
        ).data.body;
        expect(body.peerId).toBe("10001");
        expect(body.token).toBe("secret");
        expect(body.client).toBe("napukettoqq/0.2.1");
    });

    it("chat（QQ → MC，事件无 id）", () => {
        const golden =
            '{"header":{"type":"chat"},"body":{"channel":"808","sender":"小明","content":"你好世界"}}';
        expectGoldenRoundTrip(platformChatFrame, golden);
    });

    it("command（source 必填：channel + userId=QQ 号）", () => {
        const golden =
            `{"header":{"type":"command","id":"${UUID_A}"},"body":{"command":"whitelist list",` +
            `"source":{"channel":"808","userId":"20002"}}}`;
        expectGoldenRoundTrip(commandFrame, golden);
    });

    it("query（kind: status | bindings）", () => {
        const golden = `{"header":{"type":"query","id":"${UUID_A}"},"body":{"kind":"bindings"}}`;
        expectGoldenRoundTrip(queryFrame, golden);
    });

    it("ping（应用层心跳，事件重置服务端空闲计时）", () => {
        const golden = `{"header":{"type":"ping","id":"${UUID_A}"},"body":{"timestamp":1760000000000}}`;
        expectGoldenRoundTrip(pingFrame, golden);
    });
});

describe("golden 帧对表：Server → Peer", () => {
    it("hello_ack ok（含 channelBindings 快照）", () => {
        const golden =
            `{"header":{"type":"hello_ack","id":"${UUID_A}"},"body":{"ok":true,"serverId":"local",` +
            `"version":"1.0.0","protocolVersion":"0.3.1","channelBindings":["808","10086"]}}`;
        expectGoldenRoundTrip(helloAckFrame, golden);
    });

    it("hello_ack error（版本不符 → close 1002；token 错 → close 1008）", () => {
        const golden = `{"header":{"type":"hello_ack","id":"${UUID_A}"},"body":{"ok":false,"reason":"auth failed"}}`;
        expectGoldenRoundTrip(helloAckFrame, golden);
    });

    it("chat（MC → QQ，字段名 playerName）", () => {
        const golden =
            '{"header":{"type":"chat"},"body":{"channel":"808","playerName":"Steve","content":"hi"}}';
        expectGoldenRoundTrip(gameChatFrame, golden);
    });

    it("join / leave（事件）", () => {
        expectGoldenRoundTrip(
            joinFrame,
            '{"header":{"type":"join"},"body":{"channel":"808","playerName":"Steve"}}',
        );
        expectGoldenRoundTrip(
            leaveFrame,
            '{"header":{"type":"leave"},"body":{"channel":"808","playerName":"Steve"}}',
        );
    });

    it("death（⚠️ 字段名是 player/message，与 join/leave 的 playerName 不一致——照抄 SSOT 不「修正」；message 允许空串）", () => {
        const golden =
            '{"header":{"type":"death"},"body":{"channel":"808","player":"Alex","message":""}}';
        expectGoldenRoundTrip(deathFrame, golden);
    });

    it("status（无 channel）", () => {
        const golden =
            '{"header":{"type":"status"},"body":{"tps":19.98,"onlinePlayers":3,"uptimeSeconds":7200}}';
        expectGoldenRoundTrip(statusFrame, golden);
    });

    it("bindings_updated（全量快照非增量）", () => {
        const golden = '{"header":{"type":"bindings_updated"},"body":{"channelBindings":["808"]}}';
        expectGoldenRoundTrip(bindingsUpdatedFrame, golden);
    });

    it("command_result（ok 带 output / error 分支）", () => {
        const goldenOk =
            `{"header":{"type":"command_result","id":"${UUID_B}"},"body":{"ok":true,` +
            `"output":["whitelist added","done"]}}`;
        expectGoldenRoundTrip(commandResultFrame, goldenOk);
        const goldenErr = `{"header":{"type":"command_result","id":"${UUID_B}"},"body":{"ok":false,"error":"permission denied"}}`;
        expectGoldenRoundTrip(commandResultFrame, goldenErr);
    });

    it("query_result（data 形状由 kind 决定）", () => {
        const goldenOk = `{"header":{"type":"query_result","id":"${UUID_B}"},"body":{"ok":true,"data":["808"]}}`;
        expectGoldenRoundTrip(queryResultFrame, goldenOk);
    });

    it("pong（心跳响应）", () => {
        const golden = `{"header":{"type":"pong","id":"${UUID_B}"},"body":{"timestamp":1760000000000}}`;
        expectGoldenRoundTrip(pongFrame, golden);
    });
});

describe("帧格式约束（镜像 frame.ts 语义）", () => {
    it("事件帧携带 id 会被拒绝（尽早暴露方向用错）", () => {
        const bad = {
            header: { type: "chat", id: UUID_A },
            body: { channel: "808", playerName: "Steve", content: "hi" },
        };
        expect(gameChatFrame.safeParse(bad).success).toBe(false);
    });

    it("请求帧缺 id 会被拒绝（UUID 关联）", () => {
        const bad = {
            header: { type: "ping" },
            body: { timestamp: 1 },
        };
        expect(pingFrame.safeParse(bad).success).toBe(false);
    });

    it("未知帧容忍：骨架合法即可经 wireFrameSchema（协商安全网）", () => {
        expect(
            wireFrameSchema.safeParse({ header: { type: "future_thing" }, body: { x: 1 } }).success,
        ).toBe(true);
        expect(wireFrameSchema.safeParse({ header: { type: "BadType" }, body: {} }).success).toBe(
            false,
        );
    });
});
