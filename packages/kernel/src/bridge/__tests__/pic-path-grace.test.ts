/**
 * pic-path-grace 测试：入站图片落盘宽限等待（2026-11-14，issue #105）
 *
 *  - 无 pic / 路径已存在 → 快速路径立即返回
 *  - 路径缺失 → 等到出现（中途创建文件）或超时放行
 *  - 多消息多候选去重
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatType, type RawElement, type RawMessage } from "@napuketto/kernel";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ElementType } from "../../types/services/msg-service.js";
import { awaitPicLocalPaths } from "../pic-path-grace.js";

function makeMsg(elements: RawElement[]): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1",
        msgTime: "0",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "g1",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "1",
        peerName: "群",
        sendNickName: "",
        elements,
    };
}

let tmpDir: string;
const created: string[] = [];
beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "napuketto-grace-"));
});
afterEach(() => {
    for (const path of created.splice(0)) {
        rmSync(path, { force: true });
    }
});
afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

/** 在临时目录造一个尚不存在的目标路径（先删后用）。 */
function pendingPath(name: string): string {
    const path = join(tmpDir, name);
    rmSync(path, { force: true });
    created.push(path);
    return path;
}

function picMsg(picPath: string): RawMessage {
    return makeMsg([
        { elementType: ElementType.PIC, picElement: { picPath } } as unknown as RawElement,
    ]);
}

describe("awaitPicLocalPaths", () => {
    it("无 pic 元素 → 立即返回（快速路径）", async () => {
        const start = Date.now();
        await awaitPicLocalPaths(
            [makeMsg([{ elementType: ElementType.TEXT, textElement: { content: "x" } }])],
            { timeoutMs: 5000, intervalMs: 10 },
        );
        expect(Date.now() - start).toBeLessThan(200);
    });

    it("路径已存在 → 立即返回", async () => {
        const path = pendingPath("exists.png");
        writeFileSync(path, "x");
        const start = Date.now();
        await awaitPicLocalPaths([picMsg(path)], { timeoutMs: 5000, intervalMs: 10 });
        expect(Date.now() - start).toBeLessThan(200);
    });

    it("路径缺失 → 等待中途出现后返回（早于超时）", async () => {
        const path = pendingPath("late.png");
        setTimeout(() => writeFileSync(path, "x"), 120);
        const start = Date.now();
        await awaitPicLocalPaths([picMsg(path)], { timeoutMs: 5000, intervalMs: 30 });
        const elapsed = Date.now() - start;
        expect(existsSync(path)).toBe(true);
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThan(3000);
    });

    it("路径始终缺失 → 超时放行（约 timeoutMs）", async () => {
        const path = pendingPath("never.png");
        const start = Date.now();
        await awaitPicLocalPaths([picMsg(path)], { timeoutMs: 150, intervalMs: 30 });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(130);
        expect(elapsed).toBeLessThan(1000);
    });

    it("多消息同路径去重；任一候选出现即放行", async () => {
        const a = pendingPath("a.png");
        const b = pendingPath("b.png");
        setTimeout(() => writeFileSync(b, "x"), 100);
        const start = Date.now();
        await awaitPicLocalPaths([picMsg(a), picMsg(b), picMsg(a)], {
            timeoutMs: 5000,
            intervalMs: 30,
        });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(elapsed).toBeLessThan(3000);
    });
});
