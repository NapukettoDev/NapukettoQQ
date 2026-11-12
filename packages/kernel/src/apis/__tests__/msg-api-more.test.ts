/**
 * msg.ts MsgApi 扩展测试（msg.test.ts 基线之外的 API 面与分支）：
 *  - fetchMessages / setMsgEmojiLike / markRead / setInputStatus / setOnlineStatus /
 *    forwardSingleMessage / queryFavEmojis（错误分支）
 *  - 富媒体发送预处理：PIC / PTT / FILE 链路（stat + md5 + placeMediaFile + copyFile）
 *  - util 形态分支：无 util / 构造器 get() / 实例无 copyFile
 *  - 事件通道确认：成功（sendStatus 2/3）/ 失败（0）→ SEND_FAILED /
 *    超时 → SEND_FAILED / 他人消息过滤（guildId 不匹配）
 *  - nextMsgTime 单调递增（同毫秒并发碰撞防护）
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import { KernelError } from "../../infra/index.js";
import type { MsgListener, NodeIQQNTWrapperSession, Peer } from "../../types/index.js";
import { ChatType } from "../../types/index.js";
import { MsgApi } from "../msg.js";

const target: Peer = { chatType: 1, peerUid: "10001" };

/** 构造 MsgApi（mock msg service，可选事件通道与 util）。 */
function makeApi(
    overrides: Record<string, unknown> = {},
    opts: { channel?: NTEventChannel<MsgListener, "Msg">; util?: unknown } = {},
) {
    const service = {
        generateMsgUniqueId: vi.fn(() => "msgid-1"),
        sendMsg: vi.fn(async () => ({ result: 0 })),
        recallMsg: vi.fn(async () => ({ result: 0 })),
        getMsgs: vi.fn(async () => ({ result: 0, msgList: [] })),
        getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [] })),
        setMsgEmojiLikes: vi.fn(async () => ({ result: 0 })),
        setMsgRead: vi.fn(async () => ({ result: 0 })),
        sendShowInputStatusReq: vi.fn(async () => undefined),
        setStatus: vi.fn(async () => ({ result: 0 })),
        forwardMsg: vi.fn(async () => ({ result: 0 })),
        queryFavEmojiByDesc: vi.fn(async () => ({ result: 0, emojiInfoList: [] })),
        getMultiMsg: vi.fn(async () => ({ result: 0, msgList: [] })),
        setContactLocalTop: vi.fn(async () => ({ result: 0 })),
        translatePtt2Text: vi.fn(async () => ({ result: 0 })),
        downloadRichMedia: vi.fn(async () => undefined),
        sendNudge: vi.fn(async () => ({ result: 0 })),
        ...overrides,
    };
    const session = { getMsgService: () => service } as unknown as NodeIQQNTWrapperSession;
    return { service, api: new MsgApi(session, opts.channel, opts.util) };
}

describe("查询与状态类 API", () => {
    it("fetchMessages：msgId 缺省从最新拉取，返回 msgList", async () => {
        const { api, service } = makeApi({
            getMsgs: vi.fn(async () => ({ result: 0, msgList: [{ msgId: "a" }, { msgId: "b" }] })),
        });
        await expect(api.fetchMessages(target, { count: 10 })).resolves.toHaveLength(2);
        expect(service.getMsgs).toHaveBeenCalledWith(target, "", 10, false);
    });

    it("fetchMessages：显式 msgId 透传；msgList 缺失 → 空数组；失败抛错", async () => {
        const { api, service } = makeApi({
            getMsgs: vi.fn(async () => ({ result: 0 })),
        });
        await expect(api.fetchMessages(target, { count: 5, msgId: "anchor" })).resolves.toEqual([]);
        expect(service.getMsgs).toHaveBeenCalledWith(target, "anchor", 5, false);
        const { api: api2 } = makeApi({
            getMsgs: vi.fn(async () => ({ result: 7, errMsg: "x" })),
        });
        await expect(api2.fetchMessages(target, { count: 5 })).rejects.toBeInstanceOf(KernelError);
    });

    it("fetchMsgsByMsgId：空 ids 直接返回空数组（不发调用）", async () => {
        const { api, service } = makeApi();
        await expect(api.fetchMsgsByMsgId(target, [])).resolves.toEqual([]);
        expect(service.getMsgsByMsgId).not.toHaveBeenCalled();
    });

    it("setMsgEmojiLike：五参透传；失败抛错", async () => {
        const { api, service } = makeApi();
        await api.setMsgEmojiLike(target, {
            msgSeq: "2",
            emojiId: "4",
            emojiType: "1",
            like: true,
        });
        expect(service.setMsgEmojiLikes).toHaveBeenCalledWith(target, "2", "4", "1", true);
        const { api: api2 } = makeApi({
            setMsgEmojiLikes: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(
            api2.setMsgEmojiLike(target, {
                msgSeq: "2",
                emojiId: "4",
                emojiType: "1",
                like: false,
            }),
        ).rejects.toBeInstanceOf(KernelError);
    });

    it("markRead：透传 target；失败抛错", async () => {
        const { api, service } = makeApi();
        await api.markRead(target);
        expect(service.setMsgRead).toHaveBeenCalledWith(target);
        const { api: api2 } = makeApi({
            setMsgRead: vi.fn(async () => ({ result: 3, errMsg: "x" })),
        });
        await expect(api2.markRead(target)).rejects.toBeInstanceOf(KernelError);
    });

    it("setInputStatus：chatType/eventType/peerUid 顺序透传", async () => {
        const { api, service } = makeApi();
        await api.setInputStatus(target, 1);
        expect(service.sendShowInputStatusReq).toHaveBeenCalledWith(1, 1, "10001");
    });

    it("setOnlineStatus：setStatus 透传；失败抛错", async () => {
        const { api, service } = makeApi();
        await api.setOnlineStatus({
            status: 1,
            extStatus: 0,
            batteryStatus: 80,
            customStatus: { faceId: "1", wording: "忙", faceType: "1" },
        });
        expect(service.setStatus).toHaveBeenCalledWith({
            status: 1,
            extStatus: 0,
            batteryStatus: 80,
            customStatus: { faceId: "1", wording: "忙", faceType: "1" },
        });
        const { api: api2 } = makeApi({
            setStatus: vi.fn(async () => ({ result: 9, errMsg: "x" })),
        });
        await expect(
            api2.setOnlineStatus({ status: 1, extStatus: 0, batteryStatus: 0 }),
        ).rejects.toBeInstanceOf(KernelError);
    });

    it("forwardSingleMessage：空 srcMsgIds 抛 INVALID_PARAM；成功透传 forwardMsg", async () => {
        const { api, service } = makeApi();
        await expect(api.forwardSingleMessage(target, [], target)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        const dst: Peer = { chatType: ChatType.GROUP, peerUid: "20002" };
        await api.forwardSingleMessage(target, ["m1", "m2"], dst);
        expect(service.forwardMsg).toHaveBeenCalledWith(["m1", "m2"], target, [dst], undefined);
    });

    it("forwardSingleMessage：forwardMsg 失败抛错", async () => {
        const { api } = makeApi({ forwardMsg: vi.fn(async () => ({ result: 5, errMsg: "x" })) });
        await expect(api.forwardSingleMessage(target, ["m1"], target)).rejects.toBeInstanceOf(
            KernelError,
        );
    });
});

describe("queryFavEmojis 分支", () => {
    it("service 抛裸异常包装 UNKNOWN", async () => {
        const { api } = makeApi({
            queryFavEmojiByDesc: vi.fn(async () => {
                throw new Error("net down");
            }),
        });
        await expect(api.queryFavEmojis()).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /queryFavEmojiByDesc 调用失败: net down/,
        });
    });

    it("emojiUrl 第三兜底字段；空串跳过", async () => {
        const { api } = makeApi({
            queryFavEmojiByDesc: vi.fn(async () => ({
                result: 0,
                emojiInfoList: [{ emojiUrl: "https://a/3" }, { url: "" }, null],
            })),
        });
        await expect(api.queryFavEmojis()).resolves.toEqual(["https://a/3"]);
    });
});

describe("富媒体发送预处理（PIC / PTT / FILE）", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "nk-test-msgapi-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** util 桩：copyFile 记录调用。 */
    function makeUtil() {
        const copyFile = vi.fn(async () => undefined);
        return { copyFile, util: { get: () => ({ copyFile }) } };
    }

    it("image：md5/大小/放置路径 + copyFile 调用（downloadType=1 Ori 路径）", async () => {
        const imgPath = join(dir, "pic.png");
        writeFileSync(imgPath, Buffer.from("image-bytes"));
        const { copyFile, util } = makeUtil();
        const getRichMediaFilePathForGuild = vi.fn(
            (req: {
                md5HexStr: string;
                elementType: number;
                downloadType: number;
                fileName: string;
            }) => `Pic/2026-11/Ori/${req.md5HexStr}.png`,
        );
        const { api, service } = makeApi({ getRichMediaFilePathForGuild }, { util });
        await api.sendMessage(target, [{ type: "image", path: imgPath }]);

        const md5 = createHash("md5").update("image-bytes").digest("hex");
        expect(getRichMediaFilePathForGuild).toHaveBeenCalledWith(
            expect.objectContaining({
                md5HexStr: md5,
                elementType: 2,
                downloadType: 1,
                fileName: "pic.png",
            }),
        );
        expect(copyFile).toHaveBeenCalledWith(imgPath, `Pic/2026-11/Ori/${md5}.png`);
        const sent = (service.sendMsg.mock.calls[0] as unknown[] | undefined)?.[2] as
            | Array<{ picElement: Record<string, unknown> }>
            | undefined;
        const pic = sent?.[0]?.picElement ?? {};
        expect(pic["md5HexStr"]).toBe(md5);
        expect(pic["fileSize"]).toBe(String(Buffer.byteLength("image-bytes")));
        expect(pic["sourcePath"]).toBe(`Pic/2026-11/Ori/${md5}.png`);
        expect(pic["original"]).toBe(true);
    });

    it("voice：silk 契约值 + 时长按 ~3KB/s 估算（最小 1）", async () => {
        const pttPath = join(dir, "a.silk");
        writeFileSync(pttPath, Buffer.alloc(1024 * 3 * 5, 1)); // 5s 码率估算
        const { util } = makeUtil();
        const { api, service } = makeApi(
            {
                getRichMediaFilePathForGuild: vi.fn(
                    (req: { md5HexStr: string }) => `Ptt/2026-11/Ori/${req.md5HexStr}.silk`,
                ),
            },
            { util },
        );
        await api.sendMessage(target, [{ type: "voice", path: pttPath }]);
        const sent = (service.sendMsg.mock.calls[0] as unknown[] | undefined)?.[2] as
            | Array<{ pttElement: Record<string, unknown> }>
            | undefined;
        const ptt = sent?.[0]?.pttElement ?? {};
        expect(ptt["duration"]).toBe(5);
        expect(ptt["formatType"]).toBe(1);
        expect(ptt["canConvert2Text"]).toBe(true);
        expect(ptt["waveAmplitudes"]).toHaveLength(15);
        expect(ptt["otherBusinessInfo"]).toEqual({ aiVoiceType: 0 });
        expect(ptt["storeID"]).toBe(0);
    });

    it("voice：小于 3KB 文件时长兜底 1 秒", async () => {
        const pttPath = join(dir, "short.silk");
        writeFileSync(pttPath, Buffer.alloc(100, 1));
        const { util } = makeUtil();
        const { api, service } = makeApi(
            {
                getRichMediaFilePathForGuild: vi.fn(
                    (req: { md5HexStr: string }) => `Ptt/2026-11/Ori/${req.md5HexStr}.silk`,
                ),
            },
            { util },
        );
        await api.sendMessage(target, [{ type: "voice", path: pttPath }]);
        const sent = (service.sendMsg.mock.calls[0] as unknown[] | undefined)?.[2] as
            | Array<{ pttElement: Record<string, unknown> }>
            | undefined;
        expect(sent?.[0]?.pttElement?.["duration"]).toBe(1);
    });

    it("file：显式 name 优先；fileElement 组装", async () => {
        const filePath = join(dir, "doc.pdf");
        writeFileSync(filePath, Buffer.from("file-bytes"));
        const { util } = makeUtil();
        const { api, service } = makeApi(
            {
                getRichMediaFilePathForGuild: vi.fn(
                    (req: { md5HexStr: string; elementType: number }) =>
                        `${req.elementType}/2026-11/Ori/${req.md5HexStr}`,
                ),
            },
            { util },
        );
        await api.sendMessage(target, [{ type: "file", path: filePath, name: "自定义名.pdf" }]);
        const sent = (service.sendMsg.mock.calls[0] as unknown[] | undefined)?.[2] as
            | Array<{ fileElement: Record<string, unknown> }>
            | undefined;
        const file = sent?.[0]?.fileElement ?? {};
        expect(file["fileName"]).toBe("自定义名.pdf");
        expect(file["fileSize"]).toBe(String(Buffer.byteLength("file-bytes")));
        expect(file["fileUuid"]).toBe("");
        expect(file["filePath"]).toContain("/Ori/");
    });

    it("file：无 name 用 basename；elementType=3（FILE）", async () => {
        const filePath = join(dir, "doc2.pdf");
        writeFileSync(filePath, Buffer.from("x"));
        const { util } = makeUtil();
        const getRichMediaFilePathForGuild = vi.fn(
            (req: { elementType: number }) => `t/${req.elementType}`,
        );
        const { api } = makeApi({ getRichMediaFilePathForGuild }, { util });
        await api.sendMessage(target, [{ type: "file", path: filePath }]);
        expect(getRichMediaFilePathForGuild).toHaveBeenCalledWith(
            expect.objectContaining({ elementType: 3 }),
        );
    });

    it("媒体文件不存在抛 INVALID_PARAM（图片/语音/文件标签）", async () => {
        const { api } = makeApi({}, {});
        await expect(
            api.sendMessage(target, [{ type: "image", path: join(dir, "no.png") }]),
        ).rejects.toMatchObject({
            code: "INVALID_PARAM",
            message: /图片文件不存在/,
        });
        await expect(
            api.sendMessage(target, [{ type: "voice", path: join(dir, "no.silk") }]),
        ).rejects.toMatchObject({
            message: /语音文件不存在/,
        });
        await expect(
            api.sendMessage(target, [{ type: "file", path: join(dir, "no.bin") }]),
        ).rejects.toMatchObject({ message: /文件文件不存在/ });
    });

    it("stat 通过但读内容失败（路径是目录）→ hashFile 抛 INVALID_PARAM", async () => {
        // 目录 stat 成功、readFile 报 EISDIR——覆盖 hashFile 的 catch 分支
        const { api } = makeApi({}, {});
        await expect(api.sendMessage(target, [{ type: "image", path: dir }])).rejects.toMatchObject(
            {
                code: "INVALID_PARAM",
                message: /图片文件读取失败/,
            },
        );
    });

    it("video：缺 durationSec/width/height → fileTime/thumbWidth/thumbHeight 兜底 0", async () => {
        const videoPath = join(dir, "v.mp4");
        const thumbPath = join(dir, "t.png");
        writeFileSync(videoPath, Buffer.from("video-bytes"));
        writeFileSync(thumbPath, Buffer.from("thumb-bytes"));
        const { util } = makeUtil();
        const { api, service } = makeApi(
            {
                getRichMediaFilePathForGuild: vi.fn((req: { downloadType: number }) =>
                    req.downloadType === 2
                        ? "Video/2026-11/Thumb/vmd5_0.png"
                        : "Video/2026-11/Ori/vmd5.mp4",
                ),
            },
            { util },
        );
        await api.sendMessage(target, [{ type: "video", path: videoPath, thumbPath } as never]);
        const sent = (service.sendMsg.mock.calls[0] as unknown[] | undefined)?.[2] as
            | Array<{ videoElement: Record<string, unknown> }>
            | undefined;
        const video = sent?.[0]?.videoElement ?? {};
        expect(video["fileTime"]).toBe(0);
        expect(video["thumbWidth"]).toBe(0);
        expect(video["thumbHeight"]).toBe(0);
        expect(video["thumbMd5"]).toBe(createHash("md5").update("thumb-bytes").digest("hex"));
        // 缩略图目标路径用视频 md5（契约：Thumb/<videoMd5>_0.png）
        expect(video["thumbPath"]).toBeInstanceOf(Map);
        expect((video["thumbPath"] as Map<number, string>).get(0)).toBe(
            "Video/2026-11/Thumb/vmd5_0.png",
        );
    });

    it("util 实例形态（无 get 方法）也能调用 copyFile；无 copyFile 静默跳过", async () => {
        const imgPath = join(dir, "p.png");
        writeFileSync(imgPath, Buffer.from("x"));
        const copyFile = vi.fn(async () => undefined);
        const { api } = makeApi(
            {
                getRichMediaFilePathForGuild: vi.fn(() => "rel/target.png"),
            },
            { util: { copyFile } },
        );
        await api.sendMessage(target, [{ type: "image", path: imgPath }]);
        expect(copyFile).toHaveBeenCalledWith(imgPath, "rel/target.png");

        const { api: api2 } = makeApi(
            {
                getRichMediaFilePathForGuild: vi.fn(() => "rel/target.png"),
                sendMsg: vi.fn(async () => ({ result: 0 })),
            },
            { util: { get: () => ({ noCopy: 1 }) } },
        );
        await expect(api2.sendMessage(target, [{ type: "image", path: imgPath }])).resolves.toEqual(
            {
                msgId: "msgid-1",
            },
        );
    });

    it("无 util 时跳过 copyFile 仍能发送", async () => {
        const imgPath = join(dir, "p.png");
        writeFileSync(imgPath, Buffer.from("x"));
        const { api } = makeApi({
            getRichMediaFilePathForGuild: vi.fn(() => "rel/target.png"),
        });
        await expect(api.sendMessage(target, [{ type: "image", path: imgPath }])).resolves.toEqual({
            msgId: "msgid-1",
        });
    });
});

describe("事件通道发送确认（confirmSend）", () => {
    function makeChannel() {
        return new NTEventChannel<MsgListener, "Msg">("Msg");
    }

    /** flush 微任务：等 sendMessage 注册完确认监听后再 emit。 */
    async function flush(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    it("sendStatus=2 确认成功；guildId 不匹配的消息不干扰", async () => {
        const channel = makeChannel();
        const { api } = makeApi({}, { channel });
        const promise = api.sendMessage(target, []);
        const assertion = expect(promise).resolves.toEqual({ msgId: "msgid-1" });
        await flush();
        // 他人消息（guildId 不匹配）先到：不触发确认
        channel.emit("Msg/onMsgInfoListUpdate", [{ guildId: "other", sendStatus: 2 } as never]);
        // 再推本次消息成功态
        channel.emit("Msg/onMsgInfoListUpdate", [{ guildId: "msgid-1", sendStatus: 2 } as never]);
        await assertion;
    });

    it("确认事件带真实 msgId → 以事件 msgId 为准（Linux E2E 实测）", async () => {
        const channel = makeChannel();
        const { api } = makeApi({}, { channel });
        const promise = api.sendMessage(target, []);
        const assertion = expect(promise).resolves.toEqual({ msgId: "real-nt-id" });
        await flush();
        // 生成的 id 只落在 guildId 上；真正可 get_msg/recall 的是 msgId
        channel.emit("Msg/onMsgInfoListUpdate", [
            { guildId: "msgid-1", msgId: "real-nt-id", sendStatus: 2 } as never,
        ]);
        await assertion;
    });

    it("sendStatus=3（成功无 seq）同样确认成功", async () => {
        const channel = makeChannel();
        const { api } = makeApi({}, { channel });
        const promise = api.sendMessage(target, []);
        const assertion = expect(promise).resolves.toEqual({ msgId: "msgid-1" });
        await flush();
        channel.emit("Msg/onMsgInfoListUpdate", [{ guildId: "msgid-1", sendStatus: 3 } as never]);
        await assertion;
    });

    it("sendStatus=0 → SEND_FAILED（sendMsg 返回值不论成败以事件为准）", async () => {
        const channel = makeChannel();
        const { api } = makeApi({}, { channel });
        const promise = api.sendMessage(target, []);
        const assertion = expect(promise).rejects.toMatchObject({ code: "SEND_FAILED" });
        await flush();
        channel.emit("Msg/onMsgInfoListUpdate", [{ guildId: "msgid-1", sendStatus: 0 } as never]);
        await assertion;
    });

    it("sendStatus=1（发送中）继续等待，后续成功仍确认", async () => {
        const channel = makeChannel();
        const { api } = makeApi({}, { channel });
        const promise = api.sendMessage(target, []);
        const assertion = expect(promise).resolves.toEqual({ msgId: "msgid-1" });
        await flush();
        channel.emit("Msg/onMsgInfoListUpdate", [{ guildId: "msgid-1", sendStatus: 1 } as never]);
        channel.emit("Msg/onMsgInfoListUpdate", [{ guildId: "msgid-1", sendStatus: 2 } as never]);
        await assertion;
    });

    it("确认超时（15s 无事件）→ SEND_FAILED（fake timers 加速）", async () => {
        vi.useFakeTimers();
        try {
            const channel = makeChannel();
            const { api } = makeApi({}, { channel });
            const promise = api.sendMessage(target, []);
            const assertion = expect(promise).rejects.toMatchObject({
                code: "SEND_FAILED",
                message: /等待确认超时/,
            });
            await vi.advanceTimersByTimeAsync(15_100);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("nextMsgTime 单调递增（同毫秒并发防护）", () => {
    it("同毫秒两次发送 msgId 时间戳严格递增", async () => {
        const times: string[] = [];
        const { api } = makeApi({
            generateMsgUniqueId: vi.fn((_chatType: number, time: string) => {
                times.push(time);
                return `id-${times.length}`;
            }),
        });
        await api.sendMessage(target, []);
        await api.sendMessage(target, []);
        expect(times).toHaveLength(2);
        expect(Number(times[1])).toBeGreaterThan(Number(times[0]));
    });

    it("时间回拨时仍严格递增（lastMsgTime + 1）", async () => {
        const times: string[] = [];
        const { api } = makeApi({
            generateMsgUniqueId: vi.fn((_chatType: number, time: string) => {
                times.push(time);
                return `id-${times.length}`;
            }),
        });
        // 第一次发送后把 Date.now 拨回过去
        const first = Date.now();
        const spy = vi
            .spyOn(Date, "now")
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(first - 5000);
        try {
            await api.sendMessage(target, []);
            await api.sendMessage(target, []);
        } finally {
            spy.mockRestore();
        }
        expect(Number(times[1])).toBe(Number(times[0]) + 1);
    });
});

describe("fetchMsgsByMsgId / fetchForwardMessage 缺省分支", () => {
    it("getMsgsByMsgId 成功但无 msgList → 空数组", async () => {
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.fetchMsgsByMsgId(target, ["m1"])).resolves.toEqual([]);
    });

    it("fetchForwardMessage：消息列表为空 → NOT_FOUND（不发 getMultiMsg）", async () => {
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [] })),
            getMultiMsg: vi.fn(async () => ({ result: 0, msgList: [] })),
        });
        await expect(api.fetchForwardMessage(target, "m1")).rejects.toMatchObject({
            code: "NOT_FOUND",
            message: /消息不包含合并转发内容/,
        });
        expect(service.getMultiMsg).not.toHaveBeenCalled();
    });

    it("fetchForwardMessage：getMultiMsg 成功但无 msgList → 空数组", async () => {
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [
                    {
                        msgId: "m1",
                        elements: [{ multiForwardMsgElement: { resId: "res-1" } }],
                    },
                ],
            })),
            getMultiMsg: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.fetchForwardMessage(target, "m1")).resolves.toEqual([]);
        expect(service.getMultiMsg).toHaveBeenCalledWith(target, "m1", "res-1");
    });
});

describe("sendNudge / setContactTop 错误语义", () => {
    it("sendNudge：checkLooseResult 抛 KernelError → 原样上抛（不二次包装）", async () => {
        const { api } = makeApi({
            sendNudge: vi.fn(async () => ({ result: 1, errMsg: "param invalid" })),
        });
        await expect(
            api.sendNudge(target, { receiverUid: "r1", callerUid: "c1" }),
        ).rejects.toMatchObject({ code: "UNKNOWN", message: /sendNudge 失败/ });
    });

    it("sendNudge：非 Error 异常 → UNKNOWN 包装（errMsgString 兜底）", async () => {
        const { api } = makeApi({
            // 原生偶发抛非 Error 值（字符串等），errMsgString 需兜底 String()
            sendNudge: vi.fn(async () => {
                throw "raw-string-boom";
            }),
        });
        await expect(
            api.sendNudge(target, { receiverUid: "r1", callerUid: "c1" }),
        ).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /sendNudge 调用失败: raw-string-boom/,
        });
    });

    it("setContactTop：result 非 0 → KernelError 原样上抛", async () => {
        const { api } = makeApi({
            setContactLocalTop: vi.fn(async () => ({ result: 2, errMsg: "busy" })),
        });
        await expect(api.setContactTop(target, true)).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /setContactLocalTop 失败/,
        });
    });

    it("setContactTop：裸异常 → UNKNOWN 包装", async () => {
        const { api } = makeApi({
            setContactLocalTop: vi.fn(async () => {
                throw new Error("socket down");
            }),
        });
        await expect(api.setContactTop(target, false)).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /setContactLocalTop 调用失败: socket down/,
        });
    });

    it("setContactTop：成功透传 target 与 isTop", async () => {
        const { api, service } = makeApi({
            setContactLocalTop: vi.fn(async () => ({ result: 0 })),
        });
        await expect(api.setContactTop(target, true)).resolves.toBeUndefined();
        expect(service.setContactLocalTop).toHaveBeenCalledWith(target, true);
    });
});

describe("fetchPttText 转写分支", () => {
    it("转写后 text 仍为空串 → UNKNOWN", async () => {
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [
                    { msgId: "m1", elements: [{ pttElement: { filePath: "/a.silk", text: "" } }] },
                ],
            })),
            translatePtt2Text: vi.fn(async () => ({ result: 0 })),
        });
        await expect(api.fetchPttText("m1", target)).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /获取语音转文字结果失败/,
        });
        expect(service.translatePtt2Text).toHaveBeenCalledTimes(1);
    });

    it("转写成功 → 返回非空 text", async () => {
        let calls = 0;
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () => {
                calls += 1;
                return {
                    result: 0,
                    msgList: [
                        {
                            msgId: "m1",
                            elements: [
                                {
                                    pttElement: {
                                        filePath: "/a.silk",
                                        text: calls > 1 ? "识别文本" : "",
                                    },
                                },
                            ],
                        },
                    ],
                };
            }),
            translatePtt2Text: vi.fn(async () => ({ result: 0 })),
        });
        await expect(api.fetchPttText("m1", target)).resolves.toBe("识别文本");
    });
});

describe("downloadPtt 轮询（fake timers 加速 300ms 间隔）", () => {
    /** 构造带语音元素的消息（elementId 是元素级字段，elemId 反查用它）。 */
    function pttMsg(ptt: Record<string, unknown>, elementId?: string): unknown {
        return {
            result: 0,
            msgList: [
                {
                    msgId: "m1",
                    elements: [
                        {
                            pttElement: ptt,
                            ...(elementId !== undefined ? { elementId } : {}),
                        },
                    ],
                },
            ],
        };
    }

    it("轮询命中 transferStatus=2 → 立即返回元素", async () => {
        vi.useFakeTimers();
        try {
            const { api, service } = makeApi({
                getMsgsByMsgId: vi
                    .fn()
                    .mockResolvedValueOnce(pttMsg({ filePath: "", transferStatus: 1 }, "e1"))
                    .mockResolvedValue(
                        pttMsg({ filePath: "/ori/a.silk", transferStatus: 2 }, "e1"),
                    ),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadPtt("m1", target);
            const assertion = expect(promise).resolves.toMatchObject({
                filePath: "/ori/a.silk",
                transferStatus: 2,
            });
            await vi.advanceTimersByTimeAsync(300);
            await assertion;
            expect(service.downloadRichMedia).toHaveBeenCalledWith(
                expect.objectContaining({ msgId: "m1", elemId: "e1", downloadType: 2 }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("轮询中途消息无语音元素 → 记 null 继续；末次轮询有路径未完成也尽力返回", async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () => {
                    calls += 1;
                    if (calls === 1) {
                        return pttMsg({ filePath: "", transferStatus: 1 }, "e1");
                    }
                    // 中间轮次：消息没有 ptt 元素（pttDownloadResult 入参 undefined）
                    if (calls < 5) {
                        return { result: 0, msgList: [{ msgId: "m1", elements: [] }] };
                    }
                    return pttMsg({ filePath: "/ori/a.silk", transferStatus: 1 }, "e1");
                }),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadPtt("m1", target);
            const assertion = expect(promise).resolves.toMatchObject({ filePath: "/ori/a.silk" });
            // 第 5 次起有路径但未完成 → 一直轮到末次（isLastPoll=true）才返回
            await vi.advanceTimersByTimeAsync(300 * 35);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("全程有路径但传输未完成 → 末次轮询（isLastPoll）尽力返回", async () => {
        vi.useFakeTimers();
        try {
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () =>
                    pttMsg({ filePath: "/ori/a.silk", transferStatus: 1 }, "e1"),
                ),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadPtt("m1", target);
            const assertion = expect(promise).resolves.toMatchObject({
                filePath: "/ori/a.silk",
                transferStatus: 1,
            });
            // 34 轮 × 300ms：最后一轮 isLastPoll=true 命中
            await vi.advanceTimersByTimeAsync(300 * 35);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("全程无路径 → TIMEOUT 抛错", async () => {
        vi.useFakeTimers();
        try {
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () =>
                    pttMsg({ filePath: "", transferStatus: 1 }, "e1"),
                ),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadPtt("m1", target);
            const assertion = expect(promise).rejects.toMatchObject({
                code: "TIMEOUT",
                message: /语音下载未完成/,
            });
            await vi.advanceTimersByTimeAsync(300 * 35);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("首查无语音元素 → NOT_FOUND（不触发下载）", async () => {
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [{ msgId: "m1", elements: [] }],
            })),
            downloadRichMedia: vi.fn(async () => undefined),
        });
        await expect(api.downloadPtt("m1", target)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(service.downloadRichMedia).not.toHaveBeenCalled();
    });

    it("elementId 缺省 → downloadRichMedia 以空串占位", async () => {
        vi.useFakeTimers();
        try {
            const { api, service } = makeApi({
                getMsgsByMsgId: vi
                    .fn()
                    .mockResolvedValueOnce(pttMsg({ filePath: "", transferStatus: 1 }))
                    .mockResolvedValue(pttMsg({ filePath: "/ori/a.silk", transferStatus: 2 })),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadPtt("m1", target);
            await vi.advanceTimersByTimeAsync(300);
            await expect(promise).resolves.toBeDefined();
            expect(service.downloadRichMedia).toHaveBeenCalledWith(
                expect.objectContaining({ elemId: "" }),
            );
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("downloadImage（入站图片按需下载，issue #105）", () => {
    let dir = "";

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-imgdl-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** 构造带图片元素的消息（elementId 是元素级字段）。 */
    function picMsg(pic: Record<string, unknown>, elementId?: string): unknown {
        return {
            result: 0,
            msgList: [
                {
                    msgId: "m1",
                    elements: [
                        {
                            picElement: pic,
                            ...(elementId !== undefined ? { elementId } : {}),
                        },
                    ],
                },
            ],
        };
    }

    it("本地已落盘 → 直接返回，不触发下载", async () => {
        const file = join(dir, "a.jpg");
        writeFileSync(file, "x");
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => picMsg({ sourcePath: file }, "e1")),
        });
        await expect(api.downloadImage("m1", target)).resolves.toMatchObject({ filePath: file });
        expect(service.downloadRichMedia).not.toHaveBeenCalled();
    });

    it("未落盘 → downloadType=1 下载 + 轮询到文件出现", async () => {
        vi.useFakeTimers();
        try {
            const file = join(dir, "b.jpg");
            let polls = 0;
            const { api, service } = makeApi({
                getMsgsByMsgId: vi.fn(async () => {
                    polls += 1;
                    // 第二轮（首次轮询）起文件落盘
                    if (polls >= 2) {
                        writeFileSync(file, "y");
                    }
                    return picMsg({ sourcePath: file, fileName: "b.jpg" }, "e1");
                }),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadImage("m1", target);
            const assertion = expect(promise).resolves.toMatchObject({ filePath: file });
            await vi.advanceTimersByTimeAsync(300);
            await assertion;
            expect(service.downloadRichMedia).toHaveBeenCalledWith(
                expect.objectContaining({
                    msgId: "m1",
                    elemId: "e1",
                    downloadType: 1,
                    thumbSize: 0,
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("同消息多图：elementId 指定第二张（已落盘直接返回）", async () => {
        const existing = join(dir, "second.jpg");
        writeFileSync(existing, "z");
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [
                    {
                        msgId: "m1",
                        elements: [
                            {
                                elementId: "e1",
                                picElement: { sourcePath: join(dir, "first-missing.jpg") },
                            },
                            { elementId: "e2", picElement: { sourcePath: existing } },
                        ],
                    },
                ],
            })),
        });
        await expect(api.downloadImage("m1", target, { elementId: "e2" })).resolves.toMatchObject({
            filePath: existing,
        });
        expect(service.downloadRichMedia).not.toHaveBeenCalled();
    });

    it("轮询中途元素缺失 → 跳过继续轮询，文件出现后返回", async () => {
        vi.useFakeTimers();
        try {
            const file = join(dir, "late.jpg");
            let calls = 0;
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () => {
                    calls += 1;
                    if (calls === 1) {
                        return picMsg({ sourcePath: file }, "e1");
                    }
                    // 中间轮次：消息暂时没有 pic 元素（pic === undefined → continue）
                    if (calls < 4) {
                        return { result: 0, msgList: [{ msgId: "m1", elements: [] }] };
                    }
                    writeFileSync(file, "z");
                    return picMsg({ sourcePath: file }, "e1");
                }),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadImage("m1", target);
            const assertion = expect(promise).resolves.toMatchObject({ filePath: file });
            await vi.advanceTimersByTimeAsync(300 * 5);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("消息列表为空 → NOT_FOUND（不触发下载）", async () => {
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({ result: 0, msgList: [] })),
        });
        await expect(api.downloadImage("m1", target)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(service.downloadRichMedia).not.toHaveBeenCalled();
    });

    it("原图超时但缩略图已落盘 → 降级返回 720 缩略图（degraded）", async () => {
        vi.useFakeTimers();
        try {
            const thumb720 = join(dir, "t720.jpg");
            const thumb198 = join(dir, "t198.jpg");
            writeFileSync(thumb720, "t");
            writeFileSync(thumb198, "t");
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () =>
                    picMsg(
                        {
                            sourcePath: join(dir, "never.jpg"),
                            thumbPath: new Map<number, string>([
                                [198, thumb198],
                                [720, thumb720],
                                [0, ""],
                            ]),
                        },
                        "e1",
                    ),
                ),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadImage("m1", target, { timeoutMs: 600 });
            const assertion = expect(promise).resolves.toMatchObject({
                filePath: thumb720,
                degraded: true,
            });
            await vi.advanceTimersByTimeAsync(1_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("720 缺失/未落盘 → 退到 198（平面对象形态）", async () => {
        const thumb198 = join(dir, "p198.jpg");
        writeFileSync(thumb198, "t");
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () =>
                picMsg(
                    {
                        sourcePath: join(dir, "never.jpg"),
                        thumbPath: {
                            "720": join(dir, "gone-720.jpg"),
                            "198": thumb198,
                        },
                    },
                    "e1",
                ),
            ),
            downloadRichMedia: vi.fn(async () => undefined),
        });
        await expect(api.downloadImage("m1", target, { timeoutMs: 1 })).resolves.toMatchObject({
            filePath: thumb198,
            degraded: true,
        });
    });

    it("无 720/198/0 键 → 用其他 key 的已落盘缩略图", async () => {
        const other = join(dir, "x999.jpg");
        writeFileSync(other, "t");
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () =>
                picMsg({ sourcePath: join(dir, "never.jpg"), thumbPath: { "999": other } }, "e1"),
            ),
            downloadRichMedia: vi.fn(async () => undefined),
        });
        await expect(api.downloadImage("m1", target, { timeoutMs: 1 })).resolves.toMatchObject({
            filePath: other,
            degraded: true,
        });
    });

    it("thumbPath 字符串形态 → 直接当缩略图候选", async () => {
        const thumb = join(dir, "s.jpg");
        writeFileSync(thumb, "t");
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () =>
                picMsg({ sourcePath: join(dir, "never.jpg"), thumbPath: thumb }, "e1"),
            ),
            downloadRichMedia: vi.fn(async () => undefined),
        });
        await expect(api.downloadImage("m1", target, { timeoutMs: 1 })).resolves.toMatchObject({
            filePath: thumb,
            degraded: true,
        });
    });

    it("缩略图候选全不在磁盘 → 仍 TIMEOUT", async () => {
        vi.useFakeTimers();
        try {
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () =>
                    picMsg(
                        {
                            sourcePath: join(dir, "never.jpg"),
                            thumbPath: { "720": join(dir, "gone-720.jpg") },
                        },
                        "e1",
                    ),
                ),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadImage("m1", target, { timeoutMs: 600 });
            const assertion = expect(promise).rejects.toMatchObject({
                code: "TIMEOUT",
                message: /图片下载未完成/,
            });
            await vi.advanceTimersByTimeAsync(1_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("thumbPath 空串形态 → 视为无缩略图（TIMEOUT）", async () => {
        const { api } = makeApi({
            getMsgsByMsgId: vi.fn(async () =>
                picMsg({ sourcePath: join(dir, "never.jpg"), thumbPath: "" }, "e1"),
            ),
            downloadRichMedia: vi.fn(async () => undefined),
        });
        await expect(api.downloadImage("m1", target, { timeoutMs: 1 })).rejects.toMatchObject({
            code: "TIMEOUT",
        });
    });

    it("文件始终不出现 → TIMEOUT", async () => {
        vi.useFakeTimers();
        try {
            const { api } = makeApi({
                getMsgsByMsgId: vi.fn(async () =>
                    picMsg({ sourcePath: join(dir, "never.jpg") }, "e1"),
                ),
                downloadRichMedia: vi.fn(async () => undefined),
            });
            const promise = api.downloadImage("m1", target, { timeoutMs: 600 });
            const assertion = expect(promise).rejects.toMatchObject({
                code: "TIMEOUT",
                message: /图片下载未完成/,
            });
            await vi.advanceTimersByTimeAsync(1_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("无图片元素 → NOT_FOUND（不触发下载）", async () => {
        const { api, service } = makeApi({
            getMsgsByMsgId: vi.fn(async () => ({
                result: 0,
                msgList: [{ msgId: "m1", elements: [] }],
            })),
        });
        await expect(api.downloadImage("m1", target)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(service.downloadRichMedia).not.toHaveBeenCalled();
    });
});
