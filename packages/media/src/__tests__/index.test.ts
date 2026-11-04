/**
 * index.ts 包门面测试：锁定 re-export 面（媒体原语全量导出、类型常量可访问）。
 */
import { describe, expect, it } from "vitest";
import * as media from "../index.js";

describe("media 包门面", () => {
    it("导出全部运行时符号（函数 / 常量 / 错误类）", () => {
        expect(media.encodePcmToSilk).toBeDefined();
        expect(media.decodeSilkToPcm).toBeDefined();
        expect(media.decodeSilkToWav).toBeDefined();
        expect(media.getSilkInfo).toBeDefined();
        expect(media.downloadUrl).toBeDefined();
        expect(media.inferExtension).toBeDefined();
        expect(media.getImageSize).toBeDefined();
        expect(media.detectFileType).toBeDefined();
        expect(media.transcodeVideo).toBeDefined();
        expect(media.getVideoInfo).toBeDefined();
        expect(media.extractVideoFrame).toBeDefined();
        expect(media.MediaError).toBeDefined();
        expect(media.SILK_SAMPLE_RATE).toBe(24000);
    });

    it("SILK_SAMPLE_RATE 与 audio 模块一致（QQ 语音 24000Hz 契约）", () => {
        expect(media.SILK_SAMPLE_RATE).toBe(24_000);
    });

    it("MediaError 可实例化且 name 正确", () => {
        const err = new media.MediaError("facade");
        expect(err.name).toBe("MediaError");
    });
});
