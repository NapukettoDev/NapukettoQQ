/**
 * kurobot-smoke.test.ts：本地端到端冒烟（任务书 KUROBOT-PROMPT 阶段 4，无 QQ）。
 *
 * 验证真装配链：TOML 写 [accounts.kurobot] → loader loadProtocolSections（真源码）
 * 取段 → adapter **构建产物**（dist/kurobot/index.mjs + dist/core）装配 → 连入
 * 假 kurobot-ws 服务端 → 双向帧（hello / MC→QQ 渲染 / QQ→MC chat+command）；
 * 删段 → 空段不装配；cli/脚手架模板含注释段。
 * 与 packages/adapter/src/kurobot/*.test.ts 的区别：那边测 src 源码单元行为，
 * 这里跨包拉通「配置文件 → 装配缝隙 → 构建产物」（不依赖 wrapper.node）。
 *
 * ⚠️ loader env 是 import 时快照（env.ts 头注释）——NAPKETTO_CONFIG 必须在
 * 动态 import load-config 之前写 process.env。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
    type FakeKurobotServer,
    startFakeKurobotServer,
    waitFor,
} from "../packages/adapter/src/kurobot/test-support.js";
import type { MsgEventChannel } from "../packages/kernel/src/index.js";

/** adapter 构建产物最小面（kurobot 子路径导出）。 */
interface KurobotDistModule {
    NapukettoKurobotAdapter: new (
        opts: Record<string, unknown>,
    ) => {
        start(): Promise<void>;
        stop(): Promise<void>;
        isConnected(): boolean;
        query(kind: "status" | "bindings"): boolean;
    };
    kurobotConfigSchema: { parse(input: unknown): { url: string; [key: string]: unknown } };
    kurobotConfigDefaults: () => unknown;
}

/** adapter core 构建产物最小面（ProtocolConfig）。 */
interface CoreDistModule {
    ProtocolConfig: new (opts: Record<string, unknown>) => unknown;
}

/** loader load-config 真源码最小面（loadProtocolSections）。 */
interface LoadConfigModule {
    loadProtocolSections(
        kernel: { parseToml(text: string): Record<string, unknown> },
        uin?: string,
    ): {
        cfgFile: string;
        kurobotSection: Record<string, unknown>;
    };
}

let tmpRoot = "";

function tempDir(): string {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-kurobot-smoke-"));
    }
    return tmpRoot;
}

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

/** 桩消息通道（同 adapter 单测）。 */
function stubMsgChannel(): { channel: MsgEventChannel; emit: (msgs: unknown) => void } {
    let handler: ((msgs: unknown) => void) | null = null;
    const channel = {
        on: (_e: string, cb: (msgs: unknown) => void) => {
            handler = cb;
            return () => undefined;
        },
    } as unknown as MsgEventChannel;
    return { channel, emit: (m) => handler?.(m) };
}

/** 桩消息 API（记录群发送）。 */
function stubMsgApi(): {
    api: { sendMessage: (t: unknown, els: unknown[]) => Promise<{ msgId: string }> };
    sent: { peerUid: unknown; text: string }[];
} {
    const sent: { peerUid: unknown; text: string }[] = [];
    return {
        sent,
        api: {
            sendMessage: async (target, elements) => {
                const first = elements[0] as { type: string; text?: string } | undefined;
                sent.push({
                    peerUid: (target as { peerUid: unknown }).peerUid,
                    text: first?.text ?? "",
                });
                return { msgId: "1" };
            },
        },
    };
}

/** 合成群消息（elements NT 原始形状）。 */
function groupMsg(channel: string, senderUin: string, text: string): unknown {
    return [
        {
            msgId: "1",
            msgSeq: "1",
            msgTime: "0",
            msgType: 2,
            chatType: 2,
            peerUid: channel,
            peerUin: channel,
            senderUid: `u_${senderUin}`,
            senderUin,
            peerName: "测试群",
            sendNickName: "昵称",
            sendMemberName: "群名片",
            elements: [{ elementType: 1, textElement: { content: text } }],
        },
    ];
}

/** 动态加载构建产物与 loader 真源码（env 快照前设置 NAPKETTO_CONFIG）。 */
async function loadAssemblyModules(cfgPath: string): Promise<{
    kurobot: KurobotDistModule;
    core: CoreDistModule;
    loadConfig: LoadConfigModule;
    parseToml: (text: string) => Record<string, unknown>;
}> {
    process.env["NAPKETTO_CONFIG"] = cfgPath;
    // loader env 是 import 时快照 + 模块缓存跨用例共享 → 每次重置模块注册表，
    // 保证 load-config 按本用例的 NAPKETTO_CONFIG 取快照
    vi.resetModules();
    const root = join(import.meta.dirname, "..");
    const kurobot = (await import(
        pathToFileURL(join(root, "packages/adapter/dist/kurobot/index.mjs")).href
    )) as unknown as KurobotDistModule;
    const core = (await import(
        pathToFileURL(join(root, "packages/adapter/dist/core/index.mjs")).href
    )) as unknown as CoreDistModule;
    const loadConfig = (await import(
        pathToFileURL(join(root, "packages/loader/src/host/load-config.ts")).href
    )) as unknown as LoadConfigModule;
    // parseToml 用 kernel 真实现（loader 装配链同款；root 无 workspace link → 相对源码导入）
    const kernel = (await import(
        pathToFileURL(join(root, "packages/kernel/src/infra/config.ts")).href
    )) as unknown as {
        parseToml(text: string): Record<string, unknown>;
    };
    return { kurobot, core, loadConfig, parseToml: kernel.parseToml };
}

let sharedServer: FakeKurobotServer | null = null;

afterAll(async () => {
    await sharedServer?.stop();
});

describe("kurobot 端到端冒烟（真装配链，无 QQ）", () => {
    it("TOML 写 [accounts.kurobot] → loader 取段 → dist 适配器连入假服务端 → 双向帧全通", async () => {
        const server = await startFakeKurobotServer();
        sharedServer = server;
        // 假服务端：hello ack（绑定 808）+ command 回执
        server.onClientFrame = (frame, conn) => {
            if (frame.header.type === "hello" && typeof frame.header.id === "string") {
                server.send(conn, {
                    type: "hello_ack",
                    id: frame.header.id,
                    body: {
                        ok: true,
                        serverId: "smoke-server",
                        version: "1.0.0",
                        protocolVersion: "0.3.1",
                        channelBindings: ["808"],
                    },
                });
                return;
            }
            if (frame.header.type === "command" && typeof frame.header.id === "string") {
                server.send(conn, {
                    type: "command_result",
                    id: frame.header.id,
                    body: { ok: true, output: ["There are 2 whitelisted players"] },
                });
            }
        };

        // 1) 写全局 TOML（[[accounts]] + [accounts.kurobot]，url 指向假服务端）
        const cfgPath = join(tempDir(), "napuketto.toml");
        writeFileSync(
            cfgPath,
            [
                "[[accounts]]",
                'qq = "10001"',
                "enabled = true",
                "",
                "[accounts.kurobot]",
                `url = "ws://127.0.0.1:${server.port}"`,
                'commandPrefix = "/"',
                "",
            ].join("\n"),
            "utf8",
        );

        // 2) 真装配链：loader loadProtocolSections（真源码）→ dist 适配器
        const { kurobot, core, loadConfig, parseToml } = await loadAssemblyModules(cfgPath);
        const { cfgFile, kurobotSection } = loadConfig.loadProtocolSections({ parseToml }, "10001");
        expect(cfgFile).toBe(cfgPath);
        expect(Object.keys(kurobotSection).length).toBeGreaterThan(0); // 装配分支条件成立
        expect(kurobotSection["url"]).toBe(`ws://127.0.0.1:${server.port}`);

        // 捕获日志（验收「连入日志可见」）
        const logs: string[] = [];
        const logger = {
            debug: () => undefined,
            info: (_o: unknown, msg: string) => logs.push(msg),
            warn: (_o: unknown, msg: string) => logs.push(msg),
            error: (_o: unknown, msg: string) => logs.push(msg),
        };
        const { channel: msgChannel, emit } = stubMsgChannel();
        const { api: msgApi, sent } = stubMsgApi();
        const adapter = new kurobot.NapukettoKurobotAdapter({
            config: new core.ProtocolConfig({
                path: cfgFile,
                schema: kurobot.kurobotConfigSchema,
                defaults: kurobot.kurobotConfigDefaults(),
                seed: kurobot.kurobotConfigSchema.parse(kurobotSection),
            }),
            msgChannel,
            msgApi,
            self: { uin: "10001", nickname: "机器人" },
            logger,
        });
        await adapter.start();
        await waitFor(() => (adapter.isConnected() ? true : null));
        expect(logs).toContain("kurobot: 握手成功");

        // 3) QQ → MC：群文字 → chat 帧
        emit(groupMsg("808", "20002", "大家好"));
        const chat = await waitFor(
            () => server.frames.find((f) => f.header.type === "chat") ?? null,
        );
        expect(chat?.body).toEqual({ channel: "808", sender: "群名片", content: "大家好" });

        // 4) 命令链：/whitelist list → command 帧 → command_result → 渲染回群
        emit(groupMsg("808", "20002", "/whitelist list"));
        const cmd = await waitFor(
            () => server.frames.find((f) => f.header.type === "command") ?? null,
        );
        expect(cmd?.body).toEqual({
            command: "whitelist list",
            source: { channel: "808", userId: "20002" },
        });
        await waitFor(() => (sent.length > 0 ? sent[0] : null));
        expect(sent[0]).toEqual({ peerUid: "808", text: "There are 2 whitelisted players" });

        // 5) MC → QQ：服务端 chat 帧 → 模板渲染回群
        const conn = server.connections[server.connections.length - 1];
        if (conn === undefined) {
            throw new Error("假服务端无连接");
        }
        server.send(conn, {
            type: "chat",
            body: { channel: "808", playerName: "Steve", content: "hello from mc" },
        });
        await waitFor(() => (sent.length > 1 ? sent[1] : null));
        expect(sent[1]).toEqual({ peerUid: "808", text: "[Steve] hello from mc" });

        await adapter.stop();
        await server.stop();
        sharedServer = null;
    });

    it("删段 → loadProtocolSections 返回空段（装配分支条件不成立 = 不装配）", async () => {
        const cfgPath = join(tempDir(), "napuketto-no-kurobot.toml");
        writeFileSync(
            cfgPath,
            ["[[accounts]]", 'qq = "10001"', "enabled = true", ""].join("\n"),
            "utf8",
        );
        const { loadConfig, parseToml } = await loadAssemblyModules(cfgPath);
        const { kurobotSection } = loadConfig.loadProtocolSections({ parseToml }, "10001");
        expect(Object.keys(kurobotSection)).toHaveLength(0);
        // assemble-protocols.ts 装配分支条件：Object.keys(kurobotSection).length > 0
        //（空段 → 跳过 NapukettoKurobotAdapter 构造与 start，不连任何服务端）
    });

    it("cli 与 create-napukettoqq 模板含 [accounts.kurobot] 注释段", async () => {
        const root = join(import.meta.dirname, "..");
        const cliTemplate = readFileSync(join(root, "apps/cli/src/config-template.ts"), "utf8");
        const scaffoldTemplate = readFileSync(
            join(root, "apps/create-napukettoqq/templates/napuketto.toml.tmpl"),
            "utf8",
        );
        expect(cliTemplate).toContain("[accounts.kurobot]");
        expect(scaffoldTemplate).toContain("[accounts.kurobot]");
    });
});
