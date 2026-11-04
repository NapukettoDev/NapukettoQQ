/**
 * msg-log.test.ts：消息日志单测（2026-09-06 colorize；2026-10-25 级别与过滤）。
 *
 * 覆盖：
 *  - colorize 选择：true 落彩色串（cli 终端，2026-08-07 用户定稿），false 落
 *    plain（IPC 模式 logger 是纯文件 JSON 日志，ANSI 转义会污染 JSON 行）
 *  - 接收行级别：info → debug（2026-10-25 级别重分配）
 *  - 绑定过滤（P1-7）：holder 判定未绑定的群消息整行不打；私聊恒放行；
 *    holder null / 未传 = 不过滤
 *
 * env.ts 是模块加载时的 process.env 快照——NAPUTO_CFG_DIR 指向临时目录使
 * log() 落盘无污染。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReceiveLogFilter } from "../msg-log.js";
import type { EventChannelLike, KernelLike, LoggerLike } from "../types.js";

/** 计算键规避 useNamingConvention（kernel 常量成员名 ChatType 为 PascalCase）。 */
const CHAT_TYPE = "ChatType";

let tmpRoot = "";
let emit: ((payload: unknown) => void) | undefined;
const coloredSinks: unknown[] = [];
const plainSinks: unknown[] = [];
const infoCalls: unknown[] = [];

function stubKernel(): KernelLike {
    return {
        [CHAT_TYPE]: { GROUP: 1, C2C: 2 },
        toCanonicalElements: (msg: unknown) => {
            const raw = msg as { elements?: unknown };
            return (Array.isArray(raw.elements) ? raw.elements : []) as never[];
        },
    } as unknown as KernelLike;
}

function stubLogger(sink: unknown[]): LoggerLike {
    return {
        debug: (obj) => sink.push(obj),
        info: (obj) => infoCalls.push(obj),
        warn: (obj) => sink.push(obj),
        error: (obj) => sink.push(obj),
    };
}

function groupMsg(): unknown {
    return {
        chatType: 1,
        peerUin: "100",
        senderUin: "200",
        elements: [{ type: "text", text: "hi" }],
    };
}

function privateMsg(): unknown {
    return {
        chatType: 2,
        peerUin: "300",
        senderUin: "300",
        elements: [{ type: "text", text: "pm" }],
    };
}

/** 触发一次 onRecvMsg 并断言两个 sink 各收到一条。 */
function recvOnce(): void {
    coloredSinks.length = 0;
    plainSinks.length = 0;
    emit?.(groupMsg());
    expect(coloredSinks).toHaveLength(1);
    expect(plainSinks).toHaveLength(1);
}

beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-msglog-test-"));
    vi.stubEnv("NAPUTO_CFG_DIR", tmpRoot);
    const { setupMsgLogging } = await import("../msg-log.js");
    const kernel = stubKernel();
    const handlers: ((payload: unknown) => void)[] = [];
    const channel: EventChannelLike = {
        on: (_event, h) => {
            handlers.push(h);
            return undefined;
        },
    };
    setupMsgLogging(kernel, channel, stubLogger(coloredSinks), true);
    setupMsgLogging(kernel, channel, stubLogger(plainSinks), false);
    emit = (payload) => {
        for (const h of handlers) {
            h(payload);
        }
    };
});

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

describe("setupMsgLogging colorize 选择", () => {
    it("colorize=true 落彩色串（含 ANSI 转义，cli 终端行为）", () => {
        recvOnce();
        const line = coloredSinks[0] as string;
        expect(line).toContain("\u001b[90mloader | 接收 <- 群聊");
        expect(line).toContain("\u001b[36m[群100]\u001b[0m");
        expect(line).toContain("\u001b[32m[用户200]\u001b[0m");
    });

    it("colorize=false 落 plain（无 ANSI 转义，IPC 文件 JSON 日志可读）", () => {
        recvOnce();
        const line = plainSinks[0] as string;
        expect(line).toBe("接收 <- 群聊 [群100] [用户200]： hi");
        expect(line).not.toContain("\u001b");
    });

    it("接收行走 debug 级（2026-10-25 级别重分配，info 不再出现）", () => {
        recvOnce();
        expect(infoCalls).toHaveLength(0);
    });
});

describe("setupMsgLogging 绑定过滤（P1-7）", () => {
    it("未绑定的群消息整行不打，绑定的群与私聊放行", async () => {
        const { setupMsgLogging } = await import("../msg-log.js");
        const sink: unknown[] = [];
        const handlers: ((payload: unknown) => void)[] = [];
        const channel: EventChannelLike = {
            on: (_event, h) => {
                handlers.push(h);
                return undefined;
            },
        };
        const filter: ReceiveLogFilter = { current: null };
        setupMsgLogging(stubKernel(), channel, stubLogger(sink), false, filter);

        // holder null = 无绑定信息：不过滤
        handlers[0]?.(groupMsg());
        expect(sink).toHaveLength(1);

        // kurobot 绑定表：仅群 999 绑定
        filter.current = (peerUin, isGroup) => !isGroup || peerUin === "999";
        sink.length = 0;
        handlers[0]?.(groupMsg()); // 群 100 未绑定 → 不打
        const boundGroup = { ...(groupMsg() as object), peerUin: "999" };
        handlers[0]?.(boundGroup); // 群 999 绑定 → 打
        handlers[0]?.(privateMsg()); // 私聊 → 放行
        expect(sink).toHaveLength(2);
    });
});

describe("消息渲染元素占位（elementToText 全分支）", () => {
    /** 构造独立订阅（自定义 kernel + sink），返回 emit 与 sink。 */
    async function subscribe(
        kernel: KernelLike,
    ): Promise<{ emit: (payload: unknown) => void; sink: unknown[] }> {
        const { setupMsgLogging } = await import("../msg-log.js");
        const sink: unknown[] = [];
        let handler: ((payload: unknown) => void) | undefined;
        const channel: EventChannelLike = {
            on: (_event, h) => {
                handler = h;
                return undefined;
            },
        };
        setupMsgLogging(kernel, channel, stubLogger(sink), false);
        return { emit: (p) => handler?.(p), sink };
    }

    it("at 元素：display 优先 → target=all 全体 → target uid", async () => {
        const kernel = stubKernel();
        const { emit, sink } = await subscribe(kernel);
        emit({
            chatType: 1,
            peerUin: "100",
            senderUin: "200",
            elements: [
                { type: "at", target: "u_1", display: "小明" },
                { type: "at", target: "all" },
                { type: "at", target: "u_2" },
            ],
        });
        const line = sink[0] as string;
        expect(line).toContain("@小明");
        expect(line).toContain("@全体");
        expect(line).toContain("@u_2");
    });

    it("file / forward / 未知类型占位；空渲染兜底 [空消息/媒体]", async () => {
        const { emit, sink } = await subscribe(stubKernel());
        emit({
            chatType: 1,
            peerUin: "100",
            senderUin: "200",
            elements: [
                { type: "file", name: "doc.pdf" },
                { type: "file" },
                { type: "forward" },
                { type: "face", faceId: "5" },
            ],
        });
        const line = sink[0] as string;
        expect(line).toContain("[文件doc.pdf]");
        expect(line).toContain("[文件]");
        expect(line).toContain("[合并转发]");
        expect(line).toContain("[face]");
        // 空消息
        emit({ chatType: 1, peerUin: "100", senderUin: "200", elements: [] });
        expect(sink[1]).toContain("[空消息/媒体]");
    });

    it("内容换行补 4 空格缩进（多行消息不顶格）", async () => {
        const { emit, sink } = await subscribe(stubKernel());
        emit({
            chatType: 1,
            peerUin: "100",
            senderUin: "200",
            elements: [{ type: "text", text: "第一行\n第二行" }],
        });
        expect(sink[0]).toContain("第一行\n    第二行");
    });

    it("senderUin 缺失 → 回退 peerUin；双缺 → 未知", async () => {
        const { emit, sink } = await subscribe(stubKernel());
        emit({ chatType: 2, peerUin: "300", elements: [{ type: "text", text: "a" }] });
        expect(sink[0]).toContain("[用户300]");
        emit({ chatType: 2, elements: [{ type: "text", text: "b" }] });
        expect(sink[1]).toContain("[用户未知]");
    });

    it("toCanonicalElements 抛错（解析失败）→ 记 boot 日志 + logger.warn，不崩", async () => {
        const kernel = {
            [CHAT_TYPE]: { GROUP: 1, C2C: 2 },
            toCanonicalElements: () => {
                throw new Error("元素断言");
            },
        } as unknown as KernelLike;
        const { emit, sink } = await subscribe(kernel);
        expect(() => emit(groupMsg())).not.toThrow();
        expect(sink).toHaveLength(1);
        expect(sink[0]).toContain("解析失败");
        expect(sink[0]).toContain("元素断言");
    });

    it("channel.on 返回非函数 → 退订退化为 no-op（不崩）", async () => {
        const { setupMsgLogging } = await import("../msg-log.js");
        const channel: EventChannelLike = {
            on: () => "不是函数",
        };
        const off = setupMsgLogging(stubKernel(), channel, stubLogger([]), false);
        expect(() => off()).not.toThrow();
    });
});
