/**
 * get-media.test.ts：get_image / get_record 单测（2026-09-08 T5 主动下载接入；
 * 2026-09-08 B1 语音接原生下载）。
 *
 * 覆盖：NT 相对路径本地解析（mediaBaseDir 命中/未命中）、图片 URL 主动下载
 * （fetch 桩 + cacheDir 落盘）、下载失败回退 url-only、语音本地命中 /
 * 原生 downloadPtt 落盘 / 下载失败回退原始路径。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage } from "@napuketto/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageUnique } from "../../../helper/message-unique.js";
import { GetImageAction, GetRecordAction, resolveLocalMediaFile } from "../get-media.js";

/** 桩依赖（msgApi.fetchMsgsByMsgId / downloadPtt 可控返回）。 */
function makeDeps(
    msg: RawMessage | null,
    extra: {
        mediaBaseDir?: string;
        cacheDir?: string;
        downloadPtt?: (msgId: string, peer: unknown) => Promise<unknown>;
    } = {},
) {
    const messageUnique = new MessageUnique();
    messageUnique.alloc(msg?.msgId ?? "m1", { chatType: 1, peerUid: "u1" });
    return {
        messageUnique,
        cacheDir: extra.cacheDir,
        mediaBaseDir: extra.mediaBaseDir,
        msgApi: {
            fetchMsgsByMsgId: vi.fn(async () => (msg === null ? [] : [msg])),
            ...(extra.downloadPtt !== undefined
                ? { downloadPtt: vi.fn(extra.downloadPtt) }
                : {
                      downloadPtt: vi.fn(async () => {
                          throw new Error("下载不可用");
                      }),
                  }),
        },
    } as unknown as ConstructorParameters<typeof GetImageAction>[0];
}

/** 图片消息工厂。 */
function picMsg(pic: Record<string, unknown>): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1",
        msgTime: "1700000000000",
        msgType: 2,
        chatType: 1,
        peerUid: "u1",
        peerUin: "10000",
        senderUid: "u1",
        senderUin: "10000",
        peerName: "",
        sendNickName: "",
        elements: [{ elementType: 2, picElement: pic }],
    } as unknown as RawMessage;
}

const dirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `napuketto-${prefix}-`));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
});

describe("resolveLocalMediaFile", () => {
    it("绝对路径存在直接返回；相对路径按 mediaBaseDir 拼接（反斜杠归一化）", () => {
        const base = tempDir("base");
        const rel = join(base, "nt_data", "Pic", "a.jpg").replaceAll("\\", "/");
        mkdirSync(join(base, "nt_data", "Pic"), { recursive: true });
        writeFileSync(rel, "x");
        expect(resolveLocalMediaFile(rel, { mediaBaseDir: base })).toBe(rel);
        expect(resolveLocalMediaFile("nt_data\\Pic\\a.jpg", { mediaBaseDir: base })).toContain(
            "a.jpg",
        );
    });

    it("mediaBaseDir 未注入 → 相对路径直接 null（base 分支跳过）", () => {
        expect(resolveLocalMediaFile("nt_data/a.jpg", {})).toBeNull();
    });

    it("未命中返回 null", () => {
        expect(resolveLocalMediaFile("nt_data/nope.jpg", { mediaBaseDir: "C:/nope" })).toBeNull();
        expect(resolveLocalMediaFile("", {})).toBeNull();
    });
});

describe("GetImageAction", () => {
    it("本地命中（sourcePath 按 mediaBaseDir 解析）→ file 绝对路径", async () => {
        const base = tempDir("img");
        const file = join(base, "nt_data/Pic/x.jpg").replaceAll("\\", "/");
        mkdirSync(join(base, "nt_data", "Pic"), { recursive: true });
        writeFileSync(file, "x");
        const deps = makeDeps(
            picMsg({ sourcePath: "nt_data/Pic/x.jpg", fileName: "x.jpg", fileSize: "1" }),
            { mediaBaseDir: base },
        );
        const result = (await new GetImageAction(deps).handle({ message_id: 1 })).data;
        expect(result?.file?.replaceAll("\\", "/")).toBe(file);
        expect(result?.file_name).toBe("x.jpg");
    });

    it("本地未命中 + picUrl → 主动下载到 cacheDir/media（fetch 桩）", async () => {
        const cache = tempDir("cache");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
        );
        const deps = makeDeps(
            picMsg({ sourcePath: "nt_data/Pic/remote.jpg", picUrl: "https://x/img.jpg" }),
            { mediaBaseDir: tempDir("base2"), cacheDir: cache },
        );
        const result = (await new GetImageAction(deps).handle({ message_id: 1 })).data;
        expect(result?.url).toBe("https://x/img.jpg");
        expect(result?.file).toBeDefined();
        expect(existsSync(result?.file as string)).toBe(true);
    });

    it("下载失败（非 2xx）→ 仅 url，不抛错", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("x", { status: 500 })),
        );
        const deps = makeDeps(picMsg({ picUrl: "https://x/img.jpg" }), {
            cacheDir: tempDir("cache2"),
        });
        const result = (await new GetImageAction(deps).handle({ message_id: 1 })).data;
        expect(result?.url).toBe("https://x/img.jpg");
        expect(result?.file).toBeUndefined();
    });

    it("未注入 cacheDir + picUrl → 跳过主动下载，仅返回 url", async () => {
        const deps = makeDeps(picMsg({ picUrl: "https://x/img.jpg" }), {});
        const result = (await new GetImageAction(deps).handle({ message_id: 1 })).data;
        expect(result?.url).toBe("https://x/img.jpg");
        expect(result?.file).toBeUndefined();
    });

    it("消息无 pic 元素 → retcode 102「不包含图片」", async () => {
        const deps = makeDeps(pttMsg({ filePath: "nt_data/Ptt/1.silk" }), {});
        const result = await new GetImageAction(deps).handle({ message_id: 1 });
        expect(result.retcode).toBe(102);
        expect(result.message).toContain("不包含图片");
    });

    it("message_id 与 file 都缺 → retcode 105「需要 message_id 或 file」", async () => {
        const deps = makeDeps(picMsg({ picUrl: "https://x/img.jpg" }), {});
        const result = await new GetImageAction(deps).handle({});
        expect(result.retcode).toBe(105);
        expect(result.message).toContain("get_image 需要 message_id 或 file");
    });

    it("消息已登记但 fetch 为空 → retcode 102「不存在或已被撤回」", async () => {
        const deps = makeDeps(null, {});
        const result = await new GetImageAction(deps).handle({ message_id: 1 });
        expect(result.retcode).toBe(102);
        expect(result.message).toContain("不存在或已被撤回");
    });

    it("file 参数兜底（message_id 缺省时用 file 反查）", async () => {
        const base = tempDir("img-file");
        const file = join(base, "nt_data/Pic/y.jpg").replaceAll("\\", "/");
        mkdirSync(join(base, "nt_data", "Pic"), { recursive: true });
        writeFileSync(file, "x");
        const deps = makeDeps(picMsg({ sourcePath: "nt_data/Pic/y.jpg", fileName: "y.jpg" }), {
            mediaBaseDir: base,
        });
        const result = (await new GetImageAction(deps).handle({ file: "1" })).data;
        expect(result?.file?.replaceAll("\\", "/")).toBe(file);
    });
});

/** 语音消息工厂。 */
function pttMsg(ptt: Record<string, unknown>): RawMessage {
    return {
        ...(picMsg({}) as object),
        elements: [{ elementType: 4, pttElement: ptt }],
    } as unknown as RawMessage;
}

describe("GetRecordAction", () => {
    it("本地命中 → file 绝对路径", async () => {
        const base = tempDir("voice");
        mkdirSync(join(base, "nt_data", "Ptt"), { recursive: true });
        writeFileSync(join(base, "nt_data/Ptt/1.silk").replaceAll("\\", "/"), "silk");
        const hit = (
            await new GetRecordAction(
                makeDeps(pttMsg({ filePath: "nt_data/Ptt/1.silk" }), { mediaBaseDir: base }),
            ).handle({ message_id: 1 })
        ).data;
        expect(hit?.file).toContain("1.silk");
    });

    it("本地未命中 + 原生下载落盘 → file 绝对路径（B1）", async () => {
        const base = tempDir("voice-dl");
        mkdirSync(join(base, "nt_data", "Ptt"), { recursive: true });
        const downloaded = join(base, "nt_data/Ptt/gone.silk").replaceAll("\\", "/");
        writeFileSync(downloaded, "silk");
        const result = (
            await new GetRecordAction(
                makeDeps(
                    pttMsg({
                        filePath: "nt_data/Ptt/gone.silk",
                        fileName: "gone.silk",
                        fileSize: "10",
                    }),
                    {
                        mediaBaseDir: base,
                        downloadPtt: async () => ({
                            filePath: downloaded,
                            fileName: "gone.silk",
                            fileSize: "10",
                            transferStatus: 2,
                        }),
                    },
                ),
            ).handle({ message_id: 1 })
        ).data;
        expect(result?.file?.replaceAll("\\", "/")).toBe(downloaded);
        expect(result?.file_name).toBe("gone.silk");
    });

    it("下载返回缺 fileSize/fileName → 省略元数据字段；无 filePath → 回退原始路径", async () => {
        const base = tempDir("voice-bare");
        mkdirSync(join(base, "nt_data", "Ptt"), { recursive: true });
        const downloaded = join(base, "nt_data/Ptt/bare.silk").replaceAll("\\", "/");
        writeFileSync(downloaded, "silk");
        // 返回值只有 filePath → file_size/file_name 省略（?? 判定右支）
        const bare = (
            await new GetRecordAction(
                makeDeps(pttMsg({ filePath: "nt_data/Ptt/bare.silk" }), {
                    mediaBaseDir: base,
                    downloadPtt: async () => ({ filePath: downloaded }),
                }),
            ).handle({ message_id: 1 })
        ).data;
        expect(bare?.file?.replaceAll("\\", "/")).toBe(downloaded);
        expect("file_size" in (bare as object)).toBe(false);
        expect("file_name" in (bare as object)).toBe(false);
        // 连 filePath 都没有 → 走回退（原始路径）
        const fallback = (
            await new GetRecordAction(
                makeDeps(
                    pttMsg({
                        filePath: "nt_data/Ptt/gone.silk",
                        fileName: "gone.silk",
                        fileSize: "3",
                    }),
                    { mediaBaseDir: tempDir("voice-none"), downloadPtt: async () => ({}) },
                ),
            ).handle({ message_id: 1 })
        ).data;
        expect(fallback?.file).toBe("nt_data/Ptt/gone.silk");
        expect(fallback?.file_name).toBe("gone.silk");
    });

    it("下载落盘返回值缺 fileSize/fileName → 本地命中后仅返回 file（元数据省略）", async () => {
        const base = tempDir("voice-dl-bare");
        mkdirSync(join(base, "nt_data", "Ptt"), { recursive: true });
        const landed = join(base, "nt_data/Ptt/landed.silk").replaceAll("\\", "/");
        writeFileSync(landed, "silk");
        const result = (
            await new GetRecordAction(
                makeDeps(pttMsg({ filePath: "nt_data/Ptt/gone.silk" }), {
                    mediaBaseDir: base,
                    downloadPtt: async () => ({ filePath: "nt_data/Ptt/landed.silk" }),
                }),
            ).handle({ message_id: 1 })
        ).data;
        expect(result?.file?.replaceAll("\\", "/")).toBe(landed);
        expect("file_size" in (result as object)).toBe(false);
        expect("file_name" in (result as object)).toBe(false);
    });

    it("下载返回的 filePath 本地仍不可解析 → 回退原始 filePath（transferStatus=2 空转场景）", async () => {
        const result = (
            await new GetRecordAction(
                makeDeps(
                    pttMsg({
                        filePath: "nt_data/Ptt/gone.silk",
                        fileName: "gone.silk",
                        fileSize: "10",
                    }),
                    {
                        mediaBaseDir: tempDir("voice-void"),
                        downloadPtt: async () => ({
                            filePath: "nt_data/Ptt/still-gone.silk",
                            fileName: "still-gone.silk",
                            fileSize: "99",
                        }),
                    },
                ),
            ).handle({ message_id: 1 })
        ).data;
        expect(result?.file).toBe("nt_data/Ptt/gone.silk");
        expect(result?.file_name).toBe("gone.silk");
        expect(result?.file_size).toBe("10");
    });

    it("本地未命中 + 下载失败/未落盘 → 回退原始 filePath + 元数据（不抛错）", async () => {
        const result = (
            await new GetRecordAction(
                makeDeps(
                    pttMsg({
                        filePath: "nt_data/Ptt/gone.silk",
                        fileName: "gone.silk",
                        fileSize: "10",
                    }),
                    {
                        mediaBaseDir: tempDir("voice-miss"),
                        downloadPtt: async () => {
                            throw new Error("语音下载未完成（超时）");
                        },
                    },
                ),
            ).handle({ message_id: 1 })
        ).data;
        expect(result?.file).toBe("nt_data/Ptt/gone.silk");
        expect(result?.file_name).toBe("gone.silk");
        expect(result?.file_size).toBe("10");
    });

    it("消息已登记但 fetch 为空 → retcode 102（record 同口径）", async () => {
        const deps = makeDeps(null, {});
        const result = await new GetRecordAction(deps).handle({ message_id: 1 });
        expect(result.retcode).toBe(102);
        expect(result.message).toContain("不存在或已被撤回");
    });

    it("原生下载落到 mediaBaseDir 外的绝对路径 → 返回下载后路径（B1 成功分支）", async () => {
        const base = tempDir("voice-dl-abs");
        const out = tempDir("voice-dl-abs-out");
        const downloaded = join(out, "gone.silk");
        writeFileSync(downloaded, "silk");
        const result = (
            await new GetRecordAction(
                makeDeps(
                    pttMsg({
                        filePath: "nt_data/Ptt/gone.silk",
                        fileName: "gone.silk",
                        fileSize: "10",
                    }),
                    {
                        mediaBaseDir: base,
                        downloadPtt: async () => ({
                            filePath: downloaded,
                            fileName: "gone.silk",
                            fileSize: "10",
                        }),
                    },
                ),
            ).handle({ message_id: 1 })
        ).data;
        expect(result?.file?.replaceAll("\\", "/")).toBe(downloaded.replaceAll("\\", "/"));
    });

    it("原生下载成功但未落盘（无 filePath）→ 回退原始路径", async () => {
        const result = (
            await new GetRecordAction(
                makeDeps(
                    pttMsg({
                        filePath: "nt_data/Ptt/gone.silk",
                        fileName: "gone.silk",
                        fileSize: "10",
                    }),
                    {
                        mediaBaseDir: tempDir("voice-empty"),
                        downloadPtt: async () => ({ fileName: "gone.silk", fileSize: "10" }),
                    },
                ),
            ).handle({ message_id: 1 })
        ).data;
        expect(result?.file).toBe("nt_data/Ptt/gone.silk");
    });

    it("消息无 ptt → NOT_FOUND", async () => {
        const result = await new GetRecordAction(
            makeDeps(picMsg({}), { mediaBaseDir: tempDir("voice-nop") }),
        ).handle({ message_id: 1 });
        expect(result.status).toBe("failed");
        expect(result.message).toContain("不包含语音");
    });
});
