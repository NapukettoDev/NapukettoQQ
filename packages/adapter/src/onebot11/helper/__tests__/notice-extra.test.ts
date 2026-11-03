/**
 * notice-extra.test.ts：扩展源 notice 翻译单测（c3，2026-09-10）。
 *
 * 覆盖：narrowOfflineFiles 防御性收窄（RawMessage 型 / 专用实体型 / 未知形状）
 * 与 toOfflineFileNotice 字段映射。payload 真实形状待校准——用例固化当前
 * 收窄口径，校准后回填。
 */
import { describe, expect, it } from "vitest";
import { narrowOfflineFiles, toOfflineFileNotice } from "../notice-extra.js";

describe("narrowOfflineFiles：防御性收窄", () => {
    it("RawMessage 数组型（elements[].fileElement）→ 归一化项", () => {
        const arg = [
            {
                senderUin: "90009",
                elements: [
                    { elementType: 11, fileElement: { fileName: "a.exe", fileSize: "1024" } },
                ],
            },
        ];
        expect(narrowOfflineFiles(arg)).toEqual([
            { senderUin: "90009", name: "a.exe", size: 1024, url: "" },
        ]);
    });

    it("单个 RawMessage 型（非数组）→ 单项", () => {
        const arg = {
            senderUin: "90009",
            elements: [
                { fileElement: { fileName: "b.zip", fileSize: 2048, fileUrl: "https://x" } },
            ],
        };
        expect(narrowOfflineFiles(arg)).toEqual([
            { senderUin: "90009", name: "b.zip", size: 2048, url: "https://x" },
        ]);
    });

    it("专用实体型（顶层 fileName）→ 归一化项（senderUin 优先于 fromUin）", () => {
        const arg = [{ senderUin: "1", fromUin: "2", fileName: "c.pdf", fileSize: "9" }];
        expect(narrowOfflineFiles(arg)).toEqual([
            { senderUin: "1", name: "c.pdf", size: 9, url: "" },
        ]);
    });

    it("专用实体型（fileInfo 嵌套）→ 归一化项", () => {
        const arg = { fromUin: "2", fileInfo: { fileName: "d.txt", fileSize: 5, url: "u" } };
        expect(narrowOfflineFiles(arg)).toEqual([
            { senderUin: "2", name: "d.txt", size: 5, url: "u" },
        ]);
    });

    it("sender uin 缺失 → 0 兜底（uid 串不硬转）", () => {
        const arg = [{ senderUid: "u_xxx", fileName: "e.md", fileSize: 1 }];
        expect(narrowOfflineFiles(arg)).toEqual([
            { senderUin: "0", name: "e.md", size: 1, url: "" },
        ]);
    });

    it("未知形状 / 无文件元素 / 空数组 → null（调用方打 raw 日志）", () => {
        expect(narrowOfflineFiles({ foo: 1 })).toBeNull();
        expect(narrowOfflineFiles([{ elements: [{ picElement: {} }] }])).toBeNull();
        expect(narrowOfflineFiles([])).toBeNull();
        expect(narrowOfflineFiles(null)).toBeNull();
        expect(narrowOfflineFiles("str")).toBeNull();
    });
});

describe("toOfflineFileNotice：字段映射", () => {
    it("归一化项 → OB11 offline_file notice", () => {
        const event = toOfflineFileNotice(
            { senderUin: "90009", name: "a.exe", size: 1024, url: "https://x" },
            "10001",
        );
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "offline_file",
            self_id: 10001,
            user_id: 90009,
            file: { name: "a.exe", size: 1024, url: "https://x" },
        });
        expect(event.time).toBeGreaterThan(0);
    });
});
