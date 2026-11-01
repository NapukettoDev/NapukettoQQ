/**
 * friend_file_upload 翻译单测（批次三；形状依据 2026-11-01 二轮录制定型）
 */

import type { RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toFriendFileUploadData } from "./file-upload.js";

/** 构造 C2C 文件消息（录制实证形状：fileSize 字符串 + file10MMd5 + fileUuid）。 */
function fileMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "1001",
        msgSeq: "5",
        msgTime: "1793540000",
        msgType: 1,
        chatType: 1,
        peerUid: "u_FRIEND",
        peerUin: "10001",
        senderUid: "u_FRIEND",
        senderUin: "10001",
        peerName: "",
        sendNickName: "",
        sendType: 0,
        elements: [
            {
                elementType: 10,
                fileElement: {
                    fileName: "报告.pdf",
                    fileSize: "204800",
                    fileUuid: "{UUID-1}",
                    file10MMd5: "d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5",
                    fileSha: "",
                    fileSha3: "",
                    subElementType: 9,
                },
            },
        ],
        ...overrides,
    } as RawMessage;
}

describe("toFriendFileUploadData", () => {
    it("收到（sendType 0）→ user_id=对端 / is_self=false / md5 充值 file_hash", () => {
        expect(toFriendFileUploadData(fileMsg(), "3567141148", new Map())).toEqual({
            user_id: 10001,
            file_id: "{UUID-1}",
            file_name: "报告.pdf",
            file_size: 204800,
            file_hash: "d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5",
            is_self: false,
        });
    });

    it("自己发出（sendType 2）→ is_self=true", () => {
        const msg = fileMsg({ sendType: 2, senderUin: "3567141148", senderUid: "u_SELF" });
        expect(toFriendFileUploadData(msg, "3567141148", new Map())?.is_self).toBe(true);
    });

    it("sendType 缺失时按发送者兜底 is_self", () => {
        const self = fileMsg();
        delete (self as { sendType?: number }).sendType;
        self.senderUin = "3567141148";
        expect(toFriendFileUploadData(self, "3567141148", new Map())?.is_self).toBe(true);
        const other = fileMsg();
        delete (other as { sendType?: number }).sendType;
        other.senderUin = "10001";
        expect(toFriendFileUploadData(other, "3567141148", new Map())?.is_self).toBe(false);
    });

    it("file10MMd5 缺失 → fileSha 兜底；两者皆缺 → 空串", () => {
        const msg = fileMsg();
        (msg.elements[0] as unknown as { fileElement: Record<string, unknown> }).fileElement = {
            fileName: "a",
            fileSize: "1",
            fileUuid: "{U}",
            fileSha: "sha1sha1",
        };
        expect(toFriendFileUploadData(msg, "3567141148", new Map())?.file_hash).toBe("sha1sha1");
        const empty = fileMsg();
        (empty.elements[0] as unknown as { fileElement: Record<string, unknown> }).fileElement = {
            fileName: "a",
            fileSize: "1",
            fileUuid: "{U}",
        };
        expect(toFriendFileUploadData(empty, "3567141148", new Map())?.file_hash).toBe("");
    });

    it("senderUin 缺失 → uid 反查 map；反查不得 → 0", () => {
        const msg = fileMsg({ senderUin: "" });
        const map = new Map([["u_FRIEND", "10001"]]);
        expect(toFriendFileUploadData(msg, "3567141148", map)?.user_id).toBe(10001);
        expect(toFriendFileUploadData(msg, "3567141148", new Map())?.user_id).toBe(0);
    });

    it("非 C2C / 无 fileElement / 无 fileUuid → null", () => {
        expect(
            toFriendFileUploadData(fileMsg({ chatType: 2 }), "3567141148", new Map()),
        ).toBeNull();
        const noFile = fileMsg();
        noFile.elements = [];
        expect(toFriendFileUploadData(noFile, "3567141148", new Map())).toBeNull();
        const noUuid = fileMsg();
        (noUuid.elements[0] as unknown as { fileElement: Record<string, unknown> }).fileElement = {
            fileName: "a",
        };
        expect(toFriendFileUploadData(noUuid, "3567141148", new Map())).toBeNull();
    });
});
