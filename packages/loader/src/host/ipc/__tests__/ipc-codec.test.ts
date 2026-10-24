/**
 * ipc-codec.test.ts：IPC 编解码单测（与 koishi 插件侧 codec.test.ts 对齐）。
 */
import { describe, expect, it } from "vitest";
import { decodeIpcMessage, encodeIpcMessage } from "../ipc-codec.js";
import { IPC_VERSION, type IpcMessage } from "../ipc-types.js";

describe("ipc-codec", () => {
    it("encode/decode roundtrip", () => {
        const message: IpcMessage = {
            v: IPC_VERSION,
            type: "event",
            payload: { service: "Msg", name: "onRecvMsg", args: [{ msgId: 1 }] },
        };
        const line = encodeIpcMessage(message);
        expect(line.endsWith("\n")).toBe(true);
        expect(decodeIpcMessage(line)).toEqual(message);
    });

    it("decode 非法输入返回 null", () => {
        expect(decodeIpcMessage("")).toBeNull();
        expect(decodeIpcMessage("   ")).toBeNull();
        expect(decodeIpcMessage("not json")).toBeNull();
        expect(decodeIpcMessage('{"v":1,"type":"nope"}')).toBeNull();
        expect(decodeIpcMessage('{"v":999,"type":"ping"}')).toBeNull();
        expect(decodeIpcMessage("[1,2,3]")).toBeNull();
    });

    it("decode 容忍多余空白", () => {
        const message = { v: IPC_VERSION, type: "ping" } as const;
        expect(decodeIpcMessage(`  ${encodeIpcMessage(message).trim()}  `)).toEqual(message);
    });

    it("encode 规整 Map/Set（2026-10-24 线上事故回归：thumbPath Map 跨进程不得丢成 {}）", () => {
        const message = {
            v: IPC_VERSION,
            type: "event",
            payload: {
                service: "Msg",
                name: "onRecvMsg",
                args: [
                    {
                        elements: [
                            {
                                elementType: 5,
                                videoElement: {
                                    filePath: "/v.mp4",
                                    thumbPath: new Map([[0, "/t.png"]]),
                                },
                            },
                        ],
                    },
                ],
            },
        } as unknown as IpcMessage;
        const decoded = decodeIpcMessage(encodeIpcMessage(message));
        expect(decoded).not.toBeNull();
        const args = (decoded as { payload: { args: unknown[] } | undefined }).payload?.args ?? [];
        const video = (args[0] as { elements: Array<{ videoElement: { thumbPath: unknown } }> })
            .elements[0]?.videoElement;
        expect(video?.thumbPath).toEqual({ "0": "/t.png" });
    });
});
