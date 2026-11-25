/**
 * msg-bridge.ts 单测：注册/注销/事件透传。
 *
 * 覆盖目标：MsgBridge 注册幂等（register/unregister/re-register）、session 未
 * init 抛 INVALID_STATE、图片落盘宽限发射（issue #105 防御），以及原生回调 →
 * `Msg/*` 通道的事件名与参数原样透传（表驱动冒烟，逐个回调一个用例）。
 * 原生 service 以桩注入（捕获 listener 对象后手动触发），不碰真实 wrapper。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../../src/infra/event-channel.js";
import { MsgBridge } from "../../../src/native/bridge/msg-bridge.js";
import type { MsgListener, RawMessage } from "../../../src/types/index.js";
import { makeCapturedService, makeSession } from "./test-support.js";

/** 构造 MsgBridge + 桩 service/channel。 */
function makeBridge() {
    const channel = new NTEventChannel<MsgListener, "Msg">("Msg");
    const { service, listener } = makeCapturedService<MsgListener>(
        "addKernelMsgListener",
        "removeKernelMsgListener",
    );
    const bridge = new MsgBridge(makeSession("getMsgService", service) as never, channel);
    return { bridge, channel, service, listener };
}

describe("MsgBridge", () => {
    it("session 未 init（getMsgService 返回 null）抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<MsgListener, "Msg">("Msg");
        expect(() => {
            new MsgBridge(makeSession("getMsgService", null) as never, channel);
        }).toThrow(/getMsgService\(\) 返回空/);
    });

    it("getMsgService 返回 undefined 同样抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<MsgListener, "Msg">("Msg");
        expect(() => {
            new MsgBridge(makeSession("getMsgService", undefined) as never, channel);
        }).toThrow(/getMsgService\(\) 返回空/);
    });

    it("register 注册原生监听且幂等", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.register();
        expect(service["addKernelMsgListener"]).toHaveBeenCalledTimes(1);
    });

    it("unregister 注销且幂等（传入 register 返回的 listenerId）", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.unregister();
        expect(service["removeKernelMsgListener"]).toHaveBeenCalledTimes(1);
        expect(service["removeKernelMsgListener"]).toHaveBeenCalledWith(42);
    });

    it("未 register 直接 unregister 不产生注销调用", () => {
        const { bridge, service } = makeBridge();
        bridge.unregister();
        expect(service["removeKernelMsgListener"]).not.toHaveBeenCalled();
    });

    it("onRecvMsg 图片路径缺失 → 宽限等待落盘后发射（issue #105 防御）", async () => {
        const { bridge, channel, listener } = makeBridge();
        const onRecvMsg = vi.fn();
        channel.on("Msg/onRecvMsg", onRecvMsg);
        bridge.register();
        const dir = mkdtempSync(join(tmpdir(), "napuketto-bridge-grace-"));
        try {
            const picPath = join(dir, "late.png");
            setTimeout(() => writeFileSync(picPath, "x"), 120);
            const msgs: RawMessage[] = [
                {
                    msgId: "101",
                    chatType: 1,
                    elements: [{ elementType: 2, picElement: { picPath } }],
                } as never,
            ];
            listener()?.onRecvMsg(msgs);
            // 未落盘不发射（异步等待中）
            expect(onRecvMsg).not.toHaveBeenCalled();
            // 落盘后补发（宽限默认 2s 上限，120ms 内创建足够余量）
            await vi.waitFor(() => expect(onRecvMsg).toHaveBeenCalled(), { timeout: 3000 });
            expect(onRecvMsg).toHaveBeenCalledWith(msgs);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("unregister 后再 register 可以重新注册（listenerId 重置）", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.register();
        expect(service["addKernelMsgListener"]).toHaveBeenCalledTimes(2);
    });

    it("Linux 原生纯文本（picElement: null）→ 同步发射，不因 null 丢整批事件", () => {
        const { bridge, channel, listener } = makeBridge();
        const onRecvMsg = vi.fn();
        channel.on("Msg/onRecvMsg", onRecvMsg);
        bridge.register();
        const msgs = [
            {
                msgId: "201",
                chatType: 1,
                elements: [
                    {
                        elementType: 1,
                        textElement: { content: "hi" },
                        picElement: null,
                        pttElement: null,
                        grayTipElement: null,
                        multiForwardMsgElement: null,
                    },
                ],
            },
        ] as unknown as RawMessage[];
        expect(() => listener()?.onRecvMsg(msgs)).not.toThrow();
        expect(onRecvMsg).toHaveBeenCalledWith(msgs);
    });

    it("图片候选判定抛异常 → 安全隔离后仍同步发射（异常元素不饿死整批）", () => {
        const { bridge, channel, listener } = makeBridge();
        const onRecvMsg = vi.fn();
        channel.on("Msg/onRecvMsg", onRecvMsg);
        bridge.register();
        const poisonPic = {
            elementType: 2,
            picElement: {
                get picPath(): string {
                    throw new TypeError("Cannot read properties of null");
                },
            },
        };
        const msgs = [
            { msgId: "202", chatType: 1, elements: [poisonPic] },
        ] as unknown as RawMessage[];
        // 旧实现：hasPendingPicPaths 同步抛错 → channel.emit 永不执行（静默丢事件）
        expect(() => listener()?.onRecvMsg(msgs)).not.toThrow();
        expect(onRecvMsg).toHaveBeenCalledWith(msgs);
    });
});

/** 透传样本：同一份数组既作原生回调实参，也作通道侧期望参数。 */
const recvMsgs: RawMessage[] = [{ msgId: "100", chatType: 1 } as never];
const readReports = [{ peer: {}, readSeq: "9" }] as never;
const receipts = [{ msgId: "1", readSeq: "2" }] as never;
const infoList = [{ msgId: "5", sendStatus: 2 }] as never;
const offlineFiles = [{ msgId: "7" }] as never;
const fileMsgs = [{ msgId: "8" }] as never;
const onlineFile = { anything: true };
const sysMsg = [10, 26, 8, 1];

describe("原生回调透传（表驱动冒烟）", () => {
    it.each([
        {
            name: "onRecvMsg",
            event: "Msg/onRecvMsg",
            invoke: (listener: MsgListener) => listener.onRecvMsg(recvMsgs),
            args: [recvMsgs],
        },
        {
            name: "onRecvMsgReadReport",
            event: "Msg/onRecvMsgReadReport",
            invoke: (listener: MsgListener) => listener.onRecvMsgReadReport(readReports),
            args: [readReports],
        },
        {
            name: "onRecvMsgReceipt",
            event: "Msg/onRecvMsgReceipt",
            invoke: (listener: MsgListener) => listener.onRecvMsgReceipt(receipts),
            args: [receipts],
        },
        {
            name: "onMsgInfoListUpdate",
            event: "Msg/onMsgInfoListUpdate",
            invoke: (listener: MsgListener) => listener.onMsgInfoListUpdate(infoList),
            args: [infoList],
        },
        {
            name: "onRecvOfflineFileMsg",
            event: "Msg/onRecvOfflineFileMsg",
            invoke: (listener: MsgListener) => listener.onRecvOfflineFileMsg(offlineFiles),
            args: [offlineFiles],
        },
        {
            name: "onFileMsgCome",
            event: "Msg/onFileMsgCome",
            invoke: (listener: MsgListener) => listener.onFileMsgCome(fileMsgs),
            args: [fileMsgs],
        },
        {
            name: "onRecvOnlineFileMsg",
            event: "Msg/onRecvOnlineFileMsg",
            invoke: (listener: MsgListener) => listener.onRecvOnlineFileMsg(onlineFile),
            args: [onlineFile],
        },
        {
            name: "onRecvSysMsg",
            event: "Msg/onRecvSysMsg",
            invoke: (listener: MsgListener) => listener.onRecvSysMsg(sysMsg),
            args: [sysMsg],
        },
    ])("$name → $event（参数原样透传）", ({ event, invoke, args }) => {
        const { bridge, channel, listener } = makeBridge();
        const seen: Array<{ event: string; args: unknown[] }> = [];
        channel.onAny((name, ...rest) => {
            seen.push({ event: name, args: rest });
        });
        bridge.register();
        const native = listener();
        expect(native).toBeDefined();
        if (native !== undefined) {
            invoke(native);
        }
        expect(seen).toEqual([{ event, args }]);
    });
});
