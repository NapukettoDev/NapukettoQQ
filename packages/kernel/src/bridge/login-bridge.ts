/**
 * LoginBridge：登录状态事件桥（2026-11-01，Milky 批次三 bot_offline 候选源）
 *
 * 职责：把 login service 的原生回调（onLoginDisConnected / onLogoutSucceed）
 * 推入类型化事件通道 `NTEventChannel<LoginListener, "Login">`。与
 * QrLoginSession 并存——多监听各自独立 id（录制器实测同服务可多挂）。
 *
 * ⚠️ 与其他桥的差异：login service 不在 session 上（登录先于 session init），
 * 由装配方注入 `ctx.wrapper.loginService`（wrapper-loader 拦截 new 捕获 /
 * 单例 get() 兜底的既有实例，与 QrLoginSession 同源，见 core.ts loginByQr）。
 *
 * 方法名证据：wrapper.node 二进制字符串提取（types/wrapper.ts
 * IKernelLoginListener）；⚠️ 参数形状零样本（三轮录制无下线操作）——透传
 * unknown，订阅方防御性收窄 + 校准日志。
 *
 * 用法：
 *   const channel = new NTEventChannel<IKernelLoginListener, "Login">("Login");
 *   const bridge = new LoginBridge(loginService, channel);
 *   bridge.register();
 *   bridge.unregister();
 */

import type { NTEventChannel } from "../event-channel.js";
import { kernelError } from "../infra/index.js";
import type { LoginListener } from "../types/index.js";

/** 登录事件通道的固定类型（事件名前缀 "Login"）。 */
export type LoginEventChannel = NTEventChannel<LoginListener, "Login">;

/**
 * 登录事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程一份。
 */
export class LoginBridge {
    private readonly service: unknown;
    private readonly channel: LoginEventChannel;
    private listenerId: number | null = null;

    constructor(loginService: unknown, channel: LoginEventChannel) {
        if (
            loginService === null ||
            loginService === undefined ||
            typeof (loginService as { addKernelLoginListener?: unknown }).addKernelLoginListener !==
                "function"
        ) {
            throw kernelError("loginService 无效（缺 addKernelLoginListener）", "INVALID_STATE");
        }
        this.service = loginService;
        this.channel = channel;
    }

    /** 注册原生监听（幂等）。 */
    register(): void {
        if (this.listenerId !== null) {
            return;
        }
        // listener 为普通 JS 对象（NAPI 反射读取方法回调）
        const listener: LoginListener = {
            onLoginDisConnected: (...args) =>
                this.channel.emit("Login/onLoginDisConnected", ...args),
            onLogoutSucceed: (...args) => this.channel.emit("Login/onLogoutSucceed", ...args),
        };
        this.listenerId = (
            this.service as { addKernelLoginListener(listener: unknown): number }
        ).addKernelLoginListener(listener);
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        if (this.listenerId === null) {
            return;
        }
        (
            this.service as { removeKernelLoginListener(listenerId: number): void }
        ).removeKernelLoginListener(this.listenerId);
        this.listenerId = null;
    }
}
