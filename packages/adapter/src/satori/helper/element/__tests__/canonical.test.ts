/**
 * canonical.ts 基线测试（fallow CRITICAL #5，untested risk）
 *
 * 锁定 canonicalToSatoriElements 的收方向映射规则：
 *  - text/image/face/voice/video/file/reply/forward 各类型的属性映射
 *  - at：uid→uin 批量转换（失败原样 uid）、name=display、id=all 特例
 *  - 宽容忽略：空 text、空 forward、json/xml/unknown
 */
import type { CanonicalElement } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { type CanonicalToSatoriDeps, canonicalToSatoriElements } from "../canonical.js";

describe("canonicalToSatoriElements", () => {
    it("text 非空 → Satori text；空 text 忽略", async () => {
        const out = await canonicalToSatoriElements([{ type: "text", text: "你好" }]);
        expect(out).toEqual([{ type: "text", text: "你好" }]);
        await expect(canonicalToSatoriElements([{ type: "text", text: "" }])).resolves.toEqual([]);
    });

    it("at id=all → Satori at all", async () => {
        await expect(canonicalToSatoriElements([{ type: "at", target: "all" }])).resolves.toEqual([
            { type: "at", attrs: { id: "all" } },
        ]);
    });

    it("at 普通 uid：无 uidToUin → 原样；有 → 批量转换", async () => {
        await expect(canonicalToSatoriElements([{ type: "at", target: "u1" }])).resolves.toEqual([
            { type: "at", attrs: { id: "u1" } },
        ]);
        const deps: CanonicalToSatoriDeps = {
            uidToUin: async (uids) => new Map(uids.map((u) => [u, `uin_${u}`] as const)),
        };
        await expect(
            canonicalToSatoriElements([{ type: "at", target: "u1" }], deps),
        ).resolves.toEqual([{ type: "at", attrs: { id: "uin_u1" } }]);
    });

    it("at display 非空 → name 属性；空 → 无 name", async () => {
        await expect(
            canonicalToSatoriElements([{ type: "at", target: "u1", display: "小明" }]),
        ).resolves.toEqual([{ type: "at", attrs: { id: "u1", name: "小明" } }]);
        await expect(
            canonicalToSatoriElements([{ type: "at", target: "u1", display: "" }]),
        ).resolves.toEqual([{ type: "at", attrs: { id: "u1" } }]);
    });

    it("uidToUin 失败 → at 原样 uid（不阻塞）", async () => {
        const deps: CanonicalToSatoriDeps = {
            uidToUin: async () => {
                throw new Error("转换失败");
            },
        };
        await expect(
            canonicalToSatoriElements([{ type: "at", target: "u1" }], deps),
        ).resolves.toEqual([{ type: "at", attrs: { id: "u1" } }]);
    });

    it("image：url 优先，缺 url 用 path", async () => {
        await expect(
            canonicalToSatoriElements([{ type: "image", path: "/p.png", url: "https://x/p.png" }]),
        ).resolves.toEqual([{ type: "img", attrs: { src: "https://x/p.png" } }]);
        await expect(
            canonicalToSatoriElements([{ type: "image", path: "/p.png" }]),
        ).resolves.toEqual([{ type: "img", attrs: { src: "/p.png" } }]);
    });

    it("face → emoji；voice → audio；video → video（url ?? path）", async () => {
        await expect(canonicalToSatoriElements([{ type: "face", id: "127" }])).resolves.toEqual([
            { type: "emoji", attrs: { id: "127" } },
        ]);
        await expect(
            canonicalToSatoriElements([{ type: "voice", path: "/v.silk" }]),
        ).resolves.toEqual([{ type: "audio", attrs: { src: "/v.silk" } }]);
        await expect(
            canonicalToSatoriElements([{ type: "video", path: "/v.mp4" }]),
        ).resolves.toEqual([{ type: "video", attrs: { src: "/v.mp4" } }]);
    });

    it("file：path → src，name 非空 → title", async () => {
        await expect(
            canonicalToSatoriElements([{ type: "file", path: "/f.bin", name: "文档" }]),
        ).resolves.toEqual([{ type: "file", attrs: { src: "/f.bin", title: "文档" } }]);
        await expect(
            canonicalToSatoriElements([{ type: "file", path: "/f.bin" }]),
        ).resolves.toEqual([{ type: "file", attrs: { src: "/f.bin" } }]);
    });

    it("reply → quote", async () => {
        await expect(
            canonicalToSatoriElements([{ type: "reply", messageId: "m1" }]),
        ).resolves.toEqual([{ type: "quote", attrs: { id: "m1" } }]);
    });

    it("forward：取首个 id → message；空 → 忽略", async () => {
        await expect(
            canonicalToSatoriElements([{ type: "forward", messageIds: ["m1", "m2"] }]),
        ).resolves.toEqual([{ type: "message", attrs: { forward: "", id: "m1" } }]);
        await expect(
            canonicalToSatoriElements([{ type: "forward", messageIds: [] }]),
        ).resolves.toEqual([]);
    });

    it("json / xml / unknown → 宽容忽略", async () => {
        const mixed: CanonicalElement[] = [
            { type: "json", raw: { a: 1 } },
            { type: "xml", raw: "<a/>" },
            { type: "unknown", raw: {} },
        ];
        await expect(canonicalToSatoriElements(mixed)).resolves.toEqual([]);
    });

    it("混合列表：保留顺序、忽略空项", async () => {
        const mixed: CanonicalElement[] = [
            { type: "text", text: "" },
            { type: "text", text: "a" },
            { type: "at", target: "u1" },
            { type: "json", raw: {} },
        ];
        await expect(canonicalToSatoriElements(mixed)).resolves.toEqual([
            { type: "text", text: "a" },
            { type: "at", attrs: { id: "u1" } },
        ]);
    });
});
