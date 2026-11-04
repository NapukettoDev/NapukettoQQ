/**
 * satori/action/reaction.test.ts：reaction.create / reaction.delete 单测。
 *
 * 锁定：emojiType 固定 "1"、like 布尔方向、delete 带 user_id 报错（不支持
 * 删他人表态）、校验失败 400。
 */
import { describe, expect, it } from "vitest";
import type { ReactionActionDeps } from "../reaction.js";
import { ReactionCreateAction, ReactionDeleteAction } from "../reaction.js";
import { type StubSatoriApi, stubSatoriApi } from "./test-support.js";

function makeDeps(api: StubSatoriApi): ReactionActionDeps {
    return {
        msgApi: api.msgApi,
        resolvePeer: api.resolvePeer,
    } as unknown as ReactionActionDeps;
}

describe("ReactionCreateAction", () => {
    it("resolvePeer → setMsgEmojiLike（like=true，emojiType=1）", async () => {
        const api = stubSatoriApi();
        const action = new ReactionCreateAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", message_id: "seq-9", emoji_id: "178" }),
        ).resolves.toBeUndefined();
        expect(api.msgApi.setMsgEmojiLike).toHaveBeenCalledWith(
            { chatType: 2, peerUid: "10001" },
            { msgSeq: "seq-9", emojiId: "178", emojiType: "1", like: true },
        );
    });

    it("缺 emoji_id → 400", async () => {
        const action = new ReactionCreateAction(makeDeps(stubSatoriApi()));
        await expect(
            action.run({ channel_id: "10001", message_id: "seq-9" }),
        ).rejects.toMatchObject({ status: 400 });
    });
});

describe("ReactionDeleteAction", () => {
    it("不带 user_id：删除自己的表态（like=false）", async () => {
        const api = stubSatoriApi();
        const action = new ReactionDeleteAction(makeDeps(api));
        await expect(
            action.run({ channel_id: "10001", message_id: "seq-9", emoji_id: "178" }),
        ).resolves.toBeUndefined();
        expect(api.msgApi.setMsgEmojiLike).toHaveBeenCalledWith(
            { chatType: 2, peerUid: "10001" },
            { msgSeq: "seq-9", emojiId: "178", emojiType: "1", like: false },
        );
    });

    it("带 user_id：抛「暂不支持删除他人表态」（500）", async () => {
        const api = stubSatoriApi();
        const action = new ReactionDeleteAction(makeDeps(api));
        await expect(
            action.run({
                channel_id: "10001",
                message_id: "seq-9",
                emoji_id: "178",
                user_id: "123",
            }),
        ).rejects.toMatchObject({ status: 500, message: "暂不支持删除他人表态" });
        expect(api.msgApi.setMsgEmojiLike).not.toHaveBeenCalled();
    });
});
