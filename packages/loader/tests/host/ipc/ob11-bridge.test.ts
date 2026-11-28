import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NTEventChannel } from "@napuketto/kernel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { stub } from "../../../../adapter/tests/internal/stub.js";
import type { IpcActionHandler } from "../../../src/host/ipc/actions.js";
import { attachOb11IpcBridge, type Ob11BridgeDeps } from "../../../src/host/ipc/ob11-bridge.js";
import { env } from "../../../src/host/runtime/env.js";
import { ConfigError } from "../../../src/host/runtime/errors.js";
import { importFileUrl } from "../../../src/host/runtime/module-loader.js";
import type { KernelServices } from "../../../src/host/runtime/service-types.js";
import type { KernelLike, MsgApiLike } from "../../../src/host/runtime/types.js";

const originalConfig = env.NAPUKETTO_CONFIG_JSON;
let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "napuketto-ob11-bridge-test-"));
});
afterEach(async () => {
    env.NAPUKETTO_CONFIG_JSON = originalConfig;
    await rm(dir, { recursive: true, force: true });
});

function bridgeFixture(maxItems: number, maxBytes: number) {
    const uin = randomUUID();
    env.NAPUKETTO_CONFIG_JSON = JSON.stringify({
        accounts: [
            {
                qq: "other",
                onebot11: { media: { messageBudget: { maxItems: 99, maxBytes: 999999 } } },
            },
            {
                qq: uin,
                onebot11: {
                    media: { messageBudget: { maxItems, maxBytes }, localMediaRoots: [dir] },
                },
            },
        ],
    });
    const send = vi.fn<MsgApiLike["sendMessage"]>().mockResolvedValue({ msgId: "sent" });
    const services = stub<KernelServices>({
        kernel: stub<KernelLike>({}),
        ctx: {},
        self: { uin, nickname: "fixture", uid: "u_fixture" },
        channel: new NTEventChannel("Msg"),
        msgApi: stub<MsgApiLike>({ sendMessage: send }),
    });
    const deps: Ob11BridgeDeps = {
        env: {
            adapterEntry: fileURLToPath(
                new URL("../../../../adapter/dist/index.mjs", import.meta.url),
            ),
            networkEntry: fileURLToPath(
                new URL("../../../../network/dist/index.mjs", import.meta.url),
            ),
            cfgDir: dir,
            dataRoot: dir,
        },
    };
    return { services, deps, send, actions: new Map<string, IpcActionHandler>() };
}

it("实际 IPC 动作读取对应账号的项数与字节限制", async () => {
    await writeFile(join(dir, "image.png"), "12345");
    const { actions, send, services, deps } = bridgeFixture(1, 4);
    const stop = await attachOb11IpcBridge(actions, services, deps);
    try {
        const action = actions.get("send_group_msg");
        expect(action).toBeDefined();
        const image = { type: "image", data: { file: "image.png" } };
        expect(await action?.({ group_id: 1, message: [image, image] })).toMatchObject({
            status: "failed",
            retcode: 105,
            data: null,
            message: "消息媒体项数超过 1",
        });
        expect(await action?.({ group_id: 1, message: [image] })).toMatchObject({
            status: "failed",
            retcode: 105,
            data: null,
            message: "本地媒体超过消息剩余字节预算",
        });
        expect(send).not.toHaveBeenCalled();
    } finally {
        stop();
    }
    expect(actions.size).toBe(0);
});

it("旧动态 schema 剥离预算时 IPC 不挂载 OB11 动作", async () => {
    const { actions, services, deps } = bridgeFixture(1, 4);
    const oldSchema = z.object({
        media: z
            .object({
                outboundPolicy: z.enum(["public-only", "compat"]).optional(),
                localMediaRoots: z.array(z.string()).optional(),
            })
            .optional(),
    });
    const stop = await attachOb11IpcBridge(actions, services, {
        ...deps,
        importModule: async (url) => {
            if (url.endsWith("/onebot11/index.mjs")) {
                const adapter = await import("@napuketto/adapter/onebot11");
                return { ...adapter, ob11ConfigSchema: oldSchema };
            }
            return await importFileUrl(url);
        },
    });
    try {
        expect(actions.size).toBe(0);
    } finally {
        stop();
    }
});

it("账号的非法预算仍从 IPC 装配抛出配置错误", async () => {
    const { actions, services, deps } = bridgeFixture(0, 4);
    await expect(attachOb11IpcBridge(actions, services, deps)).rejects.toBeInstanceOf(ConfigError);
    expect(actions.size).toBe(0);
});
