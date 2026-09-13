/**
 * translate.test.ts：QQ → MC 富文本降级 + MC → QQ 模板渲染（任务书阶段 2）。
 */

import type { RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import {
    degradeElements,
    degradeMessage,
    MAX_GROUP_TEXT_LENGTH,
    renderCommandResult,
    renderDeathText,
    renderTemplate,
    resolveSenderName,
    truncateForGroup,
} from "./translate.js";

/** 合成群消息（elements 按用例给）。 */
function groupMsg(elements: RawMessage["elements"], extra?: Partial<RawMessage>): RawMessage {
    return {
        msgId: "1",
        msgSeq: "1",
        msgTime: "0",
        msgType: 2,
        chatType: 2,
        peerUid: "808",
        peerUin: "808",
        senderUid: "u_20002",
        senderUin: "20002",
        peerName: "测试群",
        sendNickName: "昵称",
        elements,
        ...extra,
    };
}

describe("QQ → MC 富文本降级", () => {
    it("text 原文；@ 显示名；@全体 → @全体成员", () => {
        expect(
            degradeElements([
                { type: "text", text: "看这个 " },
                { type: "at", target: "u_1", display: "小明" },
                { type: "text", text: " " },
                { type: "at", target: "all" },
            ]),
        ).toBe("看这个 @小明 @全体成员");
    });

    it("at 无 display → @uid 兜底", () => {
        expect(degradeElements([{ type: "at", target: "u_9" }])).toBe("@u_9");
    });

    it("图片/表情/回复占位；富文本混排", () => {
        expect(
            degradeElements([
                { type: "reply", messageId: "m1" },
                { type: "image", path: "" },
                { type: "text", text: "哈哈" },
                { type: "face", id: "12" },
            ]),
        ).toBe("[回复][图片]哈哈[表情]");
    });

    it("无法表达的类型静默跳过（voice/video/file/forward/json/xml/unknown）", () => {
        expect(
            degradeElements([
                { type: "text", text: "a" },
                { type: "voice", path: "x" },
                { type: "video", path: "x" },
                { type: "file", path: "x" },
                { type: "forward", messageIds: ["m"] },
                { type: "json", raw: "{}" },
                { type: "xml", raw: "<x/>" },
                { type: "unknown", raw: {} },
                { type: "text", text: "b" },
            ]),
        ).toBe("ab");
    });

    it("纯富媒体消息：降级为占位文本（不发 null）", () => {
        expect(degradeElements([{ type: "image", path: "" }])).toBe("[图片]");
        expect(degradeElements([{ type: "face", id: "1" }])).toBe("[表情]");
    });

    it("纯空白文本 → null（不发）；空元素 → null", () => {
        expect(degradeElements([{ type: "text", text: "   " }])).toBeNull();
        expect(degradeElements([])).toBeNull();
    });

    it("degradeMessage：RawMessage 便捷封装", () => {
        expect(
            degradeMessage(groupMsg([{ elementType: 1, textElement: { content: "正文" } }])),
        ).toBe("正文");
    });

    it("sender 名：sendMemberName ?? sendNickName ?? senderUin", () => {
        expect(resolveSenderName(groupMsg([]))).toBe("昵称");
        expect(resolveSenderName(groupMsg([], { sendMemberName: "群名片" }))).toBe("群名片");
        expect(resolveSenderName(groupMsg([], { sendNickName: "" }))).toBe("20002");
    });
});

describe("MC → QQ 渲染", () => {
    it("模板占位符替换（{player}/{content}/{message}）", () => {
        expect(renderTemplate("[{player}] {content}", { player: "Steve", content: "hi" })).toBe(
            "[Steve] hi",
        );
        expect(renderTemplate("{player} 加入了服务器", { player: "Steve" })).toBe(
            "Steve 加入了服务器",
        );
        expect(renderTemplate("未知 {nope} 保留", { player: "A" })).toBe("未知 {nope} 保留");
    });

    it("death：message 空串以「死亡了」代入", () => {
        expect(renderDeathText("{player} {message}", "Alex", "fell from a high place")).toBe(
            "Alex fell from a high place",
        );
        expect(renderDeathText("{player} {message}", "Alex", "")).toBe("Alex 死亡了");
    });

    it("command_result：ok 合并 output（\\n）；空 output 占位；error 分支", () => {
        expect(renderCommandResult({ ok: true, output: ["line1", "line2"] })).toBe("line1\nline2");
        expect(renderCommandResult({ ok: true })).toBe("（命令执行成功，无输出）");
        expect(renderCommandResult({ ok: false, error: "permission denied" })).toBe(
            "命令失败：permission denied",
        );
    });

    it("1500 字符截断：恰好上限不截，超限截断加 …(截断)", () => {
        const at = "x".repeat(MAX_GROUP_TEXT_LENGTH);
        expect(truncateForGroup(at)).toBe(at);
        const over = `${at}!`;
        expect(truncateForGroup(over)).toBe(`${at}…(截断)`);
        expect(truncateForGroup(over).length).toBe(MAX_GROUP_TEXT_LENGTH + 5);
    });
});
