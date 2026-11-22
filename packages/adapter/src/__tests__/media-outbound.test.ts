import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stub } from "../internal/__tests__/stub.js";
import { buildMilkyApi } from "../milky/action/__tests__/test-support.js";
import { NapukettoMilkyAdapter } from "../milky/adapter.js";
import { NapukettoOneBot11Adapter } from "../onebot11/adapter.js";
import { fakeMsgChannel } from "../satori/__tests__/test-support.js";
import { stubSatoriApi } from "../satori/action/__tests__/test-support.js";
import { NapukettoSatoriAdapter } from "../satori/adapter.js";

const onDownload = vi.fn();
const mediaServer = createServer((_req, res) => {
    onDownload();
    res.end("media");
});
let cacheDir = "";
let mediaUrl = "";

beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "nk-protocol-outbound-"));
    await once(mediaServer.listen(0, "127.0.0.1"), "listening");
    const address = mediaServer.address();
    if (address === null || typeof address === "string") throw new Error("Missing TCP port");
    mediaUrl = `http://127.0.0.1:${address.port}/media.png`;
});

afterAll(async () => {
    mediaServer.close();
    await once(mediaServer, "close");
    await rm(cacheDir, { recursive: true, force: true });
});

const configs = [{}, { media: { outboundPolicy: "compat" as const } }];

it("OB11 download_file 在注册表读取账号配置", async () => {
    for (const [index, config] of configs.entries()) {
        onDownload.mockClear();
        const adapter = new NapukettoOneBot11Adapter(
            stub<ConstructorParameters<typeof NapukettoOneBot11Adapter>[0]>({
                config,
                msgChannel: fakeMsgChannel().channel,
                self: { uin: "10001", nickname: "测试" },
                system: { cacheDir },
            }),
        );
        const results: unknown[] = [];
        await adapter.handleRequest(
            { action: "download_file", params: { url: mediaUrl } },
            (result) => results.push(result),
        );
        expect(results[0]).toMatchObject(
            index === 0
                ? { status: "failed", message: expect.stringContaining("公网下载策略拒绝") }
                : { status: "ok", data: { file: expect.any(String) } },
        );
        expect(onDownload).toHaveBeenCalledTimes(index);
    }
});

describe("Milky 注册表的 URI 动作", () => {
    const groupId = 10001;
    const userId = 10002;
    const makeMessage = (uri: string) => [{ type: "image", data: { uri } }];

    it.each([
        ["send_group_message", (uri: string) => ({ group_id: groupId, message: makeMessage(uri) })],
        ["send_private_message", (uri: string) => ({ user_id: userId, message: makeMessage(uri) })],
        ["set_avatar", (uri: string) => ({ uri })],
        ["set_group_avatar", (uri: string) => ({ group_id: groupId, image_uri: uri })],
        [
            "send_group_announcement",
            (uri: string) => ({ group_id: groupId, content: "test", image_uri: uri }),
        ],
        [
            "upload_group_file",
            (uri: string) => ({ group_id: groupId, file_name: "test", file_uri: uri }),
        ],
        [
            "upload_private_file",
            (uri: string) => ({ user_id: userId, file_name: "test", file_uri: uri }),
        ],
    ] as const)("%s 遵循公网缺省与 LAN 显式配置", async (name, payload) => {
        const services = buildMilkyApi({
            mediaDir: cacheDir,
            profileApi: { setHeader: vi.fn() },
            groupApi: { setGroupAvatar: vi.fn(), publishGroupAnnouncement: vi.fn() },
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "sent" })),
                fetchMsgsByMsgId: vi.fn(async () => [
                    { msgSeq: "1", msgTime: "1760000000", msgId: "sent", peerUid: "10001" },
                ]),
            },
        });
        for (const [index, config] of configs.entries()) {
            onDownload.mockClear();
            const adapter = new NapukettoMilkyAdapter({
                ...services,
                config,
                msgChannel: fakeMsgChannel().channel,
            });
            const action = adapter.registry.get(name);
            expect(action).toBeDefined();
            const result = await action?.handle(payload(mediaUrl));
            expect(result).toMatchObject(
                index === 0
                    ? { status: "failed", message: expect.stringContaining("公网下载策略拒绝") }
                    : { status: "ok" },
            );
            expect(onDownload).toHaveBeenCalledTimes(index);
        }
    });
});

it("Satori message.create 的 HTTP RPC 遵循媒体配置", async () => {
    const port = 36253;
    const api = stubSatoriApi();
    for (const [index, config] of configs.entries()) {
        onDownload.mockClear();
        const adapter = new NapukettoSatoriAdapter({
            msgApi: api.msgApi,
            groupApi: api.groupApi,
            groupNotifyApi: api.groupNotifyApi,
            friendApi: api.friendApi,
            profileApi: api.profileApi,
            self: api.self,
            cacheDir,
            msgChannel: fakeMsgChannel().channel,
            config: {
                ...config,
                httpServers: [{ enabled: true, host: "127.0.0.1", port }],
            },
        });
        await adapter.start();
        try {
            const response = await fetch(`http://127.0.0.1:${port}/v1/message.create`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ channel_id: "10001", content: `<img src="${mediaUrl}"/>` }),
            });
            if (index === 0) {
                expect(response.status).toBe(500);
                expect(await response.text()).toContain("公网下载策略拒绝");
                expect(api.msgApi.sendMessage).not.toHaveBeenCalled();
            } else {
                expect(response.status).toBe(200);
                expect(await response.json()).toMatchObject([{ id: "sent-msg-1" }]);
                expect(api.msgApi.sendMessage).toHaveBeenCalledOnce();
            }
            expect(onDownload).toHaveBeenCalledTimes(index);
        } finally {
            await adapter.stop();
        }
    }
});
