/**
 * 适配器层测试公共装配（adapter-lifecycle / adapter-events 共用）
 *
 * - `rawMsg`：RawMessage 最小桩（群聊文本默认，chatType/peer/elements 可覆写）。
 * - `adapterEnv`：桩 kernel 事件通道（NTEventChannel）+ 事件捕获 broadcaster +
 *   桩 MilkyApi，按需装配可选通道；返回 adapter 与各通道（测试经 `ch.*.emit`
 *   派发原生回调）、捕获数组与桩对象。
 * - `flushAsync`：微任务排空（通道回调里 void 异步链的确定性等待）。
 * - `ProtoWriter`：sysmsg fixture 的 protobuf 最小编码器（流式 builder，
 *   与 helper 单测的函数式编码器刻意不同构）。
 */
import {
    type BuddyListener,
    ChatType,
    type FriendApi,
    type GroupApi,
    type GroupCache,
    type GroupListener,
    type GroupNotifyApi,
    type LoginEventChannel,
    type MsgApi,
    type MsgListener,
    NTEventChannel,
    type ProfileApi,
    type ProfileLikeApi,
    type RawMessage,
    type RecentContactApi,
    type RecentContactListener,
    type RichMediaApi,
    type TicketApi,
    type WebApi,
} from "@napuketto/kernel";
import type { TransportAdapter } from "@napuketto/network";
import { EventBroadcaster } from "@napuketto/network";
import { vi } from "vitest";
import { stub } from "../../core/__tests__/stub.js";
import { ProtocolConfig } from "../../core/index.js";
import { NapukettoMilkyAdapter } from "../adapter.js";
import { MilkyApi } from "../api.js";
import type { MilkyConfig } from "../config.js";
import { milkyConfigSchema } from "../config.js";
import { MessageSeqIndex } from "../helper/state/seq-index.js";

/** RawMessage 最小桩（群聊文本消息；overrides 深合并 elements 整体替换）。 */
export function rawMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m-1",
        msgSeq: "101",
        msgTime: "1760000000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "uid-20002",
        senderUin: "20002",
        peerName: "测试群",
        sendNickName: "甲",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
        ...overrides,
    };
}

/** 微任务/短宏任务排空（setImmediate 两轮：通道回调内 void 异步链确定性完成）。 */
export async function flushAsync(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

/** 适配器环境（通道句柄 + 捕获 + 桩）。 */
export interface AdapterEnv {
    adapter: NapukettoMilkyAdapter;
    captures: unknown[];
    msgCh: NTEventChannel<MsgListener, "Msg">;
    groupCh: NTEventChannel<GroupListener, "Group"> | undefined;
    buddyCh: NTEventChannel<BuddyListener, "Buddy"> | undefined;
    recentCh: NTEventChannel<RecentContactListener, "RecentContact"> | undefined;
    /** Login 通道（kernel 未导出 LoginListener 类型，经 LoginEventChannel 别名持有）。 */
    loginCh: LoginEventChannel | undefined;
    api: MilkyApi;
    logger: {
        debug: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
    };
    config: ProtocolConfig<MilkyConfig>;
}

/** 环境选项（通道装配开关 / api 桩覆写 / 配置覆写）。 */
export interface EnvOptions {
    config?: Partial<MilkyConfig>;
    /** 文件态配置（reload 测试用）：指定后不使用 seed，save/load 走该临时文件。 */
    configFile?: boolean;
    msgApi?: Record<string, unknown>;
    groupApi?: Record<string, unknown>;
    friendApi?: Record<string, unknown>;
    webApi?: Record<string, unknown>;
    recentContactApi?: Record<string, unknown>;
    groupCache?: GroupCache;
    withGroupChannel?: boolean;
    withBuddyChannel?: boolean;
    withRecentContactChannel?: boolean;
    withLoginChannel?: boolean;
    selfUin?: string;
}

/** 环境构造默认端口（lifecycle 用固定高位端口；events 不依赖端口仅占用）。 */
const ADAPTER_TEST_PORT = 36381;

/** 构造适配器测试环境（不 start；测试自行 start/stop）。 */
export async function adapterEnv(opts: EnvOptions = {}): Promise<AdapterEnv> {
    const logger = {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
    };
    const captures: unknown[] = [];
    const broadcaster = new EventBroadcaster();
    const captureAdapter: TransportAdapter = {
        open: async () => undefined,
        close: async () => undefined,
        send: (event: unknown) => {
            captures.push(event);
        },
    };
    broadcaster.register(captureAdapter);

    const msgCh = new NTEventChannel<MsgListener, "Msg">("Msg");
    const groupCh =
        opts.withGroupChannel === true
            ? new NTEventChannel<GroupListener, "Group">("Group")
            : undefined;
    const buddyCh =
        opts.withBuddyChannel === true
            ? new NTEventChannel<BuddyListener, "Buddy">("Buddy")
            : undefined;
    const recentCh =
        opts.withRecentContactChannel === true
            ? new NTEventChannel<RecentContactListener, "RecentContact">("RecentContact")
            : undefined;
    const loginCh =
        opts.withLoginChannel === true
            ? // LoginListener 类型 kernel 根入口未导出（LoginEventChannel 才是公开面）：
              // 以宽松 listener 形状构造后收敛到公开通道类型。
              (new NTEventChannel<Record<string, unknown>, "Login">("Login") as LoginEventChannel)
            : undefined;

    const api = new MilkyApi(
        stub<ConstructorParameters<typeof MilkyApi>[0]>({
            msgApi: stub<MsgApi>({
                fetchMessages: vi.fn(async () => []),
                fetchMsgsByMsgId: vi.fn(async () => []),
                fetchForwardMessage: vi.fn(async () => []),
                sendMessage: vi.fn(async () => ({ msgId: "sent-1" })),
                recallMessage: vi.fn(async () => undefined),
                ...opts.msgApi,
            }),
            groupApi: stub<GroupApi>({
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(
                    async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("uid-", "")])),
                ),
                ...opts.groupApi,
            }),
            friendApi: stub<FriendApi>({
                getBuddyReqList: vi.fn(async () => []),
                ...opts.friendApi,
            }),
            profileApi: stub<ProfileApi>({}),
            profileLikeApi: stub<ProfileLikeApi>({}),
            ticketApi: stub<TicketApi>({}),
            webApi: stub<WebApi>({
                getEssenceMsgList: vi.fn(async () => []),
                ...opts.webApi,
            }),
            groupNotifyApi: stub<GroupNotifyApi>({
                getSingleScreenNotifies: vi.fn(async () => []),
                handleGroupRequest: vi.fn(async () => undefined),
            }),
            richMediaApi: stub<RichMediaApi>({}),
            recentContactApi: stub<RecentContactApi>({
                getPinnedContacts: vi.fn(async () => []),
                ...opts.recentContactApi,
            }),
            self: { uin: opts.selfUin ?? "10000", nickname: "机器人", uid: "uid-10000" },
            qqVersion: "9.9.9-test",
            implVersion: "0.0.0-test",
            ...(opts.groupCache !== undefined ? { groupCache: opts.groupCache } : {}),
        }),
        new MessageSeqIndex(),
    );

    const defaults = milkyConfigSchema.parse({
        enabled: true,
        host: "127.0.0.1",
        port: ADAPTER_TEST_PORT,
        ...opts.config,
    });
    const config = new ProtocolConfig({
        ...(opts.configFile === true
            ? { path: await mkdtempConfigPath() }
            : { path: "milky-adapter-test.toml", seed: defaults }),
        schema: milkyConfigSchema,
        defaults,
    });

    const adapter = new NapukettoMilkyAdapter({
        config,
        broadcaster,
        msgChannel: msgCh,
        ...(groupCh !== undefined ? { groupChannel: groupCh } : {}),
        ...(buddyCh !== undefined ? { buddyChannel: buddyCh } : {}),
        ...(recentCh !== undefined ? { recentContactChannel: recentCh } : {}),
        ...(loginCh !== undefined ? { loginChannel: loginCh } : {}),
        logger,
        msgApi: api.msgApi,
        groupApi: api.groupApi,
        friendApi: api.friendApi,
        profileApi: api.profileApi,
        profileLikeApi: api.profileLikeApi,
        ticketApi: api.ticketApi,
        webApi: api.webApi,
        groupNotifyApi: api.groupNotifyApi,
        richMediaApi: api.richMediaApi,
        recentContactApi: api.recentContactApi,
        ...(api.groupCache !== undefined ? { groupCache: api.groupCache } : {}),
        self: api.self,
        qqVersion: api.qqVersion,
        implVersion: api.implVersion,
    } as unknown as ConstructorParameters<typeof NapukettoMilkyAdapter>[0]);

    return {
        adapter,
        captures,
        msgCh,
        groupCh,
        buddyCh,
        recentCh,
        loginCh,
        api,
        logger,
        config,
    };
}

/** 文件态配置用临时目录（afterAll 经 cleanupEnvDirs 统一清理）。 */
const envDirs: string[] = [];

/** 清理全部文件态配置临时目录（测试文件 afterAll 调用）。 */
export async function cleanupEnvDirs(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    for (const dir of envDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** 临时配置文件路径（tmpdir 下唯一目录内）。 */
async function mkdtempConfigPath(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "nk-test-milky-cfg-"));
    envDirs.push(dir);
    return join(dir, "milky-adapter-test.toml");
}

/** protobuf 最小编码器（sysmsg fixture 用；流式 builder）。 */
export class ProtoWriter {
    private readonly out: number[] = [];

    /** wire 0 varint 字段。 */
    varint(no: number, value: number | bigint): this {
        this.pushTag(no, 0);
        this.pushVarintBody(BigInt(value));
        return this;
    }

    /** wire 2 字节字段。 */
    bytes(no: number, payload: Uint8Array): this {
        this.pushTag(no, 2);
        this.pushVarintBody(BigInt(payload.length));
        this.out.push(...payload);
        return this;
    }

    /** wire 2 文本字段（UTF-8）。 */
    text(no: number, value: string): this {
        return this.bytes(no, new TextEncoder().encode(value));
    }

    /** 产出。 */
    build(): Uint8Array {
        return Uint8Array.from(this.out);
    }

    private pushTag(no: number, wire: number): void {
        this.pushVarintBody(BigInt(no) * 8n + BigInt(wire));
    }

    private pushVarintBody(value: bigint): void {
        let v = value;
        for (;;) {
            const b = Number(v & 0x7fn);
            v >>= 7n;
            if (v === 0n) {
                this.out.push(b);
                return;
            }
            this.out.push(b | 0x80);
        }
    }
}
