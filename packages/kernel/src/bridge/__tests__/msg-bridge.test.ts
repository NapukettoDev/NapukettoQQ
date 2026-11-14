/**
 * msg-bridge.ts 单测：注册/注销/事件透传。
 *
 * 覆盖目标：MsgBridge 全部 8 个原生回调 → `Msg/*` 通道透传链路、
 * register/unregister 幂等、session 未 init 抛 INVALID_STATE。
 * 原生 service 以桩注入（捕获 listener 对象后手动触发），不碰真实 wrapper。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import type { MsgListener, RawMessage } from "../../types/index.js";
import { MsgBridge } from "../msg-bridge.js";
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

    it("onRecvMsg → Msg/onRecvMsg（消息数组透传）", () => {
        const { bridge, channel, listener } = makeBridge();
        const onRecvMsg = vi.fn();
        channel.on("Msg/onRecvMsg", onRecvMsg);
        bridge.register();
        const msgs: RawMessage[] = [{ msgId: "100", chatType: 1 } as never];
        listener()?.onRecvMsg(msgs);
        expect(onRecvMsg).toHaveBeenCalledWith(msgs);
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

    it("onRecvMsgReadReport → Msg/onRecvMsgReadReport", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onRecvMsgReadReport", handler);
        bridge.register();
        const reports = [{ peer: {}, readSeq: "9" }];
        listener()?.onRecvMsgReadReport(reports);
        expect(handler).toHaveBeenCalledWith(reports);
    });

    it("onRecvMsgReceipt → Msg/onRecvMsgReceipt", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onRecvMsgReceipt", handler);
        bridge.register();
        const receipts = [{ msgId: "1", readSeq: "2" }];
        listener()?.onRecvMsgReceipt(receipts);
        expect(handler).toHaveBeenCalledWith(receipts);
    });

    it("onMsgInfoListUpdate → Msg/onMsgInfoListUpdate", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onMsgInfoListUpdate", handler);
        bridge.register();
        const msgs: RawMessage[] = [{ msgId: "5", sendStatus: 2 } as never];
        listener()?.onMsgInfoListUpdate(msgs);
        expect(handler).toHaveBeenCalledWith(msgs);
    });

    it("onRecvOfflineFileMsg → Msg/onRecvOfflineFileMsg", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onRecvOfflineFileMsg", handler);
        bridge.register();
        const msgs: RawMessage[] = [{ msgId: "7" } as never];
        listener()?.onRecvOfflineFileMsg(msgs);
        expect(handler).toHaveBeenCalledWith(msgs);
    });

    it("onFileMsgCome → Msg/onFileMsgCome", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onFileMsgCome", handler);
        bridge.register();
        const msgs: RawMessage[] = [{ msgId: "8" } as never];
        listener()?.onFileMsgCome(msgs);
        expect(handler).toHaveBeenCalledWith(msgs);
    });

    it("onRecvOnlineFileMsg → Msg/onRecvOnlineFileMsg（unknown 透传）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onRecvOnlineFileMsg", handler);
        bridge.register();
        const arg = { anything: true };
        listener()?.onRecvOnlineFileMsg(arg);
        expect(handler).toHaveBeenCalledWith(arg);
    });

    it("onRecvSysMsg → Msg/onRecvSysMsg（原始字节透传）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Msg/onRecvSysMsg", handler);
        bridge.register();
        // 真实 payload = 原始 protobuf 字节（int8 数组），原样透传
        const arg = [10, 26, 8, 1];
        listener()?.onRecvSysMsg(arg as unknown);
        expect(handler).toHaveBeenCalledWith(arg);
    });

    it("unregister 后再 register 可以重新注册（listenerId 重置）", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.register();
        expect(service["addKernelMsgListener"]).toHaveBeenCalledTimes(2);
    });
});
