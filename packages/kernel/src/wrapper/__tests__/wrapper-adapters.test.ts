/**
 * wrapper-adapters.ts 测试：NAPI 回调占位与监听器工厂（普通 JS 对象，反射面契约）：
 *  - GlobalAdapter / DependsAdapter / DispatcherAdapter：方法面齐备（NAPI 按名反射）
 *  - createSessionListener：默认静默 / onEvent 注入回调 / 方法名集合
 *  - createLoginListener：返回空对象占位
 */
import { describe, expect, it, vi } from "vitest";
import {
    createLoginListener,
    createSessionListener,
    DependsAdapter,
    DispatcherAdapter,
    GlobalAdapter,
} from "../wrapper-adapters.js";

describe("adapter 占位", () => {
    it("GlobalAdapter 方法面齐备且可调用（无副作用）", () => {
        const adapter = new GlobalAdapter();
        expect(adapter.onLog).toBeTypeOf("function");
        expect(adapter.onGetSrvCalTime).toBeTypeOf("function");
        expect(adapter.onShowErrUITips).toBeTypeOf("function");
        expect(adapter.fixPicImgType).toBeTypeOf("function");
        expect(adapter.getAppSetting).toBeTypeOf("function");
        expect(adapter.onInstallFinished).toBeTypeOf("function");
        expect(adapter.onUpdateGeneralFlag).toBeTypeOf("function");
        expect(adapter.onGetOfflineMsg).toBeTypeOf("function");
        expect(adapter.onLog()).toBeUndefined();
        expect(adapter.getAppSetting()).toBeUndefined();
    });

    it("DependsAdapter 方法面齐备", () => {
        const adapter = new DependsAdapter();
        expect(adapter.onMSFStatusChange).toBeTypeOf("function");
        expect(adapter.onMSFSsoError).toBeTypeOf("function");
        expect(adapter.getGroupCode).toBeTypeOf("function");
        expect(adapter.onMSFStatusChange()).toBeUndefined();
    });

    it("DispatcherAdapter 方法面齐备", () => {
        const adapter = new DispatcherAdapter();
        expect(adapter.dispatchRequest).toBeTypeOf("function");
        expect(adapter.dispatchCall).toBeTypeOf("function");
        expect(adapter.dispatchCallWithJson).toBeTypeOf("function");
        expect(adapter.dispatchCall()).toBeUndefined();
    });
});

describe("createSessionListener", () => {
    it("默认静默（onEvent 缺省不输出）", () => {
        const listener = createSessionListener();
        expect(listener.onNTSessionCreate).toBeTypeOf("function");
        expect(listener.onGProSessionCreate).toBeTypeOf("function");
        expect(listener.onSessionInitComplete).toBeTypeOf("function");
        expect(listener.onOpentelemetryInit).toBeTypeOf("function");
        expect(listener.onUserOnlineResult).toBeTypeOf("function");
        expect(listener.onGetSelfTinyId).toBeTypeOf("function");
        expect(() => listener.onSessionInitComplete?.(0)).not.toThrow();
        expect(() =>
            listener.onOpentelemetryInit?.({ is_init: true, is_report: false }),
        ).not.toThrow();
    });

    it("onEvent 注入：事件名与参数透传", () => {
        const onEvent = vi.fn();
        const listener = createSessionListener({ onEvent });
        listener.onNTSessionCreate?.("s-1");
        listener.onGProSessionCreate?.("gpro-1");
        listener.onSessionInitComplete?.(0);
        listener.onOpentelemetryInit?.({ is_init: false, is_report: false });
        listener.onUserOnlineResult?.({ ok: true });
        listener.onGetSelfTinyId?.({ id: "t" });
        expect(onEvent.mock.calls.map((c) => c[0])).toEqual([
            "onNTSessionCreate",
            "onGProSessionCreate",
            "onSessionInitComplete",
            "onOpentelemetryInit",
            "onUserOnlineResult",
            "onGetSelfTinyId",
        ]);
        expect(onEvent).toHaveBeenNthCalledWith(1, "onNTSessionCreate", "s-1");
    });
});

describe("createLoginListener", () => {
    it("返回空对象占位（登录器接入时填充）", () => {
        const listener = createLoginListener();
        expect(listener).toEqual({});
        expect(Object.keys(listener)).toHaveLength(0);
    });
});
