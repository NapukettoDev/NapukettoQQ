/**
 * send_msg 动作测试（含 send_private_msg / send_group_msg 复用核心 sendOb11Message）。
 *
 * 锁定行为：CQ 码串 / segment 数组 → canonical、群/私聊 Peer 解析（group_id 直通、
 * user_id uin→uid）、at uin→uid 与 at-all 保留、reply OB11 id → NT msgId（反查不到
 * 原样）、auto_escape 文本转义、uinToUid 失败不阻塞发送、语音 silk 归一化（不存在
 * 路径原样）、消息段超上限 → 400、缺目标 → 400、message_id 经 MessageUnique 分配。
 */

import { type CanonicalElement, ChatType, type Peer } from "@napuketto/kernel";
import { describe, expect, it, type Mock, vi } from "vitest";
import { MessageUnique } from "../../../helper/message-unique.js";
import { ob11ActionOf } from "../../__tests__/test-support.js";
import type { Ob11Action } from "../../base-action.js";
import { createSendActions, type SendMsgDeps } from "../send.js";

/** 取发送域动作（TReturn 断言为 { message_id }，保持 result.data 属性访问的编译期类型）。 */
function sendActionOf(
    deps: SendMsgDeps,
    name: "send_msg" | "send_private_msg" | "send_group_msg",
): Ob11Action<unknown, { message_id: number }> {
    return ob11ActionOf(createSendActions(deps as never), name) as Ob11Action<
        unknown,
        { message_id: number }
    >;
}

/** sendMessage 桩类型（calls[0] 直接解构出 peer/elements）。 */
type SendMock = Mock<(peer: Peer, elements: CanonicalElement[]) => Promise<{ msgId: string }>>;

/** 构造发送依赖桩（真实 MessageUnique + 可控 sendMessage / uinToUid）。 */
function makeDeps(options?: { sendMessage?: SendMock; uinToUidFail?: boolean }): {
    deps: SendMsgDeps;
    sendMessage: SendMock;
    uinToUid: Mock<(uins: string[]) => Promise<Map<string, string>>>;
} {
    const sendMessage =
        options?.sendMessage ??
        vi.fn(async (_peer: Peer, _elements: CanonicalElement[]) => ({ msgId: "nt-new" }));
    const uinToUid = vi.fn(async (uins: string[]) => {
        if (options?.uinToUidFail === true) {
            throw new Error("uin 解析服务不可用");
        }
        return new Map(uins.map((u) => [u, `u${u}`]));
    });
    const deps: SendMsgDeps = {
        msgApi: { sendMessage } as never,
        messageUnique: new MessageUnique(),
        uinToUid,
    };
    return { deps, sendMessage, uinToUid };
}

describe("send_msg（共享核心 sendOb11Message）", () => {
    it("群聊 CQ 码文本 → Peer{GROUP, 群号} + text 元素 + message_id 分配", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        const result = await action.handle({
            message_type: "group",
            group_id: 808,
            message: "你好",
        });
        expect(result.status).toBe("ok");
        expect(sendMessage).toHaveBeenCalledTimes(1);
        const [peer, elements] = sendMessage.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "808" });
        expect(elements).toEqual([{ type: "text", text: "你好" }]);
        expect(result.data?.message_id).toBe(1);
        // 分配的 message_id 可反查回 msgId（get_msg / delete_msg 依赖）
        expect(deps.messageUnique.getMsgId(1)).toBe("nt-new");
        expect(deps.messageUnique.getPeer("nt-new")).toEqual({
            chatType: ChatType.GROUP,
            peerUid: "808",
        });
    });

    it("CQ 码串含 at → uin→uid 批量转换一次", async () => {
        const { deps, sendMessage, uinToUid } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        await action.handle({
            message_type: "group",
            group_id: 808,
            message: "[CQ:at,qq=90002] 看这个",
        });
        expect(uinToUid).toHaveBeenCalledWith(["90002"]);
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]).toMatchObject({ type: "at", target: "u90002" });
    });

    it("at-all 不参与 uin→uid 转换（不调 uinToUid）", async () => {
        const { deps, sendMessage, uinToUid } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        await action.handle({
            message_type: "group",
            group_id: 808,
            message: [
                { type: "at", data: { qq: "all" } },
                { type: "text", data: { text: "全体注意" } },
            ],
        });
        expect(uinToUid).not.toHaveBeenCalled();
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]).toEqual({ type: "at", target: "all" });
    });

    it("segment 数组：reply OB11 id → NT msgId；反查不到原样透传", async () => {
        const { deps, sendMessage } = makeDeps();
        deps.messageUnique.alloc("nt-src", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = sendActionOf(deps, "send_msg");
        await action.handle({
            message_type: "group",
            group_id: 808,
            message: [
                { type: "reply", data: { id: "1" } },
                { type: "reply", data: { id: "999" } },
            ],
        });
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]).toEqual({ type: "reply", messageId: "nt-src" });
        expect(elements?.[1]).toEqual({ type: "reply", messageId: "999" });
    });

    it("auto_escape=true → text 元素 CQ 特殊字符转义", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        await action.handle({
            message_type: "group",
            group_id: 808,
            message: "a&b[c],d",
            auto_escape: true,
        });
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]?.type === "text" && elements?.[0]?.text).toBe(
            "a&amp;b&#91;c&#93;&#44;d",
        );
    });

    it("auto_escape=true → 非 text 元素原样保留", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        await action.handle({
            message_type: "group",
            group_id: 808,
            message: [{ type: "at", data: { qq: "90002" } }],
            auto_escape: true,
        });
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]).toEqual({ type: "at", target: "u90002" });
    });

    it("auto_escape 缺省 → 不转义", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        await action.handle({ group_id: 808, message: "a[b]" });
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]?.type === "text" && elements?.[0]?.text).toBe("a[b]");
    });

    it("uinToUid 抛错 → at 目标原样（uin），发送不阻塞", async () => {
        const { deps, sendMessage, uinToUid } = makeDeps({ uinToUidFail: true });
        const action = sendActionOf(deps, "send_msg");
        const result = await action.handle({
            message_type: "group",
            group_id: 808,
            message: [{ type: "at", data: { qq: "90002" } }],
        });
        expect(result.retcode).toBe(0);
        expect(uinToUid).toHaveBeenCalledTimes(1);
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        expect(elements?.[0]?.type === "at" && elements?.[0]?.target).toBe("90002");
    });

    it("语音段：不存在的文件路径经 ensureSilk 原样透传（转码失败兜底）", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        const result = await action.handle({
            message_type: "group",
            group_id: 808,
            message: [{ type: "record", data: { file: "no-such-file.pcm" } }],
        });
        expect(result.retcode).toBe(0);
        const [, elements] = sendMessage.mock.calls[0] ?? [];
        // record 段 → canonical voice；路径原样（读头失败兜底）
        expect(elements?.some((el) => el.type === "voice")).toBe(true);
    });

    it("缺 group_id 与 user_id → retcode 105（INVALID_PARAM）", async () => {
        const { deps } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        const result = await action.handle({ message: "hi" });
        expect(result.retcode).toBe(105);
        expect(result.message).toBe("send_msg 需要 group_id 或 user_id");
    });

    it("message 缺失 → retcode 400（zod）", async () => {
        const { deps } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        expect((await action.handle({ group_id: 808 })).retcode).toBe(400);
    });

    it("消息段超上限（200）→ retcode 400", async () => {
        const { deps } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        const segments = Array.from({ length: 201 }, () => ({
            type: "text",
            data: { text: "x" },
        }));
        expect((await action.handle({ group_id: 808, message: segments })).retcode).toBe(400);
    });

    it("WS 入口（websocketHandle）echo 原样带回", async () => {
        const { deps } = makeDeps();
        const action = sendActionOf(deps, "send_msg");
        const result = await action.websocketHandle({ group_id: 808, message: "hi" }, "echo-1");
        expect(result.echo).toBe("echo-1");
        expect(result.retcode).toBe(0);
    });

    it("sendMessage 抛 KernelError SEND_FAILED → retcode 100", async () => {
        const { kernelError } = await import("@napuketto/kernel");
        const { deps } = makeDeps({
            sendMessage: vi.fn(async () => {
                throw kernelError("发送失败", "SEND_FAILED");
            }),
        });
        const action = sendActionOf(deps, "send_msg");
        const result = await action.handle({ group_id: 808, message: "hi" });
        expect(result.retcode).toBe(100);
        expect(result.status).toBe("failed");
    });
});

describe("send_private_msg", () => {
    it("user_id uin→uid → Peer{C2C, uid}", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_private_msg");
        const result = await action.handle({ user_id: 90001, message: "私信" });
        expect(result.retcode).toBe(0);
        const [peer] = sendMessage.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: ChatType.C2C, peerUid: "u90001" });
    });

    it("uin 解析不到 → retcode 105", async () => {
        const { deps } = makeDeps();
        const action = sendActionOf(
            {
                ...deps,
                uinToUid: vi.fn(async () => new Map<string, string>()),
            },
            "send_private_msg",
        );
        const result = await action.handle({ user_id: 11111, message: "私信" });
        expect(result.retcode).toBe(105);
    });
});

describe("send_group_msg", () => {
    it("group_id 直通 Peer{GROUP}", async () => {
        const { deps, sendMessage } = makeDeps();
        const action = sendActionOf(deps, "send_group_msg");
        const result = await action.handle({ group_id: 909, message: "群消息" });
        expect(result.retcode).toBe(0);
        const [peer] = sendMessage.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "909" });
    });
});
