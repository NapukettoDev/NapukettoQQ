/**
 * prepareImageElements：发送侧图片元数据归一化测试
 *
 * @napuketto/media 的 getImageSize / detectFileType 全部 mock（不依赖真实
 * 解码库）：断言「缺尺寸/MIME 的图片补齐、已有值不重复探测、探测失败只 warn
 * 并保留原元素、非图片元素原样穿过」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
    getImageSize: vi.fn(),
    detectFileType: vi.fn(),
}));

vi.mock("@napuketto/media", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getImageSize: media.getImageSize,
    detectFileType: media.detectFileType,
}));

import { prepareImageElements } from "../../../src/internal/qq/media.js";

/** 最小 logger 桩。 */
function makeLogger() {
    return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("prepareImageElements", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("缺 size + mime → getImageSize/detectFileType 补齐", async () => {
        media.getImageSize.mockResolvedValue({ width: 640, height: 480 });
        media.detectFileType.mockResolvedValue({ ext: "png", mime: "image/png" });

        const out = await prepareImageElements([{ type: "image", path: "/tmp/a.png" }]);

        expect(out).toEqual([
            {
                type: "image",
                path: "/tmp/a.png",
                size: { width: 640, height: 480 },
                mime: "image/png",
            },
        ]);
        expect(media.getImageSize).toHaveBeenCalledWith("/tmp/a.png");
        expect(media.detectFileType).toHaveBeenCalledWith("/tmp/a.png");
    });

    it("已有 size 只补 mime（不重复探测尺寸）", async () => {
        media.detectFileType.mockResolvedValue({ ext: "jpg", mime: "image/jpeg" });

        const out = await prepareImageElements(
            [{ type: "image", path: "/tmp/a.jpg", size: { width: 100, height: 50 } }],
            makeLogger(),
        );

        expect(out[0]).toMatchObject({ mime: "image/jpeg", size: { width: 100, height: 50 } });
        expect(media.getImageSize).not.toHaveBeenCalled();
        expect(media.detectFileType).toHaveBeenCalledTimes(1);
    });

    it("已有 mime 只补 size（不重复探测 MIME）", async () => {
        media.getImageSize.mockResolvedValue({ width: 32, height: 16 });

        const out = await prepareImageElements([
            { type: "image", path: "/tmp/a.webp", mime: "image/webp" },
        ]);

        expect(out[0]).toMatchObject({ size: { width: 32, height: 16 }, mime: "image/webp" });
        expect(media.getImageSize).toHaveBeenCalledTimes(1);
        expect(media.detectFileType).not.toHaveBeenCalled();
    });

    it("size + mime 齐全 → 原样返回且不做任何探测", async () => {
        const input = [
            {
                type: "image" as const,
                path: "/tmp/a.png",
                size: { width: 10, height: 20 },
                mime: "image/png",
            },
            { type: "text" as const, text: "hi" },
        ];

        const out = await prepareImageElements(input, makeLogger());

        expect(out).toEqual(input);
        expect(media.getImageSize).not.toHaveBeenCalled();
        expect(media.detectFileType).not.toHaveBeenCalled();
    });

    it("探测失败 → warn 并保留原元素，其余元素继续处理", async () => {
        const logger = makeLogger();
        media.getImageSize.mockRejectedValue(new Error("无法读取图片尺寸"));
        media.detectFileType.mockResolvedValue({ ext: "jpg", mime: "image/jpeg" });

        const broken = { type: "image" as const, path: "/tmp/broken.png" };
        const healthy = {
            type: "image" as const,
            path: "/tmp/ok.jpg",
            size: { width: 10, height: 10 },
        };
        const out = await prepareImageElements([broken, healthy], logger);

        expect(out[0]).toEqual(broken);
        expect(out[1]).toEqual({ ...healthy, mime: "image/jpeg" });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "/tmp/broken.png",
                error: expect.stringContaining("无法读取图片尺寸"),
            }),
            expect.any(String),
        );
    });

    it("非字符串 mime（IPC 脏值）→ 视为缺失并重新探测", async () => {
        media.getImageSize.mockResolvedValue({ width: 16, height: 9 });
        media.detectFileType.mockResolvedValue({ ext: "png", mime: "image/png" });

        const dirty = {
            type: "image" as const,
            path: "/tmp/dirty.png",
            mime: 42 as unknown as string,
        };
        const out = await prepareImageElements([dirty]);

        expect(out[0]).toEqual({
            type: "image",
            path: "/tmp/dirty.png",
            size: { width: 16, height: 9 },
            mime: "image/png",
        });
        expect(media.getImageSize).toHaveBeenCalledTimes(1);
        expect(media.detectFileType).toHaveBeenCalledTimes(1);
    });

    it("非图片元素原样穿过", async () => {
        const elements = [
            { type: "text" as const, text: "hi" },
            { type: "at" as const, target: "all" },
        ];
        await expect(prepareImageElements(elements)).resolves.toEqual(elements);
        expect(media.getImageSize).not.toHaveBeenCalled();
        expect(media.detectFileType).not.toHaveBeenCalled();
    });
});
