/**
 * satori/action/reaction.test.ts：reaction.create / reaction.delete 单测。
 *
 * 锁定：原生 msgId、like 布尔方向、delete 带 user_id 报错（不支持
 * 删他人表态）、校验失败 400。
 */
import { kernelError } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../internal/__tests__/stub.js";
import type { ReactionActionDeps } from "../reaction.js";
import { createReactionActions } from "../reaction.js";
import { type StubSatoriApi, satoriActionOf, stubSatoriApi } from "./test-support.js";

function makeDeps(api: StubSatoriApi): ReactionActionDeps {
    return stub<ReactionActionDeps>({
        msgApi: api.msgApi,
        resolvePeer: api.resolvePeer,
    });
}

/** 构造指定表态动作（工厂产物按名取出）。 */
function actionOf<R>(api: StubSatoriApi, name: string) {
    return satoriActionOf<R>(createReactionActions(makeDeps(api)), name);
}

describe("reaction.create", () => {
    it("按频道解析会话，以原生 msgId 添加表态", async () => {
        const api = stubSatoriApi();
        const action = actionOf<void>(api, "reaction.create");
        await expect(
            action.run({ channel_id: "10001", message_id: "nt-msg-id", emoji_id: "178" }),
        ).resolves.toBeUndefined();
        expect(api.resolvePeer).toHaveBeenCalledWith("10001");
        expect(api.msgApi.setMsgEmojiLikeById).toHaveBeenCalledWith(
            { chatType: 2, peerUid: "10001" },
            { msgId: "nt-msg-id", emojiId: "178", like: true },
        );
    });

    it("缺 emoji_id → 400", async () => {
        const action = actionOf<void>(stubSatoriApi(), "reaction.create");
        await expect(
            action.run({ channel_id: "10001", message_id: "nt-msg-id" }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it.each([
        ["NOT_FOUND", 404],
        ["PERMISSION_DENIED", 403],
    ] as const)("将 %s 转为 HTTP %i", async (code, status) => {
        const api = stubSatoriApi();
        vi.mocked(api.msgApi.setMsgEmojiLikeById).mockRejectedValueOnce(
            kernelError("表态失败", code),
        );
        const action = actionOf<void>(api, "reaction.create");
        await expect(
            action.run({ channel_id: "10001", message_id: "nt-msg-id", emoji_id: "178" }),
        ).rejects.toMatchObject({ status });
    });
});

describe("reaction.delete", () => {
    it("不带 user_id：删除自己的表态（like=false）", async () => {
        const api = stubSatoriApi();
        const action = actionOf<void>(api, "reaction.delete");
        await expect(
            action.run({ channel_id: "10001", message_id: "nt-msg-id", emoji_id: "178" }),
        ).resolves.toBeUndefined();
        expect(api.msgApi.setMsgEmojiLikeById).toHaveBeenCalledWith(
            { chatType: 2, peerUid: "10001" },
            { msgId: "nt-msg-id", emojiId: "178", like: false },
        );
    });

    it("带 user_id：抛「暂不支持删除他人表态」（400）", async () => {
        const api = stubSatoriApi();
        const action = actionOf<void>(api, "reaction.delete");
        await expect(
            action.run({
                channel_id: "10001",
                message_id: "nt-msg-id",
                emoji_id: "178",
                user_id: "123",
            }),
        ).rejects.toMatchObject({ status: 400, message: "暂不支持删除他人表态" });
        expect(api.msgApi.setMsgEmojiLikeById).not.toHaveBeenCalled();
    });
});
