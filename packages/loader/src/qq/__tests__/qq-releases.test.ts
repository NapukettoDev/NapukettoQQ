/**
 * qq-releases.test.ts：下载 URL 归一化 + 清单读取/解析单测。
 *
 * 背景（issue #6 根因，2026-10-07 实测）：腾讯 CDN 边缘 WAF 对字面量
 * `/QQNTV2/` 路径段 **区分大小写** 地拦截（403 + Content-Length: 0，
 * Return Directly 不回源），而源站对路径大小写不敏感。normalizeDownloadUrl
 * 是唯一绕行点，这里锁住语义：只改该路径段大小写，其余原样不动。
 *
 * loadQqReleases：node:fs 部分替身（readFileSync 按 mode 注入缺失/坏 JSON/
 * 结构非法，其余透传——真实 qq-releases.json 读取路径同样覆盖）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QqReleaseEntry } from "../qq-releases.js";
import {
    latestRelease,
    loadQqReleases,
    normalizeDownloadUrl,
    QqReleasesError,
    releasePlatform,
    resolveDownloadUrl,
} from "../qq-releases.js";

/** readFileSync 注入模式（null = 透传真实实现）。 */
const fsMode = vi.hoisted(() => {
    return { mode: null as null | "throw" | "bad-json" | "bad-schema" | "empty-known" };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
            switch (fsMode.mode) {
                case "throw":
                    throw new Error("ENOENT: 注入缺失");
                case "bad-json":
                    return "not-json{";
                case "bad-schema":
                    return JSON.stringify({ schema: 3, known: [{ version: "x" }] });
                case "empty-known":
                    return JSON.stringify({ schema: 2, known: [] });
                default:
                    return actual.readFileSync(path, ...(rest as []));
            }
        },
    };
});

afterEach(() => {
    fsMode.mode = null;
});

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

describe("loadQqReleases", () => {
    it("读取真实包根清单：schema=2 + Windows/Linux 条目（字段完整）", () => {
        const file = loadQqReleases();
        expect(file.schema).toBe(2);
        expect(file.known.length).toBeGreaterThan(0);
        // 用 latestRelease（真实安装链的选版口径）而非 find：known 会被
        // update-qq-releases 自动追加条目，断言具体版本号/首条匹配会让发布链
        // 在每次清单更新后红灯（2026-11-10 事故：追加了较旧的 3.2.34 条目）。
        const win = latestRelease(file, { platform: "win32", arch: "x64" });
        expect(win.version).toMatch(/^\d+\.\d+\.\d+-\d+$/);
        expect(win.url).toMatch(/^https:\/\//);
        expect(typeof win.appid).toBe("number");
        expect(win.source).toBe("official");
        const linux = latestRelease(file, { platform: "linux", arch: "x64" });
        expect(linux.version).toMatch(/^\d+\.\d+\.\d+-\d+$/);
        expect(linux.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(linux.url.endsWith(".deb")).toBe(true);
        expect(linux.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("清单文件缺失 → QqReleasesError（安装不完整提示）", () => {
        fsMode.mode = "throw";
        expect(() => loadQqReleases()).toThrow(QqReleasesError);
        expect(() => loadQqReleases()).toThrow(/版本清单缺失/);
    });

    it("JSON 解析失败 → QqReleasesError", () => {
        fsMode.mode = "bad-json";
        expect(() => loadQqReleases()).toThrow(/版本清单解析失败/);
    });

    it("schema 不是 2 / known 非数组 → QqReleasesError（结构不合法）", () => {
        fsMode.mode = "bad-schema";
        expect(() => loadQqReleases()).toThrow(QqReleasesError);
    });

    it("known 为空数组 → QqReleasesError", () => {
        fsMode.mode = "empty-known";
        expect(() => loadQqReleases()).toThrow(QqReleasesError);
    });
});

describe("latestRelease", () => {
    /** 混装 Windows / Linux / arm64 的清单（按录入顺序，末项未必是目标平台最新）。 */
    const file = {
        schema: 2,
        known: [
            {
                version: "9.9.30-1",
                url: "https://a/old.exe",
                sha256: "",
                appid: 0,
                source: "official",
            },
            {
                version: "9.9.31-2",
                url: "https://a/new.exe",
                sha256: "",
                appid: 0,
                source: "official",
            },
            {
                version: "3.2.35-54395",
                platform: "linux",
                arch: "x64",
                coreVersion: "9.9.37",
                url: "https://a/qq.deb",
                sha256: "",
                appid: 0,
                source: "official",
            },
        ],
    } satisfies Parameters<typeof latestRelease>[0];

    it("Windows：忽略 Linux 末项，按平台取最后一项", () => {
        expect(latestRelease(file, { platform: "win32", arch: "x64" }).version).toBe("9.9.31-2");
        expect(latestRelease(file, { platform: "win32" }).url).toBe("https://a/new.exe");
    });

    it("Linux：只取 linux 条目（不能直接取数组末项）", () => {
        const release = latestRelease(file, { platform: "linux", arch: "x64" });
        expect(release.version).toBe("3.2.35-54395");
        expect(release.url).toBe("https://a/qq.deb");
        expect(releasePlatform(release)).toBe("linux");
        expect(release.coreVersion).toBe("9.9.37");
    });

    it("无匹配平台/架构 → QqReleasesError", () => {
        expect(() => latestRelease(file, { platform: "linux", arch: "arm64" })).toThrow(
            QqReleasesError,
        );
    });

    it("空 known → QqReleasesError（防御：loadQqReleases 已拦，直传空仍安全）", () => {
        expect(() => latestRelease({ schema: 2, known: [] })).toThrow(QqReleasesError);
    });
});
