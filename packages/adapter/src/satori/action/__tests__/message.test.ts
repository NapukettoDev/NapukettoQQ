/**
 * satori/action/message.test.ts：message.create / get / list / delete 单测。
 *
 * 锁定参数映射与返回值映射：
 *  - message.create → resolvePeer → setChannelType 回填 → parseContentToCanonical
 *    → sendMessage → 返回 [Message]（content 回显原始输入）
 *  - message.get → fetchMsgsByMsgId 单查；无消息抛错（500）
 *  - message.list → around 抛错；asc/desc 排序；next 分页令牌（raw ≥ count）
 *  - message.delete → recallMessage
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../internal/__tests__/stub.js";
import { makeRawMsg } from "../../__tests__/test-support.js";
import { SatoriApi } from "../../api/satori-api.js";
import type { BidiList, Message } from "../../types/index.js";
import { SatoriActionError } from "../base-action.js";
import { createSatoriActionRegistry } from "../index.js";
import type { MessageActionDeps } from "../message.js";
import { createMessageActions } from "../message.js";

import { type StubSatoriApi, satoriActionOf, stubSatoriApi } from "./test-support.js";

const { transcodeMock, downloadMock } = vi.hoisted(() => ({
    transcodeMock: vi.fn(),
    downloadMock: vi.fn(),
}));
vi.mock("@napuketto/media", async (original) => ({
    ...(await original<typeof import("@napuketto/media")>()),
    transcodeVideo: transcodeMock,
    downloadPublicUrl: downloadMock,
}));

/** 最小 PNG 头（签名 + IHDR），供 image-size / file-type 探测。 */
function pngHeader(width: number, height: number): Buffer {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "ascii");
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[24] = 8;
    buf[25] = 6;
    return buf;
}

/** 从桩 api 构造 MessageActionDeps。 */
function makeDeps(api: StubSatoriApi): MessageActionDeps {
    return stub<MessageActionDeps>({
        msgApi: api.msgApi,
        selfUin: api.selfUin,
        uidToUin: api.uidToUin,
        resolvePeer: api.resolvePeer,
        setChannelType: api.setChannelType,
        toCanonicalDeps: api.toCanonicalDeps,
    });
}

/** 构造指定消息动作（工厂产物按名取出）。 */
function actionOf<R>(api: StubSatoriApi, name: string) {
    return satoriActionOf<R>(createMessageActions(makeDeps(api)), name);
}

describe("message.create", () => {
    it("img：发送前补 size/mime（kernel PIC 契约）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "nk-satori-image-meta-"));
        const api = stubSatoriApi();
        api.toCanonicalDeps.mockReturnValue({ cacheDir: dir, uinToUid: api.uinToUid });
        downloadMock.mockImplementation(async (_url: string, dest: string) => {
            writeFileSync(dest, pngHeader(320, 240));
            return 33;
        });
        vi.mocked(api.msgApi.sendMessage).mockImplementationOnce(async (_peer, elements) => {
            expect(elements[0]).toMatchObject({
                type: "image",
                size: { width: 320, height: 240 },
                mime: "image/png",
            });
            return { msgId: "sent-msg-1" };
        });
        try {
            await actionOf<Message[]>(api, "message.create").run({
                channel_id: "10001",
                content: '<img src="https://a.example/a.png"/>',
            });
            expect(api.msgApi.sendMessage).toHaveBeenCalledOnce();
        } finally {
            rmSync(dir, { recursive: true, force: true });
            downloadMock.mockReset();
        }
    });

    it.each(["", ' title="custom.pdf"'])(
        "H-04: remote file keeps its logical title %s",
        async (title) => {
            const dir = mkdtempSync(join(tmpdir(), "nk-satori-cache-title-"));
            const api = stubSatoriApi();
            api.toCanonicalDeps.mockReturnValue({ cacheDir: dir, uinToUid: api.uinToUid });
            downloadMock.mockImplementation(async (_url: string, dest: string) => {
                writeFileSync(dest, "document");
                return 8;
            });
            vi.mocked(api.msgApi.sendMessage).mockImplementationOnce(async (_peer, elements) => {
                expect(elements[0]).toMatchObject({
                    type: "file",
                    name: title ? "custom.pdf" : "report.pdf",
                });
                return { msgId: "sent-msg-1" };
            });
            try {
                await actionOf<Message[]>(api, "message.create").run({
                    channel_id: "10001",
                    content: `<file src="https://example.com/report.pdf"${title}/>`,
                });
                expect(api.msgApi.sendMessage).toHaveBeenCalledOnce();
            } finally {
                rmSync(dir, { recursive: true, force: true });
                downloadMock.mockReset();
            }
        },
    );

    it.each(["success", "send-failure", "download-failure"])(
        "H-04: %s leases and cleans remote assets",
        async (scenario) => {
            const dir = mkdtempSync(join(tmpdir(), "nk-satori-cache-send-"));
            const outputs: string[] = [];
            const api = stubSatoriApi();
            api.toCanonicalDeps.mockReturnValue({ cacheDir: dir, uinToUid: api.uinToUid });
            downloadMock.mockImplementation(async (url: string, dest: string) => {
                writeFileSync(dest, url);
                outputs.push(dest);
                if (scenario === "download-failure" && outputs.length === 2)
                    throw new Error("download failed");
                return url.length;
            });
            vi.mocked(api.msgApi.sendMessage).mockImplementationOnce(async (_peer, elements) => {
                expect(elements).toHaveLength(2);
                expect(outputs[0]).not.toBe(outputs[1]);
                expect(outputs.every((path) => existsSync(path))).toBe(true);
                expect(readFileSync(outputs[0] ?? "", "utf8")).toBe("https://a.example/a.png");
                if (scenario === "send-failure") throw new Error("send failed");
                return { msgId: "sent-msg-1" };
            });
            try {
                const request = actionOf<Message[]>(api, "message.create").run({
                    channel_id: "10001",
                    content:
                        '<img src="https://a.example/a.png"/><img src="https://b.example/a.png"/>',
                });
                if (scenario === "success") await expect(request).resolves.toHaveLength(1);
                else await expect(request).rejects.toThrow();
                expect(outputs).toHaveLength(2);
                expect(outputs.every((path) => !existsSync(dirname(path)))).toBe(true);
                if (scenario === "download-failure")
                    expect(api.msgApi.sendMessage).not.toHaveBeenCalled();
            } finally {
                rmSync(dir, { recursive: true, force: true });
                downloadMock.mockReset();
            }
        },
    );

    it.each(["success", "send-failure", "conversion-failure"])(
        "H-02: %s 在发送消费结束后清理转码产物，保留源文件",
        async (scenario) => {
            const dir = mkdtempSync(join(tmpdir(), "nk-satori-owned-"));
            const source = join(dir, "source.webm");
            const ownedDir = mkdtempSync(join(dir, ".napuketto-video-"));
            const output = join(ownedDir, "output.mp4");
            writeFileSync(source, "original");
            writeFileSync(output, "converted");
            transcodeMock.mockResolvedValueOnce(output);
            const api = stubSatoriApi();
            api.toCanonicalDeps.mockReturnValue({
                cacheDir: dir,
                uinToUid: api.uinToUid,
                localMediaRoots: [dir],
            });
            vi.mocked(api.msgApi.sendMessage).mockImplementationOnce(async (_peer, elements) => {
                expect(elements).toEqual([{ type: "video", path: output }]);
                expect(readFileSync(output, "utf8")).toBe("converted");
                if (scenario === "send-failure") throw new Error("send failed");
                return { msgId: "sent-msg-1" };
            });
            const content = `<video src="${source}"/>${scenario === "conversion-failure" ? '<img src="http://example.test/fail.png"/>' : ""}`;
            downloadMock.mockRejectedValueOnce(new Error("download failed"));
            try {
                const request = actionOf<Message[]>(api, "message.create").run({
                    channel_id: "10001",
                    content,
                });
                if (scenario === "success") await expect(request).resolves.toHaveLength(1);
                else await expect(request).rejects.toThrow();
                expect(existsSync(ownedDir)).toBe(false);
                expect(readFileSync(source, "utf8")).toBe("original");
                if (scenario === "conversion-failure")
                    expect(api.msgApi.sendMessage).not.toHaveBeenCalled();
            } finally {
                rmSync(dir, { recursive: true, force: true });
                transcodeMock.mockReset();
                downloadMock.mockReset();
            }
        },
    );

    it("群聊频道：resolvePeer → setChannelType(true) → sendMessage → 返回单元素数组", async () => {
        const api = stubSatoriApi();
        api.resolvePeer.mockResolvedValueOnce({
            chatType: ChatType.GROUP,
            peerUid: "10001",
        } as never);
        const action = actionOf<Message[]>(api, "message.create");
        await expect(
            action.run({ channel_id: "10001", content: '<at id="9"/>你好' }),
        ).resolves.toEqual([
            {
                id: "sent-msg-1",
                channel: { id: "10001", type: 0 },
                content: '<at id="9"/>你好',
            },
        ]);
        expect(api.setChannelType).toHaveBeenCalledWith("10001", true);
        const [peer, elements] = vi.mocked(api.msgApi.sendMessage).mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "10001" });
        // at 已转 canonical（uid 化）
        expect(elements).toEqual([
            { type: "at", target: "uid_9" },
            { type: "text", text: "你好" },
        ]);
    });

    it("私聊频道：channel type=1，setChannelType(false)", async () => {
        const api = stubSatoriApi();
        api.resolvePeer.mockResolvedValueOnce({
            chatType: ChatType.C2C,
            peerUid: "uid_90001",
        } as never);
        const action = actionOf<Message[]>(api, "message.create");
        const messages = await action.run({ channel_id: "90001", content: "hi" });
        expect(messages[0]?.channel).toEqual({ id: "90001", type: 1 });
        expect(api.setChannelType).toHaveBeenCalledWith("90001", false);
    });

    it("referrer 透传但不参与发送（schema 接受）", async () => {
        const api = stubSatoriApi();
        const action = actionOf<Message[]>(api, "message.create");
        await expect(
            action.run({ channel_id: "10001", content: "x", referrer: { a: 1 } }),
        ).resolves.toHaveLength(1);
    });

    it("缺 content → SatoriActionError(400)", async () => {
        const action = actionOf<Message[]>(stubSatoriApi(), "message.create");
        await expect(action.run({ channel_id: "10001" })).rejects.toMatchObject({
            status: 400,
            message: "参数校验失败",
        });
    });
});

describe("message.get", () => {
    it("发布当前账号 QQ 媒体引用并在 message.create 中复用", async () => {
        const dir = mkdtempSync(join(tmpdir(), "nk-satori-qq-"));
        const source = join(dir, "avatar.png");
        writeFileSync(source, "qq image");
        try {
            const fixture = stubSatoriApi();
            const msg = makeRawMsg({
                elements: [{ elementType: 2, picElement: { sourcePath: source } }] as never,
            });
            vi.mocked(fixture.msgApi.fetchMsgsByMsgId).mockResolvedValue([msg]);
            const api = new SatoriApi({
                ...fixture,
                groupCache: undefined,
                cacheDir: dir,
                mediaBaseDir: dir,
            });
            const registry = createSatoriActionRegistry({ api });
            const result = (await registry
                .get("message.get")
                ?.run({ channel_id: "10001", message_id: "msg-1" })) as Message | undefined;
            expect(result?.content).toContain("internal:qq/10001/_tmp/");
            vi.mocked(fixture.msgApi.sendMessage).mockImplementationOnce(
                async (_peer, elements) => {
                    const [image] = elements;
                    if (image?.type !== "image") throw new Error("missing image");
                    expect(image.path).not.toBe(source);
                    expect(readFileSync(image.path, "utf8")).toBe("qq image");
                    return { msgId: "sent" };
                },
            );
            const response = await registry.get("message.create")?.run({
                channel_id: "10001",
                content: result?.content,
            });
            expect(response).toMatchObject([{ id: "sent" }]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fetchMsgsByMsgId → toSatoriMessage 翻译（guild/channel/user 提升）", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.msgApi.fetchMsgsByMsgId).mockResolvedValueOnce([makeRawMsg()] as never);
        const action = actionOf<Message>(api, "message.get");
        const message = await action.run({ channel_id: "10001", message_id: "m1" });
        expect(message.id).toBe("m1");
        expect(message.guild).toEqual({ id: "10001", name: "测试群" });
        expect(message.channel).toEqual({ id: "10001", type: 0, name: "测试群" });
        expect(api.setChannelType).toHaveBeenCalledWith("10001", true);
        expect(api.msgApi.fetchMsgsByMsgId).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            ["m1"],
        );
    });

    it("消息不存在（空列表）：抛「消息不存在」（404）", async () => {
        const api = stubSatoriApi();
        const action = actionOf<Message>(api, "message.get");
        await expect(action.run({ channel_id: "10001", message_id: "gone" })).rejects.toMatchObject(
            { status: 404, message: "消息不存在" },
        );
    });
});

describe("message.list", () => {
    it.each([
        { order: "asc", inclusive: true },
        { order: "desc", inclusive: true },
        { order: "asc", inclusive: false },
        { order: "desc", inclusive: false },
    ] as const)(
        "按 $order 翻三页（含锚点=$inclusive），游标始终向较早消息推进",
        async ({ order, inclusive }) => {
            const api = stubSatoriApi();
            const ids = ["m6", "m6", "m5", "m4", "m3", "m2", "m1"];
            const records = ids.map((msgId) => makeRawMsg({ msgId }));
            vi.mocked(api.msgApi.fetchMessages).mockImplementation(
                async (_peer, { msgId, count }) => {
                    const anchor = ids.indexOf(msgId ?? "");
                    const start = anchor === -1 ? 0 : anchor + (inclusive ? 0 : 1);
                    return records.slice(start, start + Math.min(count, 3));
                },
            );
            const action = actionOf<BidiList<Message>>(api, "message.list");
            const options = {
                channel_id: "10001",
                ...(order === "desc" ? { order } : {}),
                limit: 2,
            };
            const first = await action.run({ ...options, next: null });
            const second = await action.run({ ...options, next: first.next });
            const last = await action.run({ ...options, next: second.next });
            expect(first).toMatchObject({ prev: "m5", next: "m5" });
            expect(second).toMatchObject({ prev: "m3", next: "m3" });
            expect(last).not.toHaveProperty("prev");
            expect(last).not.toHaveProperty("next");
            expect([first, second, last].map(({ data }) => data.map(({ id }) => id))).toEqual(
                order === "asc"
                    ? [
                          ["m5", "m6"],
                          ["m3", "m4"],
                          ["m1", "m2"],
                      ]
                    : [
                          ["m6", "m5"],
                          ["m4", "m3"],
                          ["m2", "m1"],
                      ],
            );
        },
    );

    it("next 透传为游标 msgId；limit 透传", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.msgApi.fetchMessages).mockResolvedValueOnce([
            makeRawMsg({ msgId: "a" }),
        ] as never);
        const action = actionOf<BidiList<Message>>(api, "message.list");
        await action.run({ channel_id: "10001", next: "cursor-1", limit: 10 });
        expect(api.msgApi.fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { count: 12, msgId: "cursor-1" },
        );
    });

    it("raw 数量 < count：不写 next（已是最后一页）", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.msgApi.fetchMessages).mockResolvedValueOnce([
            makeRawMsg({ msgId: "only" }),
        ] as never);
        const action = actionOf<BidiList<Message>>(api, "message.list");
        const result = await action.run({ channel_id: "10001", limit: 50 });
        expect(result.next).toBeUndefined();
    });

    it("direction=around：抛「暂不支持 around 方向」（400）", async () => {
        const api = stubSatoriApi();
        const action = actionOf<BidiList<Message>>(api, "message.list");
        await expect(
            action.run({ channel_id: "10001", direction: "around" }),
        ).rejects.toMatchObject({ status: 400, message: "暂不支持 around 方向" });
    });

    it("direction=after 不会静默查询较早消息", async () => {
        const api = stubSatoriApi();
        const action = actionOf<BidiList<Message>>(api, "message.list");
        await expect(
            action.run({ channel_id: "10001", next: "m1", direction: "after" }),
        ).rejects.toMatchObject({ status: 400 });
        expect(api.msgApi.fetchMessages).not.toHaveBeenCalled();
    });

    it("原生只重复锚点时返回空页并停止", async () => {
        const api = stubSatoriApi();
        const action = actionOf<BidiList<Message>>(api, "message.list");
        const raw = makeRawMsg({ msgId: "anchor" });
        vi.mocked(api.msgApi.fetchMessages).mockResolvedValue([raw, raw]);
        await expect(
            action.run({ channel_id: "10001", next: "anchor", limit: 1 }),
        ).resolves.toEqual({ data: [] });
        expect(api.msgApi.fetchMessages).toHaveBeenCalledTimes(1);
    });

    it("direction=before：合法方向", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.msgApi.fetchMessages).mockResolvedValueOnce([makeRawMsg()] as never);
        const action = actionOf<BidiList<Message>>(api, "message.list");
        await expect(
            action.run({ channel_id: "10001", direction: "before" }),
        ).resolves.toHaveProperty("data");
    });

    it("limit 非整数 → SatoriActionError(400)", async () => {
        const api = stubSatoriApi();
        const action = actionOf<BidiList<Message>>(api, "message.list");
        await expect(action.run({ channel_id: "10001", limit: 1.5 })).rejects.toBeInstanceOf(
            SatoriActionError,
        );
    });
});

describe("message.delete", () => {
    it("resolvePeer → recallMessage(peer, [message_id])", async () => {
        const api = stubSatoriApi();
        const action = actionOf<void>(api, "message.delete");
        await expect(
            action.run({ channel_id: "10001", message_id: "m1" }),
        ).resolves.toBeUndefined();
        expect(api.msgApi.recallMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            ["m1"],
        );
    });

    it("kernel 发送失败（KernelError）→ SatoriActionError 透传状态码", async () => {
        const api = stubSatoriApi();
        const { kernelError } = await import("@napuketto/kernel");
        vi.mocked(api.msgApi.recallMessage).mockRejectedValueOnce(
            kernelError("无权限撤回", "PERMISSION_DENIED"),
        );
        const action = actionOf<void>(api, "message.delete");
        await expect(action.run({ channel_id: "10001", message_id: "m1" })).rejects.toMatchObject({
            status: 403,
            message: "无权限撤回",
        });
    });
});

describe("消息动作错误映射", () => {
    it("非 KernelError 的意外错误 → 500 包装", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.msgApi.sendMessage).mockRejectedValueOnce(new Error("boom"));
        const action = actionOf<Message[]>(api, "message.create");
        await expect(action.run({ channel_id: "10001", content: "x" })).rejects.toMatchObject({
            status: 500,
            message: "boom",
        });
    });

    it("resolvePeer 抛 KernelError NOT_FOUND → 404", async () => {
        const api = stubSatoriApi();
        const { kernelError } = await import("@napuketto/kernel");
        api.resolvePeer.mockRejectedValueOnce(kernelError("频道不存在", "NOT_FOUND"));
        const action = actionOf<Message[]>(api, "message.create");
        await expect(action.run({ channel_id: "404", content: "x" })).rejects.toMatchObject({
            status: 404,
        });
    });
});

describe("消息翻译依赖注入（uidToUin 箭头透传）", () => {
    it("message.get：含 at 的消息触发 uidToUin 转换（at 显示 uin）", async () => {
        const api = stubSatoriApi();
        api.uidToUin.mockResolvedValueOnce(new Map([["sender-uid-1", "90001"]]));
        vi.mocked(api.msgApi.fetchMsgsByMsgId).mockResolvedValueOnce([
            makeRawMsg({
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "", atType: 2, atUid: "sender-uid-1" },
                    },
                ],
            }),
        ] as never);
        const action = actionOf<Message>(api, "message.get");
        const message = await action.run({ channel_id: "10001", message_id: "m1" });
        expect(api.uidToUin).toHaveBeenCalledWith(["sender-uid-1"]);
        // at 元素渲染为 <at id="90001"/>
        expect(message.content).toBe('<at id="90001"/>');
    });

    it("message.list：含 at 的消息同样触发批量转换", async () => {
        const api = stubSatoriApi();
        api.uidToUin.mockResolvedValueOnce(new Map([["sender-uid-1", "90001"]]));
        vi.mocked(api.msgApi.fetchMessages).mockResolvedValueOnce([
            makeRawMsg({
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "", atType: 2, atUid: "sender-uid-1" },
                    },
                ],
            }),
        ] as never);
        const action = actionOf<BidiList<Message>>(api, "message.list");
        const result = await action.run({ channel_id: "10001" });
        expect(api.uidToUin).toHaveBeenCalledWith(["sender-uid-1"]);
        expect(result.data[0]?.content).toBe('<at id="90001"/>');
    });
});
