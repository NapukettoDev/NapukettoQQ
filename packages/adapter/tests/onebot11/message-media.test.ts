import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GroupApi, MsgApi, Peer } from "@napuketto/kernel";
import { ChatType, ConfigBase, kernelError, NTEventChannel } from "@napuketto/kernel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    cleanupTempDir,
    listenHttp,
    makePcm,
    makeTempDir,
    makeWav,
} from "../../../media/tests/test-support.js";
import { MEDIA_TEMP_ROOT } from "../../src/internal/infra/media-cache.js";
import { createOb11ActionRegistry } from "../../src/onebot11/action/index.js";
import { MAX_FORWARD_NODES } from "../../src/onebot11/action/limits.js";
import {
    NapukettoOneBot11Adapter,
    type OneBot11AdapterOptions,
} from "../../src/onebot11/adapter.js";
import { OneBotApi, type OneBotApiOptions } from "../../src/onebot11/api/onebot-api.js";
import {
    type Ob11MessageMediaBudgetConfig,
    ob11ConfigSchema,
} from "../../src/onebot11/helper/config.js";
import type { Ob11MessageMediaStats } from "../../src/onebot11/types/media.js";
import { stub } from "../internal/stub.js";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2uZkAAAAASUVORK5CYII=",
    "base64",
);
const hasFfmpeg = ["ffmpeg", "ffprobe"].every(
    (command) =>
        spawnSync(command, ["-version"], { stdio: "ignore", windowsHide: true }).status === 0,
);
const ffmpeg = promisify(execFile);

let dir: string;
let image: string;
let cacheRoot: string | undefined;

beforeEach(async () => {
    dir = makeTempDir("napuketto-ob11-media-test-");
    image = join(dir, "image.png");
    await writeFile(image, PNG);
    cacheRoot = undefined;
});

afterEach(() => {
    cleanupTempDir(dir);
    if (cacheRoot !== undefined) cleanupTempDir(cacheRoot);
});

function apiOptions(msgApi: MsgApi, stats: Ob11MessageMediaStats[]): OneBotApiOptions {
    return stub<OneBotApiOptions>({
        msgApi,
        groupApi: stub<GroupApi>({ uinToUid: async () => new Map([["123", "u_fixture"]]) }),
        self: { uin: randomUUID(), nickname: "fixture" },
        onMessageMediaPrepared: (snapshot) => {
            stats.push(snapshot);
        },
    });
}

async function fixture(budget: Ob11MessageMediaBudgetConfig, outbound?: "compat") {
    const stats: Ob11MessageMediaStats[] = [];
    const send = vi.fn<MsgApi["sendMessage"]>().mockResolvedValue({ msgId: "sent" });
    const forward = vi.fn<MsgApi["sendForwardMessage"]>().mockResolvedValue({ msgId: "forwarded" });
    const opts = apiOptions(
        stub<MsgApi>({ sendMessage: send, sendForwardMessage: forward }),
        stats,
    );
    const api = new OneBotApi(
        opts,
        () => outbound,
        () => [dir],
        () => budget,
    );
    const reference = await api.mediaCache.create(
        MEDIA_TEMP_ROOT,
        ".png",
        (path) => writeFile(path, PNG),
        "reference",
    );
    cacheRoot = dirname(dirname(reference));
    const registry = createOb11ActionRegistry({ api });
    function action(name: string) {
        const entry = registry.get(name);
        if (entry === undefined) throw new Error(`缺少 OB11 动作 ${name}`);
        return entry;
    }
    return { api, action, send, forward, stats, reference, root: cacheRoot };
}

function picture(file: string) {
    return { type: "image", data: { file } };
}

async function expectOnlyReference(root: string, reference: string): Promise<void> {
    expect(await readdir(root)).toEqual([basename(dirname(reference))]);
    expect((await readdir(dirname(reference))).sort()).toEqual([".owner.json", "media.png"]);
    expect(await readFile(reference)).toEqual(PNG);
}

it.each([
    { message: "[CQ:image,file=missing.png][CQ:record,file=missing.wav]" },
    { message: [picture("missing.png"), picture("missing2.png")] },
    { message: [{ type: "video", data: { file: "missing.mp4", thumb: "missing.png" } }] },
    { message: "[CQ:video,file=missing.mp4,thumb=missing.png]" },
])("发送前统计所有显式媒体项 %j", async ({ message }) => {
    const { action, send, root, reference } = await fixture({ maxItems: 1 });
    const result = await action("send_group_msg").handle({ group_id: 1, message });
    expect(result).toEqual({
        status: "failed",
        retcode: 105,
        data: null,
        message: "消息媒体项数超过 1",
    });
    expect(send).not.toHaveBeenCalled();
    await expectOnlyReference(root, reference);
});

it("累计本地字节超限时移除已写的副本并释放前一项租约", async () => {
    const { action, send, root, reference } = await fixture({ maxBytes: PNG.length * 3 - 1 });
    const result = await action("send_msg").websocketHandle(
        { group_id: 1, message: [picture(image), picture(reference), picture(reference)] },
        "budget",
    );
    expect(result).toEqual({
        status: "failed",
        retcode: 105,
        data: null,
        message: "本地媒体超过消息剩余字节预算",
        echo: "budget",
    });
    expect(send).not.toHaveBeenCalled();
    await expectOnlyReference(root, reference);
});

it.each(["send_msg", "send_group_msg", "send_private_msg"])(
    "%s 保留信封并报告累计用量",
    async (name) => {
        const { action, send, stats, root, reference } = await fixture({}, "compat");
        const wav = join(dir, "voice.wav");
        const voice = makeWav({ rate: 24000, channels: 1 }, makePcm(0.2, 24000));
        await writeFile(wav, voice);
        const server = await listenHttp((_req, res) => {
            res.end(PNG);
        });
        try {
            const message = [
                picture(image),
                picture(`${server.url}/img.png`),
                picture(reference),
                picture(reference),
                {
                    type: "record",
                    data: { file: wav },
                },
            ];
            const target = name === "send_private_msg" ? { user_id: 123 } : { group_id: 1 };
            let silkBytes = 0;
            send.mockImplementationOnce(async (_peer, elements) => {
                const silk = elements.find((el) => el.type === "voice");
                if (silk === undefined) throw new Error("缺少语音产物");
                silkBytes = (await stat(silk.path)).size;
                expect(silk.path).toMatch(/\.silk$/);
                expect(
                    (await readdir(dirname(reference))).filter((name) =>
                        name.startsWith(".lease-"),
                    ),
                ).toHaveLength(1);
                const downloaded = elements[1];
                if (downloaded?.type !== "image") throw new Error("缺少下载的图片");
                expect(await readFile(downloaded.path)).toEqual(PNG);
                return { msgId: "sent" };
            });
            expect(await action(name).handle({ ...target, message })).toEqual({
                status: "ok",
                retcode: 0,
                data: { message_id: 1 },
                message: "",
            });
            expect(stats).toEqual([
                {
                    items: 5,
                    copiedBytes: PNG.length + voice.length,
                    downloadedBytes: PNG.length,
                    reusedReferenceBytes: PNG.length * 2,
                    transcodedBytes: silkBytes,
                    tempFilesCreated: 4,
                    totalBytes: PNG.length * 4 + voice.length + silkBytes,
                    peakBytes: PNG.length * 2 + voice.length + silkBytes,
                },
            ]);
            await expectOnlyReference(root, reference);
            send.mockRejectedValueOnce(kernelError("发送失败", "SEND_FAILED"));
            expect(await action(name).handle({ ...target, message })).toEqual({
                status: "failed",
                retcode: 100,
                data: null,
                message: "发送失败",
            });
            expect(stats).toHaveLength(2);
            await expectOnlyReference(root, reference);
        } finally {
            await server.close();
        }
    },
);

it("流式下载超限时删除部分写入文件与前一项快照", async () => {
    const { action, send, root, reference } = await fixture({ maxBytes: PNG.length + 4 }, "compat");
    const server = await listenHttp((_req, res) => {
        res.write(PNG.subarray(0, 4));
        res.end(PNG.subarray(4));
    });
    try {
        expect(
            await action("send_group_msg").handle({
                group_id: 1,
                message: [picture(image), picture(`${server.url}/img.png`)],
            }),
        ).toMatchObject({ status: "failed", retcode: 105, data: null });
        expect(send).not.toHaveBeenCalled();
        await expectOnlyReference(root, reference);
    } finally {
        await server.close();
    }
});

it("默认出站策略在联系本地 HTTP 源前拒绝请求", async () => {
    const { action, send, root, reference } = await fixture({});
    const hit = vi.fn();
    const server = await listenHttp((_req, res) => {
        hit();
        res.end(PNG);
    });
    try {
        expect(
            await action("send_group_msg").handle({
                group_id: 1,
                message: [picture(`${server.url}/img.png`)],
            }),
        ).toMatchObject({ status: "failed", retcode: 100, data: null });
        expect(hit).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        await expectOnlyReference(root, reference);
    } finally {
        await server.close();
    }
});

it("合并转发只消费已登记节点，保留独立节点边界", async () => {
    const { action, api, forward, root, reference } = await fixture({ maxItems: 1, maxBytes: 1 });
    const peer: Peer = { chatType: ChatType.GROUP, peerUid: "2" };
    const node = { type: "node", data: { id: api.messageUnique.alloc("source", peer) } };
    const entry = action("send_group_forward_msg");
    expect(await entry.handle({ group_id: 3, messages: [node, node] })).toMatchObject({
        status: "ok",
        data: { message_id: 2 },
    });
    expect(forward).toHaveBeenCalledWith({ chatType: ChatType.GROUP, peerUid: "3" }, peer, [
        "source",
        "source",
    ]);
    expect(
        await entry.handle({
            group_id: 3,
            messages: Array.from({ length: MAX_FORWARD_NODES + 1 }, () => node),
        }),
    ).toMatchObject({ status: "failed", retcode: 400 });
    const nested = {
        type: "node",
        data: {
            ...node.data,
            content: [{ type: "node", data: { content: [picture("x"), picture("y")] } }],
        },
    };
    expect(await entry.handle({ group_id: 3, messages: [node, nested] })).toMatchObject({
        status: "failed",
        retcode: 105,
    });
    expect(forward).toHaveBeenCalledOnce();
    await expectOnlyReference(root, reference);
});

it.skipIf(!hasFfmpeg)("真实 PCM 超限中止语音发送并清理快照", async () => {
    const wav = join(dir, "stereo.wav");
    const voice = makeWav({ rate: 24000, channels: 2 }, makePcm(0.2, 24000));
    await writeFile(wav, voice);
    const retained = voice.length + PNG.length;
    const budget = { maxBytes: retained + 4 };
    const { action, send, stats, root, reference } = await fixture(budget);
    const message = [picture(image), { type: "record", data: { file: wav } }];
    const entry = action("send_group_msg");
    expect(await entry.handle({ group_id: 1, message })).toMatchObject({
        status: "failed",
        retcode: 105,
        message: expect.stringContaining("4 字节"),
    });
    expect(send).not.toHaveBeenCalled();
    await expectOnlyReference(root, reference);
    let silkBytes = 0;
    send.mockImplementationOnce(async (_peer, elements) => {
        const silk = elements.find((el) => el.type === "voice");
        if (silk === undefined) throw new Error("缺少语音产物");
        silkBytes = (await stat(silk.path)).size;
        return { msgId: "sent" };
    });
    const pcmBytes = (voice.length - 44) / 2;
    budget.maxBytes = retained + pcmBytes + 4096;
    expect(await entry.handle({ group_id: 1, message })).toMatchObject({ status: "ok" });
    expect(stats).toEqual([
        expect.objectContaining({
            totalBytes: retained + pcmBytes + silkBytes,
            peakBytes: retained + Math.max(pcmBytes, silkBytes),
            transcodedBytes: pcmBytes + silkBytes,
            tempFilesCreated: 4,
        }),
    ]);
    await expectOnlyReference(root, reference);
});

it.skipIf(!hasFfmpeg)("限制真实视频首帧写盘，后续媒体失败也清理已生成的缩略图", async () => {
    const video = join(dir, "tiny.mp4");
    await ffmpeg(
        "ffmpeg",
        ["-v", "error", "-f", "lavfi", "-i", "color=s=32x32:r=10:d=0.2", "-c:v", "mpeg4", video],
        { windowsHide: true },
    );
    const videoBytes = (await stat(video)).size;
    const budget = { maxBytes: videoBytes + 4 };
    const { action, send, stats, root, reference } = await fixture(budget);
    const clip = { type: "video", data: { file: video } };
    const entry = action("send_group_msg");
    expect(await entry.handle({ group_id: 1, message: [clip] })).toMatchObject({
        status: "failed",
        retcode: 105,
        message: expect.stringContaining("4 字节"),
    });
    await expectOnlyReference(root, reference);
    budget.maxBytes = videoBytes + 4096;
    expect(await entry.handle({ group_id: 1, message: [clip] })).toMatchObject({ status: "ok" });
    const [snapshot] = stats;
    expect(snapshot).toMatchObject({ items: 1, copiedBytes: videoBytes, tempFilesCreated: 2 });
    expect(snapshot?.transcodedBytes).toBeGreaterThan(4);
    if (snapshot === undefined) throw new Error("缺少统计");
    const wav = join(dir, "voice.wav");
    const voice = makeWav({ rate: 24000, channels: 1 }, makePcm(0.2, 24000));
    await writeFile(wav, voice);
    const record = { type: "record", data: { file: wav } };
    budget.maxBytes = snapshot.totalBytes + voice.length + 4096;
    expect(await entry.handle({ group_id: 1, message: [clip, record] })).toMatchObject({
        status: "ok",
    });
    const mixed = stats[1];
    if (mixed === undefined) throw new Error("缺少混合消息统计");
    expect(mixed.transcodedBytes).toBeGreaterThan(snapshot.transcodedBytes);
    budget.maxBytes = mixed.totalBytes + PNG.length - 1;
    expect(
        await entry.handle({ group_id: 1, message: [clip, record, picture(image)] }),
    ).toMatchObject({
        status: "failed",
        retcode: 105,
        message: "本地媒体超过消息剩余字节预算",
    });
    expect(send).toHaveBeenCalledTimes(2);
    budget.maxBytes = videoBytes + PNG.length;
    const explicit = { type: "video", data: { file: video, thumb: image } };
    expect(await entry.handle({ group_id: 1, message: [explicit] })).toMatchObject({
        status: "ok",
    });
    expect(stats[2]).toMatchObject({
        items: 2,
        copiedBytes: videoBytes + PNG.length,
        tempFilesCreated: 2,
        transcodedBytes: 0,
    });
    await expectOnlyReference(root, reference);
});

it("适配器每次发送读取当前 ConfigBase 预算", async () => {
    const path = join(dir, "onebot11.toml");
    async function update(maxItems: number) {
        await writeFile(path, `[media.messageBudget]\nmaxItems = ${maxItems}\n`);
        await config.load();
    }
    const defaults = ob11ConfigSchema.parse({});
    const config = new ConfigBase({ path, schema: ob11ConfigSchema, defaults });
    const send = vi.fn<MsgApi["sendMessage"]>().mockResolvedValue({ msgId: "sent" });
    const adapter = new NapukettoOneBot11Adapter(
        stub<OneBot11AdapterOptions>({
            ...apiOptions(stub<MsgApi>({ sendMessage: send }), []),
            config,
            msgChannel: new NTEventChannel("Msg"),
        }),
    );
    const action = adapter.registry.get("send_group_msg");
    const input = { group_id: 1, message: [picture("missing1"), picture("missing2")] };
    await update(1);
    expect(await action?.handle(input)).toMatchObject({
        retcode: 105,
        message: "消息媒体项数超过 1",
    });
    await update(2);
    expect(await action?.handle(input)).toMatchObject({
        retcode: 105,
        message: "本地媒体路径未授权或文件不可用",
    });
    expect(send).not.toHaveBeenCalled();
});
