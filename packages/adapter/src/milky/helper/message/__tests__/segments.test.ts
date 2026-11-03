/**
 * Milky 消息段转换测试（helper/message/segments.ts，纯函数 ADR-008）
 *
 * 锁定：接收方向 canonical → IncomingSegment 全 10 类映射（at 失败跳过 /
 * reply 元信息回填 / 媒体 resource_id 的 path 优先 url 兜底 / json app 解析 /
 * xml 载荷序列化）、未知类型跳过；发送方向 OutgoingSegment → canonical 全类
 * （mention/mention_all/face/reply/媒体 URI 占位/forward 混发拒绝/未知段跳过）、
 * file:// 路径展开（Windows 盘符兼容）、forward 段接收注入。
 */
import { pathToFileURL } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import type { OutgoingSegment } from "../../../types.js";
import {
    canonicalToIncomingSegments,
    incomingForwardSegment,
    outgoingSegmentsToCanonical,
    type ReceiveSegmentContext,
    type ReplyMeta,
} from "../segments.js";

/** reply 元信息表（m1 → seq 5 / sender 20002 / t 1760000000）。 */
const REPLY_META = new Map<string, ReplyMeta>([
    ["m1", { messageSeq: 5, senderId: 20002, time: 1760000000 }],
]);

/** 接收上下文（uid→uin 映射 + reply 元信息）。 */
function ctx(overrides: Partial<ReceiveSegmentContext> = {}): ReceiveSegmentContext {
    return {
        uidToUin: new Map([["uid-20002", "20002"]]),
        replyMeta: REPLY_META,
        ...overrides,
    };
}

describe("canonicalToIncomingSegments：文本/提及/表情", () => {
    it("text 直映射", () => {
        const out = canonicalToIncomingSegments([{ type: "text", text: "你好" }]);
        expect(out).toEqual([{ type: "text", data: { text: "你好" } }]);
    });

    it("at all → mention_all（不做 uid 转换）", () => {
        const out = canonicalToIncomingSegments([{ type: "at", target: "all" }], ctx());
        expect(out).toEqual([{ type: "mention_all", data: {} }]);
    });

    it("at uid：映射命中 → mention user_id；display 缺省空串", () => {
        const out = canonicalToIncomingSegments([{ type: "at", target: "uid-20002" }], ctx());
        expect(out).toEqual([{ type: "mention", data: { user_id: 20002, name: "" } }]);
    });

    it("at uid：映射未命中且目标非数字串 → 段跳过（null）", () => {
        const out = canonicalToIncomingSegments([{ type: "at", target: "u_abc" }], ctx());
        expect(out).toEqual([]);
    });

    it("at uid：无 ctx 映射时目标原样兜底（数字串 uin 可用）", () => {
        const out = canonicalToIncomingSegments([{ type: "at", target: "30003" }], {
            uidToUin: new Map(),
        });
        expect(out).toEqual([{ type: "mention", data: { user_id: 30003, name: "" } }]);
    });

    it("face → face 段（is_large 恒 false）", () => {
        const out = canonicalToIncomingSegments([{ type: "face", id: "12" }]);
        expect(out).toEqual([{ type: "face", data: { face_id: "12", is_large: false } }]);
    });
});

describe("canonicalToIncomingSegments：reply / 媒体 / 文件", () => {
    it("reply：元信息命中 → 回填 seq/sender/time", () => {
        const out = canonicalToIncomingSegments([{ type: "reply", messageId: "m1" }], ctx());
        expect(out).toEqual([
            {
                type: "reply",
                data: {
                    message_seq: 5,
                    sender_id: 20002,
                    sender_name: null,
                    time: 1760000000,
                    segments: [],
                },
            },
        ]);
    });

    it("reply：元信息未命中 → 全 0 兜底", () => {
        const out = canonicalToIncomingSegments([{ type: "reply", messageId: "ghost" }], ctx());
        expect(out[0]?.data).toMatchObject({ message_seq: 0, sender_id: 0, time: 0 });
    });

    it("image：path 非空 resource_id=path；path 空 resource_id=url 兜底", () => {
        const out = canonicalToIncomingSegments([
            {
                type: "image",
                path: "/local/a.png",
                url: "http://x/a.png",
                size: { width: 8, height: 9 },
            },
            { type: "image", path: "", url: "http://x/b.png" },
        ]);
        expect(out[0]?.data).toEqual({
            resource_id: "/local/a.png",
            temp_url: "http://x/a.png",
            width: 8,
            height: 9,
            summary: "",
            sub_type: "normal",
        });
        expect(out[1]?.data).toMatchObject({ resource_id: "http://x/b.png" });
    });

    it("voice：durationMs 取整秒；缺省 0", () => {
        const out = canonicalToIncomingSegments([
            { type: "voice", path: "/v.slk", durationMs: 4570, url: "http://x/v" },
            { type: "voice", path: "/v2.slk" },
        ]);
        expect(out[0]?.data).toEqual({
            resource_id: "/v.slk",
            temp_url: "http://x/v",
            duration: 5,
        });
        expect(out[1]?.data).toEqual({ resource_id: "/v2.slk", temp_url: "", duration: 0 });
    });

    it("video：宽高/时长字段映射", () => {
        const out = canonicalToIncomingSegments([
            { type: "video", path: "/v.mp4", width: 100, height: 60, durationSec: 12 },
        ]);
        expect(out[0]?.data).toEqual({
            resource_id: "/v.mp4",
            temp_url: "",
            width: 100,
            height: 60,
            duration: 12,
        });
    });

    it("file：file_id=path + name/size 兜底", () => {
        const out = canonicalToIncomingSegments([{ type: "file", path: "uuid-x" }]);
        expect(out).toEqual([
            { type: "file", data: { file_id: "uuid-x", file_name: "", file_size: 0 } },
        ]);
    });
});

describe("canonicalToIncomingSegments：json / xml / 未知", () => {
    it("json：raw 字符串为合法 JSON → app_name 提取 + 载荷原样", () => {
        const out = canonicalToIncomingSegments([
            { type: "json", raw: '{"app":"com.tencent.news","k":1}' },
        ]);
        expect(out).toEqual([
            {
                type: "light_app",
                data: {
                    app_name: "com.tencent.news",
                    json_payload: '{"app":"com.tencent.news","k":1}',
                },
            },
        ]);
    });

    it("json：raw 为对象 → app_name 提取 + 载荷 JSON 序列化", () => {
        const out = canonicalToIncomingSegments([
            { type: "json", raw: { app: "com.tencent.mimi", x: 1 } },
        ]);
        const data = out[0]?.data as { app_name: string; json_payload: string };
        expect(data.app_name).toBe("com.tencent.mimi");
        expect(JSON.parse(data.json_payload)).toEqual({ app: "com.tencent.mimi", x: 1 });
    });

    it("json：非法 JSON 字符串 → app_name 空串", () => {
        const out = canonicalToIncomingSegments([{ type: "json", raw: "{not-json" }]);
        expect(out[0]?.data).toEqual({
            app_name: "",
            json_payload: "{not-json",
        });
    });

    it("json：无 app 字段 / app 非字符串 → 空串", () => {
        const noApp = canonicalToIncomingSegments([{ type: "json", raw: '{"a":1}' }])[0];
        const appNum = canonicalToIncomingSegments([{ type: "json", raw: '{"app":5}' }])[0];
        expect(noApp?.data).toMatchObject({ app_name: "" });
        expect(appNum?.data).toMatchObject({ app_name: "" });
    });

    it("xml：service_id 恒 0 + 载荷字符串化（对象）或原样（字符串）", () => {
        const out = canonicalToIncomingSegments([
            { type: "xml", raw: "<xml/>" },
            { type: "xml", raw: { svc: 1 } },
        ]);
        expect(out[0]?.data).toEqual({ service_id: 0, xml_payload: "<xml/>" });
        expect(out[1]?.data).toEqual({ service_id: 0, xml_payload: '{"svc":1}' });
    });

    it("未知/未映射类型（unknown、forward）→ 跳过", () => {
        const out = canonicalToIncomingSegments([
            { type: "unknown", raw: {} } as unknown as CanonicalElement,
            { type: "forward", messageIds: ["a"] } as unknown as CanonicalElement,
            { type: "text", text: "keep" },
        ]);
        expect(out).toEqual([{ type: "text", data: { text: "keep" } }]);
    });
});

describe("incomingForwardSegment", () => {
    it("resId + title 进 forward 段（preview/summary 固定空）", () => {
        expect(incomingForwardSegment("res-1", "聊天记录")).toEqual({
            type: "forward",
            data: { forward_id: "res-1", title: "聊天记录", preview: [], summary: "" },
        });
    });
});

describe("outgoingSegmentsToCanonical：发送方向全类", () => {
    it("text / mention / mention_all / face / reply", () => {
        const { elements, atUins, replySeqs } = outgoingSegmentsToCanonical([
            { type: "text", data: { text: "hi" } },
            { type: "mention", data: { user_id: 90001 } },
            { type: "mention_all", data: {} },
            { type: "face", data: { face_id: "5" } },
            { type: "reply", data: { message_seq: 42 } },
        ]);
        expect(elements).toEqual([
            { type: "text", text: "hi" },
            { type: "at", target: "90001" },
            { type: "at", target: "all" },
            { type: "face", id: "5" },
            { type: "reply", messageId: "42" },
        ]);
        expect(atUins).toEqual(["90001"]);
        expect(replySeqs).toEqual([42]);
    });

    it("媒体段：file:// 同步展开；http(s)/base64/裸路径占位原样", () => {
        const fileUri = pathToFileURL("/tmp/a.png").href;
        const { elements } = outgoingSegmentsToCanonical([
            { type: "image", data: { uri: fileUri } },
            { type: "record", data: { uri: "base64://AAAA" } },
            { type: "video", data: { uri: "http://x/v.mp4" } },
            { type: "image", data: { uri: "/local/b.png" } },
        ]);
        expect(elements[0]).toEqual({ type: "image", path: expect.stringContaining("a.png") });
        expect(elements[1]).toEqual({ type: "voice", path: "base64://AAAA" });
        expect(elements[2]).toEqual({ type: "video", path: "http://x/v.mp4" });
        expect(elements[3]).toEqual({ type: "image", path: "/local/b.png" });
    });

    it("light_app → json canonical（raw 载荷原样）", () => {
        const { elements } = outgoingSegmentsToCanonical([
            { type: "light_app", data: { json_payload: '{"app":"x"}' } },
        ]);
        expect(elements).toEqual([{ type: "json", raw: '{"app":"x"}' }]);
    });

    it("forward 段（混发漏网）→ INVALID_PARAM 抛错", () => {
        let code = "";
        try {
            outgoingSegmentsToCanonical([
                { type: "text", data: { text: "x" } },
                { type: "forward", data: {} } as unknown as OutgoingSegment,
            ]);
        } catch (err) {
            code = (err as { code: string }).code;
        }
        expect(code).toBe("INVALID_PARAM");
    });

    it("未知段类型 → 跳过不抛", () => {
        const { elements } = outgoingSegmentsToCanonical([
            { type: "market_face", data: {} } as unknown as OutgoingSegment,
            { type: "text", data: { text: "y" } },
        ]);
        expect(elements).toEqual([{ type: "text", text: "y" }]);
    });

    it("file:// 畸形 URI（fileURLToPath 失败）→ 裸剥离前缀兜底", () => {
        const { elements } = outgoingSegmentsToCanonical([
            // file:// 单斜杠 + 非法转义：fileURLToPath 在 win32 抛错，走 replace 兜底
            { type: "image", data: { uri: "file://%zz" } },
        ]);
        expect(elements[0]).toEqual({ type: "image", path: expect.stringContaining("%zz") });
    });
});
