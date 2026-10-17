/**
 * msg.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 MsgApi 核心路径（mock session/service，不依赖真实 wrapper）：
 *  - constructor：getMsgService 空抛 INVALID_STATE
 *  - sendMessage / fetchMsgsByMsgId / fetchPttText / sendForwardMessage /
 *    fetchForwardMessage / recallMessage
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import type { NodeIQQNTWrapperSession, Peer } from "../../types/index.js";
import { MsgApi } from "../msg.js";

const target: Peer = { chatType: 1, peerUid: "10001" };

/** 构造 MsgApi（mock msg service）。 */
function makeApi(overrides: Record<string, unknown> = {}) {
    const service = {
        generateMsgUniqueId: vi.fn(() => "msgid-1"),
        sendMsg: vi.fn(async () => ({ result: 0 })),
        recallMsg: vi.fn(async () => ({ result: 0 })),
        getMsgs: vi.fn(async () => ({ result: 0, msgList: [] })),
        getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [] })),
        translatePtt2Text: vi.fn(async () => ({ result: 0 })),
        buildMultiForwardMsg: vi.fn(async () => ({ result: 0, rspInfo: { elements: [] } })),
        getMultiMsg: vi.fn(async () => ({ result: 0, msgList: [] })),
        forwardMsg: vi.fn(async () => ({ result: 0 })),
        setMsgEmojiLikes: vi.fn(async () => ({ result: 0 })),
        setStatus: vi.fn(async () => ({ result: 0 })),
        ...overrides,
    };
    const session = { getMsgService: () => service } as unknown as NodeIQQNTWrapperSession;
    return { service, api: new MsgApi(session) };
}

describe("constructor", () => {
    it("getMsgService 空抛 INVALID_STATE", () => {
        const session = { getMsgService: () => null } as unknown as NodeIQQNTWrapperSession;
        expect(() => new MsgApi(session)).toThrow(/getMsgService\(\) 返回空/);
    });
});

describe("sendMessage", () => {
    it("成功返回 msgId", async () => {
        const { api } = makeApi();
        await expect(api.sendMessage(target, [{ type: "text", text: "hi" }])).resolves.toEqual({
            msgId: "msgid-1",
        });
    });

    it("原生失败抛 KernelError", async () => {
        const { api } = makeApi({ sendMsg: vi.fn(async () => ({ result: -1 })) });
        await expect(api.sendMessage(target, [])).rejects.toBeInstanceOf(KernelError);
    });

    it("video → 完整 videoElement（路径放置 + Map thumbPath + 元数据）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "napuketto-kernel-video-"));
        const videoPath = join(dir, "clip.mp4");
        const thumbPath = join(dir, "clip.png");
        writeFileSync(videoPath, Buffer.from("video-bytes"));
        writeFileSync(thumbPath, Buffer.from("thumb-bytes"));
        try {
            const getRichMediaFilePathForGuild = vi.fn(
                (req: { downloadType: number; md5HexStr: string }) =>
                    req.downloadType === 2
                        ? `Video/2026-10/Thumb/${req.md5HexStr}_0.png`
                        : `Video/2026-10/Ori/${req.md5HexStr}.mp4`,
            );
            const sendMsg = vi.fn(async () => ({ result: 0 }));
            const { api } = makeApi({ getRichMediaFilePathForGuild, sendMsg });

            await api.sendMessage(target, [
                {
                    type: "video",
                    path: videoPath,
                    thumbPath,
                    width: 640,
                    height: 360,
                    durationSec: 3,
                },
            ]);

            const calls = getRichMediaFilePathForGuild.mock.calls;
            expect(calls).toHaveLength(2);
            expect(calls[0]?.[0]).toMatchObject({
                elementType: 5,
                downloadType: 1,
                md5HexStr: createHash("md5").update("video-bytes").digest("hex"),
            });
            expect(calls[1]?.[0]).toMatchObject({
                elementType: 5,
                downloadType: 2,
                // 缩略图目标路径用视频 md5（真实消息实测：Thumb/<videoMd5>_0.png）
                md5HexStr: createHash("md5").update("video-bytes").digest("hex"),
            });

            const sent = (sendMsg.mock.calls[0] as unknown[] | undefined)?.[2] as
                | Array<{ elementType: number; videoElement: Record<string, unknown> }>
                | undefined;
            const element = sent?.[0];
            expect(element?.elementType).toBe(5);
            const video = element?.videoElement ?? {};
            expect(video["fileName"]).toBe("clip.mp4");
            expect(video["filePath"]).toBe(
                `Video/2026-10/Ori/${createHash("md5").update("video-bytes").digest("hex")}.mp4`,
            );
            expect(video["fileSize"]).toBe(String(Buffer.byteLength("video-bytes")));
            expect(video["fileTime"]).toBe(3);
            expect(video["thumbMd5"]).toBe(createHash("md5").update("thumb-bytes").digest("hex"));
            expect(video["thumbSize"]).toBe(Buffer.byteLength("thumb-bytes"));
            expect(video["thumbWidth"]).toBe(640);
            expect(video["thumbHeight"]).toBe(360);
            const thumbMap = video["thumbPath"];
            expect(thumbMap).toBeInstanceOf(Map);
            expect((thumbMap as Map<number, string>).get(0)).toBe(
                `Video/2026-10/Thumb/${createHash("md5").update("video-bytes").digest("hex")}_0.png`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("recallMessage", () => {
    it("空 msgIds 抛 INVALID_PARAM", async () => {
        const { api } = makeApi();
        await expect(api.recallMessage(target, [])).rejects.toThrow(/至少一个非空 msgId/);
    });

    it("null msgIds 抛 INVALID_PARAM（而非裸 TypeError）", async () => {
        const { api } = makeApi();
        await expect(api.recallMessage(target, null as unknown as string[])).rejects.toThrow(
            /必须是数组/,
        );
    });

    it("空字符串 msgId 清洗后抛 INVALID_PARAM", async () => {
        const { api } = makeApi();
        await expect(api.recallMessage(target, ["", "  "])).rejects.toThrow(/至少一个非空 msgId/);
    });

    it("混合脏值只撤回有效 msgId", async () => {
        const { api, service } = makeApi();
        await api.recallMessage(target, ["m1", "", "  ", null as unknown as string]);
        expect(service.recallMsg).toHaveBeenCalledWith(target, ["m1"]);
    });

    it("成功调用 recallMsg", async () => {
        const { api, service } = makeApi();
        await api.recallMessage(target, ["m1"]);
        expect(service.recallMsg).toHaveBeenCalledWith(target, ["m1"]);
    });
});

describe("fetchPttText", () => {
    it("消息含 ptt 且转写成功", async () => {
        const pttMsg = {
            msgId: "m1",
            elements: [{ pttElement: { text: "" } }],
        };
        const afterMsg = {
            msgId: "m1",
            elements: [{ pttElement: { text: "转写结果" } }],
        };
        const { api, service } = makeApi({
            getMsgsByMsgId: vi
                .fn()
                .mockResolvedValueOnce({ result: 0, msgList: [pttMsg] })
                .mockResolvedValueOnce({ result: 0, msgList: [afterMsg] }),
        });
        await expect(api.fetchPttText("m1", target)).resolves.toBe("转写结果");
        expect(service.translatePtt2Text).toHaveBeenCalled();
    });

    it("消息无 ptt 抛 NOT_FOUND", async () => {
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [{ msgId: "m1", elements: [{ textElement: { text: "x" } }] }],
            })),
        });
        await expect(api.fetchPttText("m1", target)).rejects.toThrow(/不包含语音/);
    });

    it("消息不存在抛 NOT_FOUND", async () => {
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [] })),
        });
        await expect(api.fetchPttText("m1", target)).rejects.toThrow(/不包含语音/);
    });
});

describe("sendForwardMessage", () => {
    it("空 srcMsgIds 抛 INVALID_PARAM", async () => {
        const { api } = makeApi();
        await expect(api.sendForwardMessage(target, target, [])).rejects.toThrow(/至少一条源消息/);
    });

    it("成功返回 msgId", async () => {
        const { api, service } = makeApi({
            buildMultiForwardMsg: vi.fn(async () => ({
                result: 0,
                rspInfo: { elements: [{ textElement: { text: "x" } }] },
            })),
        });
        await expect(api.sendForwardMessage(target, target, ["s1"])).resolves.toEqual({
            msgId: "msgid-1",
        });
        expect(service.sendMsg).toHaveBeenCalled();
    });

    it("组装无元素抛 UNKNOWN", async () => {
        const { api } = makeApi();
        await expect(api.sendForwardMessage(target, target, ["s1"])).rejects.toThrow(
            /合并转发组装失败/,
        );
    });
});

describe("fetchForwardMessage", () => {
    it("消息含合并转发且取到内容", async () => {
        const forwardMsg = {
            msgId: "m1",
            elements: [{ multiForwardMsgElement: { resId: "r1" } }],
        };
        const { api, service } = makeApi({
            getMultiMsg: vi.fn(async () => ({
                result: 0,
                msgList: [{ msgId: "inner" }],
            })),
        });
        (service.getMsgsByMsgId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            result: 0,
            msgList: [forwardMsg],
        });
        await expect(api.fetchForwardMessage(target, "m1")).resolves.toEqual([{ msgId: "inner" }]);
    });

    it("消息无合并转发抛 NOT_FOUND", async () => {
        const { api } = makeApi();
        api as unknown as { fetchMsgsByMsgId: ReturnType<typeof vi.fn> };
        const service = (
            api as unknown as { service: { getMsgsByMsgId: ReturnType<typeof vi.fn> } }
        ).service;
        service.getMsgsByMsgId.mockResolvedValueOnce({
            result: 0,
            msgList: [{ msgId: "m1", elements: [{ textElement: { text: "x" } }] }],
        });
        await expect(api.fetchForwardMessage(target, "m1")).rejects.toThrow(/不包含合并转发/);
    });
});

describe("downloadPtt（语音主动下载，2026-09-08 B1）", () => {
    const pttMsg = {
        msgId: "m1",
        elements: [{ elementId: "e1", pttElement: { fileName: "a.amr" } }],
    };

    it("调 downloadRichMedia 后轮询到已完成态返回 ptt", async () => {
        const downloaded = {
            msgId: "m1",
            elements: [
                {
                    elementId: "e1",
                    pttElement: { fileName: "a.amr", filePath: "C:/x/a.amr", transferStatus: 2 },
                },
            ],
        };
        const downloadRichMedia = vi.fn(async () => undefined);
        const { api } = makeApi({
            downloadRichMedia,
            getMsgsByMsgId: vi
                .fn()
                .mockResolvedValueOnce({ result: 0, msgList: [pttMsg] })
                .mockResolvedValue({ result: 0, msgList: [downloaded] }),
        });
        await expect(api.downloadPtt("m1", target)).resolves.toMatchObject({
            filePath: "C:/x/a.amr",
            transferStatus: 2,
        });
        expect(downloadRichMedia).toHaveBeenCalledWith({
            msgId: "m1",
            elemId: "e1",
            chatType: target.chatType,
            downloadType: 2,
            thumbSize: 0,
        });
    });

    it("transferStatus=4（自己发送）也算完成", async () => {
        const sent = {
            msgId: "m1",
            elements: [
                {
                    elementId: "e1",
                    pttElement: { filePath: "C:/x/a.amr", transferStatus: 4 },
                },
            ],
        };
        const { api } = makeApi({
            downloadRichMedia: vi.fn(async () => undefined),
            getMsgsByMsgId: vi
                .fn()
                .mockResolvedValueOnce({ result: 0, msgList: [pttMsg] })
                .mockResolvedValue({ result: 0, msgList: [sent] }),
        });
        await expect(api.downloadPtt("m1", target)).resolves.toMatchObject({ transferStatus: 4 });
    });

    it("消息无 ptt 抛 NOT_FOUND", async () => {
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [{ msgId: "m1", elements: [{ textElement: { text: "x" } }] }],
            })),
        });
        await expect(api.downloadPtt("m1", target)).rejects.toThrow(/不包含语音/);
    });

    it("轮询超时抛 TIMEOUT（fake timers 加速 34 轮）", async () => {
        vi.useFakeTimers();
        try {
            const pending = {
                msgId: "m1",
                elements: [
                    {
                        elementId: "e1",
                        pttElement: { fileName: "a.amr", transferStatus: 0 },
                    },
                ],
            };
            const { api } = makeApi({
                downloadRichMedia: vi.fn(async () => undefined),
                getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [pending] })),
            });
            const promise = api.downloadPtt("m1", target);
            // expect(...).rejects 立即挂上 handler,先推进 fake timers 再断言
            const assertion = expect(promise).rejects.toThrow(/语音下载未完成/);
            for (let i = 0; i < 40; i++) {
                await vi.advanceTimersByTimeAsync(300);
            }
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});
