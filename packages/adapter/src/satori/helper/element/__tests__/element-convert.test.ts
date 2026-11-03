/**
 * element-convert.ts 基线测试（fallow refactoring target #2，high impact）
 * 锁定 satoriToCanonicalElements / parseContentToCanonical 现有行为。
 *
 * 媒体元素用本地路径（resolveAsset 无 IO 原样返回）；audio 用 #!SILK 头
 * 临时文件（避免真实转码）；http(s) src 不做测试（会真实下载）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    parseContentToCanonical,
    type SatoriToCanonicalDeps,
    satoriToCanonicalElements,
} from "../element-convert.js";

// transcodeVideo mock（video 归一化测试用，vi.hoisted 供工厂引用）
const transcodeMock = vi.hoisted(() => vi.fn(async (input: string) => `${input}.mp4`));
vi.mock("@napuketto/media", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@napuketto/media")>()),
    transcodeVideo: transcodeMock,
}));

let tempDir = "";

beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "napuketto-test-"));
    // #!SILK 头文件：ensureSilk 直接原样返回，不触发转码
    writeFileSync(
        join(tempDir, "voice.silk"),
        Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(2)]),
    );
});

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

/** 测试 deps：uin→uid 批量映射 + 临时缓存目录。 */
function makeDeps(uinToUid?: SatoriToCanonicalDeps["uinToUid"]): SatoriToCanonicalDeps {
    return {
        uinToUid: uinToUid ?? (async (uins) => new Map(uins.map((u) => [u, `uid_${u}`] as const))),
        cacheDir: tempDir,
    };
}

describe("satoriToCanonicalElements", () => {
    it("text 元素 → canonical text；空 text 跳过", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements([{ type: "text", text: "你好" }], deps),
        ).resolves.toEqual([{ type: "text", text: "你好" }]);
        await expect(
            satoriToCanonicalElements([{ type: "text", text: "" }], deps),
        ).resolves.toEqual([]);
    });

    it("at 元素批量 uin→uid（去重）", async () => {
        const calls: string[][] = [];
        const deps = makeDeps(async (uins) => {
            calls.push([...uins]);
            return new Map(uins.map((u) => [u, `uid_${u}`] as const));
        });
        await expect(
            satoriToCanonicalElements(
                [
                    { type: "at", attrs: { id: "123" } },
                    { type: "at", attrs: { id: "123" } },
                ],
                deps,
            ),
        ).resolves.toEqual([
            { type: "at", target: "uid_123" },
            { type: "at", target: "uid_123" },
        ]);
        expect(calls).toEqual([["123"]]);
    });

    it("at all / 无 id / name → display", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements([{ type: "at", attrs: { id: "all" } }], deps),
        ).resolves.toEqual([{ type: "at", target: "all" }]);
        await expect(satoriToCanonicalElements([{ type: "at" }], deps)).resolves.toEqual([]);
        await expect(
            satoriToCanonicalElements([{ type: "at", attrs: { id: "1", name: "小明" } }], deps),
        ).resolves.toEqual([{ type: "at", target: "uid_1", display: "小明" }]);
    });

    it("uinToUid 抛错 → at 原样保留 uin", async () => {
        const deps = makeDeps(async () => {
            throw new Error("boom");
        });
        await expect(
            satoriToCanonicalElements([{ type: "at", attrs: { id: "123" } }], deps),
        ).resolves.toEqual([{ type: "at", target: "123" }]);
    });

    it("emoji → face；quote → reply；br → 换行文本", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements(
                [
                    { type: "emoji", attrs: { id: "178" } },
                    { type: "quote", attrs: { id: "m1" } },
                    { type: "br" },
                ],
                deps,
            ),
        ).resolves.toEqual([
            { type: "face", id: "178" },
            { type: "reply", messageId: "m1" },
            { type: "text", text: "\n" },
        ]);
    });

    it("修饰元素（b/i/p 等）展开子元素", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements(
                [
                    {
                        type: "b",
                        children: [
                            { type: "text", text: "粗" },
                            { type: "text", text: "体" },
                        ],
                    },
                ],
                deps,
            ),
        ).resolves.toEqual([
            { type: "text", text: "粗" },
            { type: "text", text: "体" },
        ]);
    });

    it("author/sharp/a/button → 忽略", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements(
                [{ type: "author" }, { type: "sharp" }, { type: "a" }, { type: "button" }],
                deps,
            ),
        ).resolves.toEqual([]);
    });

    it("message 带 forward → forward；否则展开子元素", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements(
                [{ type: "message", attrs: { forward: "1", id: "f1" } }],
                deps,
            ),
        ).resolves.toEqual([{ type: "forward", messageIds: ["f1"] }]);
        await expect(
            satoriToCanonicalElements(
                [{ type: "message", children: [{ type: "text", text: "a" }] }],
                deps,
            ),
        ).resolves.toEqual([{ type: "text", text: "a" }]);
    });

    it("img/video 本地路径 → canonical（无下载）", async () => {
        const deps = makeDeps();
        const img = join(tempDir, "a.png");
        const video = join(tempDir, "a.mp4");
        await expect(
            satoriToCanonicalElements(
                [
                    { type: "img", attrs: { src: img } },
                    { type: "video", attrs: { src: video } },
                ],
                deps,
            ),
        ).resolves.toEqual([
            { type: "image", path: img },
            { type: "video", path: video },
        ]);
    });

    it("video：mp4 直通不转码；非 mp4 经 transcodeVideo 归一化", async () => {
        const deps = makeDeps();
        transcodeMock.mockClear();
        const mp4 = join(tempDir, "a.mp4");
        await expect(
            satoriToCanonicalElements([{ type: "video", attrs: { src: mp4 } }], deps),
        ).resolves.toEqual([{ type: "video", path: mp4 }]);
        expect(transcodeMock).not.toHaveBeenCalled();
        const webm = join(tempDir, "b.webm");
        writeFileSync(webm, "x");
        await expect(
            satoriToCanonicalElements([{ type: "video", attrs: { src: webm } }], deps),
        ).resolves.toEqual([{ type: "video", path: `${webm}.mp4` }]);
        expect(transcodeMock).toHaveBeenCalledWith(webm);
    });

    it("video：转码失败（transcodeMock 抛错）原样透传（fail-soft）", async () => {
        const deps = makeDeps();
        transcodeMock.mockRejectedValueOnce(new Error("no ffmpeg"));
        const webm = join(tempDir, "c.webm");
        writeFileSync(webm, "x");
        await expect(
            satoriToCanonicalElements([{ type: "video", attrs: { src: webm } }], deps),
        ).resolves.toEqual([{ type: "video", path: webm }]);
        transcodeMock.mockReset();
        transcodeMock.mockImplementation(async (input: string) => `${input}.mp4`);
    });

    it("audio #!SILK 文件 → voice（不转码）", async () => {
        const deps = makeDeps();
        const silk = join(tempDir, "voice.silk");
        await expect(
            satoriToCanonicalElements([{ type: "audio", attrs: { src: silk } }], deps),
        ).resolves.toEqual([{ type: "voice", path: silk }]);
    });

    it("file 本地路径 + title → name", async () => {
        const deps = makeDeps();
        const file = join(tempDir, "a.bin");
        await expect(
            satoriToCanonicalElements(
                [{ type: "file", attrs: { src: file, title: "文档" } }],
                deps,
            ),
        ).resolves.toEqual([{ type: "file", path: file, name: "文档" }]);
        await expect(
            satoriToCanonicalElements([{ type: "file", attrs: { src: file } }], deps),
        ).resolves.toEqual([{ type: "file", path: file }]);
    });

    it("internal: 路径 → 本地路径（_tmp 段回落）", async () => {
        const deps = makeDeps();
        await expect(
            satoriToCanonicalElements(
                [{ type: "img", attrs: { src: "internal:qq/10001/_tmp/x.png" } }],
                deps,
            ),
        ).resolves.toEqual([{ type: "image", path: "x.png" }]);
    });
});

describe("parseContentToCanonical", () => {
    it("content 字符串 → canonical（含 at 转换）", async () => {
        const deps = makeDeps();
        await expect(parseContentToCanonical('<at id="123"/>你好', deps)).resolves.toEqual([
            { type: "at", target: "uid_123" },
            { type: "text", text: "你好" },
        ]);
    });

    it("空 content → []", async () => {
        const deps = makeDeps();
        await expect(parseContentToCanonical("", deps)).resolves.toEqual([]);
    });
});
