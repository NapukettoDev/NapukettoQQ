/**
 * qq-releases.test.ts：下载 URL 归一化 + 清单 URL 解析单测。
 *
 * 背景（issue #6 根因，2026-10-07 实测）：腾讯 CDN 边缘 WAF 对字面量
 * `/QQNTV2/` 路径段 **区分大小写** 地拦截（403 + Content-Length: 0，
 * Return Directly 不回源），而源站对路径大小写不敏感。normalizeDownloadUrl
 * 是唯一绕行点，这里锁住语义：只改该路径段大小写，其余原样不动。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { QqReleaseEntry } from "../qq-releases.js";
import { normalizeDownloadUrl, resolveDownloadUrl } from "../qq-releases.js";

/** 官方 rainbow 配置给出的 x64 下载 URL（大小写即官方原样，直接请求必 403）。 */
const OFFICIAL_9_9_36 =
    "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe";

/** 归一化后的等价 URL（实测 200 OK / 330446512 字节 / PE 头 MZ）。 */
const NORMALIZED_9_9_36 =
    "https://qqdl.gtimg.cn/qqfile/qqntv2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe";

/** 旧版官方 URL（`QQNT` 段未被拦截，归一化不应触碰）。 */
const OFFICIAL_QQNT_9_9_33 =
    "https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/a0ce07ad/QQ_9.9.33_260730_x64_01.exe";

/** 测试期间改动过的环境变量原值（undefined = 原本不存在；afterEach 恢复）。 */
const touchedEnv = new Map<string, string | undefined>();

/** 设置环境变量并记录原值，供 afterEach 精确恢复。 */
function setEnv(key: string, value: string | undefined): void {
    if (!touchedEnv.has(key)) {
        touchedEnv.set(key, process.env[key]);
    }
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

afterEach(() => {
    for (const [key, original] of touchedEnv) {
        if (original === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = original;
        }
    }
    touchedEnv.clear();
});

describe("normalizeDownloadUrl", () => {
    it("把官方 /QQNTV2/ 路径段降为小写", () => {
        expect(normalizeDownloadUrl(OFFICIAL_9_9_36)).toBe(NORMALIZED_9_9_36);
    });

    it("任意大小写组合都归一为小写", () => {
        expect(normalizeDownloadUrl("https://h/qqfile/QqNtV2/9.9.36/a.exe")).toBe(
            "https://h/qqfile/qqntv2/9.9.36/a.exe",
        );
    });

    it("已是小写时幂等（可安全重复调用）", () => {
        expect(normalizeDownloadUrl(NORMALIZED_9_9_36)).toBe(NORMALIZED_9_9_36);
    });

    it("不含该路径段时原样返回，不误伤其它 URL", () => {
        expect(normalizeDownloadUrl(OFFICIAL_QQNT_9_9_33)).toBe(OFFICIAL_QQNT_9_9_33);
        const pcdir = "https://dldir1.qq.com/qqfile/qq/PCQQ/PCQQ9.7.25/QQ9.7.25.29417.exe";
        expect(normalizeDownloadUrl(pcdir)).toBe(pcdir);
    });

    it("只改路径段，不动查询串与其余段", () => {
        const url = "https://h/qqfile/QQNTV2/9.9.36/release/ab/QQ_x64_01.exe?sign=QQNTV2";
        expect(normalizeDownloadUrl(url)).toBe(
            "https://h/qqfile/qqntv2/9.9.36/release/ab/QQ_x64_01.exe?sign=QQNTV2",
        );
    });
});

describe("resolveDownloadUrl", () => {
    /** 最小清单条目（官方原样 URL）。 */
    const release: QqReleaseEntry = {
        version: "9.9.36-52406",
        url: OFFICIAL_9_9_36,
        sha256: "",
        appid: 0,
        source: "official",
    };

    it("无 NAPUTO_QQ_URL 时返回清单里的官方原样 URL（归一化只在请求时做）", () => {
        setEnv("NAPUTO_QQ_URL", undefined);
        expect(resolveDownloadUrl(release)).toBe(OFFICIAL_9_9_36);
    });

    it("NAPUTO_QQ_URL 非空时覆盖清单 URL", () => {
        setEnv("NAPUTO_QQ_URL", "https://example.test/custom.exe");
        expect(resolveDownloadUrl(release)).toBe("https://example.test/custom.exe");
    });

    it("NAPUTO_QQ_URL 为空串时回退清单 URL", () => {
        setEnv("NAPUTO_QQ_URL", "");
        expect(resolveDownloadUrl(release)).toBe(OFFICIAL_9_9_36);
    });
});
