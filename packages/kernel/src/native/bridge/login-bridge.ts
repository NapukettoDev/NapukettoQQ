/**
 * LoginBridge：把 login service 的原生回调（onLoginDisConnected / onLogoutSucceed）推入
 * `NTEventChannel<LoginListener, "Login">`；⚠️ login service 不在 session 上（登录先于 session init），
 * 由装配方注入 loginService；方法名来自二进制字符串提取，参数形状零样本——透传 unknown。
 */

import type { NTEventChannel } from "../../infra/event-channel.js";
import { kernelError } from "../../infra/index.js";
import { hasCallableProp } from "../../infra/type-guards.js";
import type { LoginListener } from "../../types/index.js";

/** 登录事件通道的固定类型（事件名前缀 "Login"）。 */
export type LoginEventChannel = NTEventChannel<LoginListener, "Login">;

/** LoginBridge 依赖的 loginService 方法面（remove 可选，老版本可能缺）。 */
interface BoundLoginService {
    addKernelLoginListener(listener: unknown): number;
    removeKernelLoginListener?(listenerId: number): void;
}

/** 运行时判定 loginService 是否具备监听注册方法面。 */
function isBoundLoginService(val: unknown): val is BoundLoginService {
    return hasCallableProp(val, "addKernelLoginListener");
}

/**
 * 登录事件桥：注册原生监听 → 回调 emit 到 channel。
 * 无全局单例（ADR-015 推论）——每进程一份。
 */
export class LoginBridge {
    private readonly boundService: BoundLoginService;
    private readonly channel: LoginEventChannel;
    private listenerId: number | null = null;

    constructor(loginService: unknown, channel: LoginEventChannel) {
        if (!isBoundLoginService(loginService)) {
            throw kernelError("loginService 无效（缺 addKernelLoginListener）", "INVALID_STATE");
        }
        this.boundService = loginService;
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
        this.listenerId = this.boundService.addKernelLoginListener(listener);
    }

    /** 注销原生监听（幂等）。 */
    unregister(): void {
        if (this.listenerId === null) {
            return;
        }
        this.boundService.removeKernelLoginListener?.(this.listenerId);
        this.listenerId = null;
    }

    /** 释放（等价 unregister，幂等）。 */
    dispose(): void {
        this.unregister();
    }

    /** `using bridge = ...` 自动释放。 */
    [Symbol.dispose](): void {
        this.unregister();
    }
}
