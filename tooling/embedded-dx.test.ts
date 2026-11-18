/**
 * 纯外部消费视角的嵌入式 DX 集成测试（不 import 任何包内相对路径）。
 *
 * 目的：锁定「外部开发者只依赖包入口」时的完整体验——
 *  1. 公共 API 表面（ProtocolConfig/ConfigBase、核心类型、Milky 子路径）；
 *  2. createKernelRuntime 最小装配 + Plain Object 协议配置启动；
 *  3. 收消息 → 发消息确认 → 异步监听器异常隔离 → 幂等销毁；
 *  4. MsgApi.sendMessage 完成后不残留 15s 确认定时器。
 *
 * ⚠️ 本文件只允许从包入口/子路径导入（@napuketto/kernel、@napuketto/adapter 等），
 * 禁止 `../../kernel` 之类的源码相对路径——那是内部视角，不能证明发布产物可用。
 *
 * 位置：`tooling/`——与 `package-exports.test.ts` 同属**产物契约测试**，不是某个包的
 * 模块单测（曾置于 `packages/adapter/src/__tests__/`，按模块单测口径被误读）。
 * 本文件断言的是 dist 产物：本地须先 `pnpm -r build`，否则会对着旧 dist 给出假绿；
 * CI 已把全量构建前置（ci.yml「check 与 test 的前置」）。
 */

import {
    NapukettoOneBot11Adapter,
    NapukettoOneBot11Adapter as RootOneBot11Adapter,
} from "@napuketto/adapter";
import { ConfigBase, ProtocolConfig } from "@napuketto/adapter/core";
import { NapukettoKurobotAdapter } from "@napuketto/adapter/kurobot";
import {
    createMilkyActionRegistry,
    MilkyApi,
    NapukettoMilkyAdapter,
} from "@napuketto/adapter/milky";
import { NapukettoSatoriAdapter } from "@napuketto/adapter/satori";
import {
    type CanonicalElement,
    ChatType,
    createKernelRuntime,
    GroupMemberDataSource,
    isKernelError,
    KernelError,
    type NodeIQQNTWrapperSession,
    type Peer,
    type PttElement,
    type QuickLoginOptions,
    type RawMessage,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";

/** 本地配置校验器（与协议包 zod schema 同构的最小 `parse` 面）。 */
const inlineSchema = {
    parse: (input: unknown): { flag: boolean } => {
        const flag = (input as { flag?: unknown } | null)?.flag;
        return { flag: typeof flag === "boolean" ? flag : true };
    },
};

/** 假 session（实现 runtime/桥/APIs 构造期校验所需的方法面）。 */
function makeFakeSession(): NodeIQQNTWrapperSession {
    const msgService = {
        addKernelMsgListener: vi.fn(() => 1),
        removeKernelMsgListener: vi.fn(),
        generateMsgUniqueId: vi.fn(() => "generated-1"),
        sendMsg: vi.fn(async () => ({ result: 0, errMsg: "" })),
        recallMsg: vi.fn(async () => ({ result: 0, errMsg: "" })),
        getMsgs: vi.fn(async () => ({ result: 0, errMsg: "" })),
        getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: "" })),
        setStatus: vi.fn(async () => ({ result: 0, errMsg: "" })),
    };
    const groupService = {
        addKernelGroupListener: vi.fn(() => 1),
        removeKernelGroupListener: vi.fn(),
        getGroupList: vi.fn(async () => ({ result: 0, errMsg: "" })),
        getGroupDetailInfo: vi.fn(async () => ({ result: 0, errMsg: "" })),
        getAllMemberList: vi.fn(async () => ({
            errCode: 0,
            errMsg: "",
            result: { ids: [], infos: new Map(), finish: true },
        })),
        getSingleScreenNotifies: vi.fn(async () => ({ result: 0, errMsg: "" })),
        operateSysNotify: vi.fn(async () => undefined),
    };
    const buddyService = {
        addKernelBuddyListener: vi.fn(() => 1),
        removeKernelBuddyListener: vi.fn(),
        getBuddyListFromCache: vi.fn(async () => []),
        getBuddyNick: vi.fn(() => ""),
    };
    const recentContactService = {
        addKernelRecentContactListener: vi.fn(() => 1),
        removeKernelRecentContactListener: vi.fn(),
        getRecentContactList: vi.fn(async () => ({ result: 0, errMsg: "" })),
    };
    return {
        getMsgService: () => msgService,
        getGroupService: () => groupService,
        getBuddyService: () => buddyService,
        getRecentContactService: () => recentContactService,
        getTicketService: () => ({ forceFetchClientKey: vi.fn(async () => ({ result: 0 })) }),
        getRichMediaService: () => ({ getGroupFileList: vi.fn(async () => ({ result: 0 })) }),
        getFlashTransferService: () => ({
            addFileSetUploadListener: vi.fn(),
            removeFileSetUploadListener: vi.fn(),
            createFlashTransferUploadTask: vi.fn(),
            sendFlashTransferMsg: vi.fn(async () => ({ result: 0, errMsg: "" })),
        }),
        getProfileService: () => ({
            getUserDetailInfo: vi.fn(async () => ({})),
            getUserDetailInfoByUin: vi.fn(async () => ({})),
        }),
        getProfileLikeService: () => ({
            setBuddyProfileLike: vi.fn(async () => ({ result: 0, errMsg: "" })),
        }),
    } as unknown as NodeIQQNTWrapperSession;
}

describe("嵌入式 DX：公共 API 表面", () => {
    it("ProtocolConfig 与 ConfigBase 均可从 @napuketto/adapter/core 构造", () => {
        const viaAlias = new ProtocolConfig({
            path: "<inline-alias>",
            schema: inlineSchema,
            defaults: { flag: true },
            seed: { flag: false },
        });
        const viaBase = new ConfigBase({
            path: "<inline-base>",
            schema: inlineSchema,
            defaults: { flag: true },
            seed: { flag: false },
        });
        expect(viaAlias).toBeInstanceOf(ConfigBase);
        expect(viaAlias.get()).toEqual({ flag: false });
        expect(viaBase.get()).toEqual({ flag: false });
    });

    it("kernel 入口导出核心类型 / 错误工具 / createKernelRuntime", () => {
        // 类型仅编译期验证（导入即证明可从包入口取到）
        const ptt: PttElement | null = null;
        const quick: QuickLoginOptions | null = null;
        expect(ptt).toBeNull();
        expect(quick).toBeNull();
        expect(typeof createKernelRuntime).toBe("function");
        const err = new KernelError("boom", "INVALID_STATE");
        expect(isKernelError(err)).toBe(true);
        expect(isKernelError(new Error("not-kernel"))).toBe(false);
        // GroupMemberDataSource 同时作为值与类型导出
        const source: GroupMemberDataSource = GroupMemberDataSource.CACHE;
        expect(source).toBe(0);
    });

    it("milky 子路径导出 MilkyApi / createMilkyActionRegistry，四个适配器均可导入", () => {
        expect(typeof MilkyApi).toBe("function");
        expect(typeof createMilkyActionRegistry).toBe("function");
        expect(NapukettoOneBot11Adapter).toBe(RootOneBot11Adapter);
        expect(typeof NapukettoSatoriAdapter).toBe("function");
        expect(typeof NapukettoKurobotAdapter).toBe("function");
        expect(typeof NapukettoMilkyAdapter).toBe("function");
    });
});

describe("嵌入式 DX：最小配置启动 / 收发 / 异常隔离 / 幂等销毁", () => {
    it("Plain Object 配置即可启动，收消息 + 发消息确认，异步异常不逃逸，重复 dispose 无报错", async () => {
        const session = makeFakeSession();
        const runtime = createKernelRuntime({ session });
        // sendMsg 桩通过 runtime 通道模拟原生确认事件（sendStatus=2 成功）
        const msgService = session.getMsgService() as unknown as {
            sendMsg: (arg0: string, peer: Peer) => Promise<unknown>;
        };
        msgService.sendMsg = vi.fn(async (_arg0: string, peer: Peer) => {
            runtime.msgChannel.emit("Msg/onMsgInfoListUpdate", [
                {
                    guildId: peer.guildId ?? "",
                    sendStatus: 2,
                    msgId: "msg-1",
                } as unknown as RawMessage,
            ]);
            return { result: 0, errMsg: "" };
        });

        const self = { uin: "10001", nickname: "bot" };
        const ob11 = new NapukettoOneBot11Adapter({
            ...runtime,
            config: { heartbeatInterval: 0 },
            msgChannel: runtime.msgChannel,
            self,
        });
        const milky = new NapukettoMilkyAdapter({
            ...runtime,
            config: { enabled: false },
            msgChannel: runtime.msgChannel,
            self,
        });
        await ob11.start();
        await milky.start();

        // 收链路：模拟 Msg/onRecvMsg 推送
        let received = 0;
        const offRecv = runtime.msgChannel.on("Msg/onRecvMsg", () => {
            received += 1;
        });
        const incoming = [
            {
                chatType: ChatType.C2C,
                peerUin: "10002",
                senderUin: "10003",
                msgId: "in-1",
                msgSeq: "1",
                msgTime: "1700000000",
                elements: [],
            } as unknown as RawMessage,
        ];
        runtime.msgChannel.emit("Msg/onRecvMsg", incoming);
        expect(received).toBe(1);

        // 发链路：sendMessage 等待 onMsgInfoListUpdate 确认（假定时器量测定时器残留）
        vi.useFakeTimers();
        try {
            const sent = await runtime.msgApi.sendMessage(
                { chatType: ChatType.C2C, peerUid: "10002" } satisfies Peer,
                [{ type: "text", text: "hello" }] satisfies CanonicalElement[],
            );
            expect(sent.msgId).toBe("msg-1");
            // 确认完成后 15s 兜底定时器必须已清理
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }

        // 异步监听器抛错：必须转发到 onError，而不是进程级 unhandledRejection
        const asyncErrors: unknown[] = [];
        const offError = runtime.msgChannel.onError((err) => asyncErrors.push(err));
        const offAsync = runtime.msgChannel.on("Msg/onRecvMsg", async () => {
            throw new Error("async-listener-boom");
        });
        runtime.msgChannel.emit("Msg/onRecvMsg", []);
        await Promise.resolve();
        await Promise.resolve();
        expect(asyncErrors).toHaveLength(1);

        offRecv();
        offAsync();
        offError();

        // 幂等销毁：连续两次 dispose 均无异常
        await expect(ob11.dispose()).resolves.toBeUndefined();
        await expect(ob11.dispose()).resolves.toBeUndefined();
        expect(() => runtime.dispose()).not.toThrow();
        expect(() => runtime.dispose()).not.toThrow();
        await expect(milky.dispose()).resolves.toBeUndefined();
    });
});
