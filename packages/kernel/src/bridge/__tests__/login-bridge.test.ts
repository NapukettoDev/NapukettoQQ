/**
 * login-bridge.ts 单测：注册/注销/事件透传。
 *
 * 覆盖目标：LoginBridge 与 session 桥的差异点——loginService 由装配方注入
 * （不在 session 上），构造期校验（null/undefined/缺 addKernelLoginListener
 * 均抛 INVALID_STATE）、回调变参透传（参数形状零样本，...args 透传）、
 * register/unregister 幂等。
 */
import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import type { LoginListener } from "../../types/index.js";
import { LoginBridge } from "../login-bridge.js";
import { makeCapturedService } from "./test-support.js";

/** 构造 LoginBridge + 桩 loginService/channel。 */
function makeBridge() {
    const channel = new NTEventChannel<LoginListener, "Login">("Login");
    const { service, listener } = makeCapturedService<LoginListener>(
        "addKernelLoginListener",
        "removeKernelLoginListener",
    );
    const bridge = new LoginBridge(service, channel);
    return { bridge, channel, service, listener };
}

describe("LoginBridge", () => {
    it("loginService 为 null 抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<LoginListener, "Login">("Login");
        expect(() => {
            new LoginBridge(null, channel);
        }).toThrow(/loginService 无效/);
    });

    it("loginService 为 undefined 抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<LoginListener, "Login">("Login");
        expect(() => {
            new LoginBridge(undefined, channel);
        }).toThrow(/loginService 无效/);
    });

    it("loginService 缺 addKernelLoginListener 方法抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<LoginListener, "Login">("Login");
        expect(() => {
            new LoginBridge({ nope: 1 }, channel);
        }).toThrow(/loginService 无效/);
    });

    it("addKernelLoginListener 非函数（非 function 属性）抛 INVALID_STATE", () => {
        const channel = new NTEventChannel<LoginListener, "Login">("Login");
        expect(() => {
            new LoginBridge({ addKernelLoginListener: 3 }, channel);
        }).toThrow(/loginService 无效/);
    });

    it("register 注册原生监听且幂等", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.register();
        expect(service["addKernelLoginListener"]).toHaveBeenCalledTimes(1);
    });

    it("unregister 注销且幂等", () => {
        const { bridge, service } = makeBridge();
        bridge.register();
        bridge.unregister();
        bridge.unregister();
        expect(service["removeKernelLoginListener"]).toHaveBeenCalledTimes(1);
        expect(service["removeKernelLoginListener"]).toHaveBeenCalledWith(42);
    });

    it("未 register 直接 unregister 不产生注销调用", () => {
        const { bridge, service } = makeBridge();
        bridge.unregister();
        expect(service["removeKernelLoginListener"]).not.toHaveBeenCalled();
    });

    it("onLoginDisConnected → Login/onLoginDisConnected（多参透传）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Login/onLoginDisConnected", handler);
        bridge.register();
        // 参数形状零样本：变参透传，订阅方防御性收窄
        listener()?.onLoginDisConnected(1, "reason", { extra: true });
        expect(handler).toHaveBeenCalledWith(1, "reason", { extra: true });
    });

    it("onLoginDisConnected 零参也透传（空数组）", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Login/onLoginDisConnected", handler);
        bridge.register();
        listener()?.onLoginDisConnected();
        expect(handler).toHaveBeenCalledWith();
    });

    it("onLogoutSucceed → Login/onLogoutSucceed", () => {
        const { bridge, channel, listener } = makeBridge();
        const handler = vi.fn();
        channel.on("Login/onLogoutSucceed", handler);
        bridge.register();
        listener()?.onLogoutSucceed({ uin: "1" });
        expect(handler).toHaveBeenCalledWith({ uin: "1" });
    });
});
