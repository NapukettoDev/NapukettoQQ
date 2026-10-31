/**
 * listener 录制器测试：Proxy 万能监听器陷阱行为 + startListenerRecording 注册
 * 与 JSONL 落盘。mock ctx / service，不依赖真实 wrapper。
 *
 * 锁定：<get>（按名查找记录）/ has 恒真 / ownKeys 空列表 / Symbol 放行 /
 * 入参截断序列化；注册摘要（ok / null / 无 add 方法）与 <registered> 行。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../wrapper-loader.js";
import {
    createRecordingListener,
    type ListenerRecordEvent,
    startListenerRecording,
} from "./probe-listener.js";

describe("createRecordingListener（万能监听器）", () => {
    function make(): { listener: object; events: ListenerRecordEvent[] } {
        const events: ListenerRecordEvent[] = [];
        return { listener: createRecordingListener("Msg", (r) => events.push(r)), events };
    }

    it("get 陷阱：按名查找记录 <get>，调用记录回调名 + 序列化入参", () => {
        const { listener, events } = make();
        const fn = (listener as Record<string, unknown>)["onRecvMsg"] as (...a: unknown[]) => void;
        fn({ msgId: "m1" }, 2n);
        expect(events.map((e) => e.event)).toEqual(["<get>", "onRecvMsg"]);
        expect(events[0]?.service).toBe("Msg");
        expect(events[1]?.args).toEqual([{ msgId: "m1" }, "2"]);
    });

    it("has 陷阱恒真并记录；ownKeys 记录且返回空（枚举发现行为的判据）", () => {
        const { listener, events } = make();
        expect("onRecvMsg" in listener).toBe(true);
        expect(Object.keys(listener)).toEqual([]);
        expect(events.map((e) => e.event)).toEqual(["<has>", "<ownKeys>"]);
        expect(events[0]?.args).toEqual(["onRecvMsg"]);
    });

    it("Symbol 键放行默认行为，不记录", () => {
        const { listener, events } = make();
        const sym = Symbol("x");
        expect((listener as Record<symbol, unknown>)[sym]).toBeUndefined();
        expect(events).toEqual([]);
    });
});

describe("startListenerRecording（注册 + JSONL 落盘）", () => {
    let dir: string;
    const savedCfgDir = process.env["NAPUTO_CFG_DIR"];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-lr-"));
        process.env["NAPUTO_CFG_DIR"] = dir;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (savedCfgDir === undefined) {
            delete process.env["NAPUTO_CFG_DIR"];
        } else {
            process.env["NAPUTO_CFG_DIR"] = savedCfgDir;
        }
    });

    /** 组装 mock ctx（session 两服务 + exports LoginService），返回 add 捕获器。 */
    function makeCtx(): { ctx: WrapperContext; captured: unknown[] } {
        const captured: unknown[] = [];
        const msgService = {
            addKernelMsgListener: vi.fn((listener: unknown) => {
                captured.push(listener);
                return 42;
            }),
            removeKernelMsgListener: vi.fn(),
        };
        // exports 键是 wrapper 导出名（PascalCase 事实接口），经 Record 装配规避命名规则
        const exports: Record<string, unknown> = {};
        exports["NodeIKernelLoginService"] = {
            get: () => ({ addKernelLoginListener: () => 7 }),
        };
        const ctx = {
            session: {
                getMsgService: () => msgService,
                getGroupService: () => null,
                getRecentContactService: {}, // 无 add*Listener 方法
            },
            exports,
        } as unknown as WrapperContext;
        return { ctx, captured };
    }

    function readLines(file: string): ListenerRecordEvent[] {
        return readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as ListenerRecordEvent);
    }

    it("逐服务注册：ok / null / 无 add 方法；<registered> 落盘含 listenerId", () => {
        const { ctx } = makeCtx();
        const res = startListenerRecording(ctx);
        expect(res.file).toBe(join(dir, "napuketto-listener-record.jsonl"));
        expect(res.registered["Msg"]).toEqual({ ok: true, listenerId: 42 });
        expect(res.registered["Group"]).toEqual({ ok: false, error: "null/undefined" });
        expect(res.registered["RecentContact"]).toMatchObject({ ok: false });
        expect(res.registered["Login"]).toEqual({ ok: true, listenerId: 7 });
        // mock session 未提供其余仪器面 getter → 逐个记录缺失原因
        expect(res.registered["BdhUpload"]).toMatchObject({ ok: false });

        const lines = readLines(res.file);
        const registered = lines.find((l) => l.service === "Msg" && l.event === "<registered>");
        expect(registered?.args[0]).toMatchObject({
            addMethod: "addKernelMsgListener",
            listenerId: 42,
        });
    });

    it("挂上的万能监听器回调逐行落盘（含参数序列化）", () => {
        const { ctx, captured } = makeCtx();
        const res = startListenerRecording(ctx);
        const listener = captured[0] as Record<string, ((...a: unknown[]) => void) | undefined>;
        listener["onRecvMsg"]?.({ msgId: "m1" });
        const lines = readLines(res.file);
        const hit = lines.find((l) => l.service === "Msg" && l.event === "onRecvMsg");
        expect(hit?.args).toEqual([{ msgId: "m1" }]);
    });

    it("session null：服务面跳过，Login 仍尝试", () => {
        const { ctx } = makeCtx();
        (ctx as { session: unknown }).session = null;
        const res = startListenerRecording(ctx);
        expect(Object.keys(res.registered)).toEqual(["Login"]);
        expect(res.registered["Login"]).toEqual({ ok: true, listenerId: 7 });
    });

    it("LoginService.get 缺失：记录原因不抛", () => {
        const { ctx } = makeCtx();
        (ctx.exports as unknown as Record<string, unknown>)["NodeIKernelLoginService"] = {};
        const res = startListenerRecording(ctx);
        expect(res.registered["Login"]).toMatchObject({ ok: false });
    });
});
