/**
 * state.ts：引导进程共享状态（self-host.ts 入口创建，各模块读写）。
 * 只有类型与纯函数，0 import。
 */

/**
 * 逐条处理消息回调参数（onRecvMsg 实际传的是消息数组，不是单条；
 * 兼容单条对象，过滤无效项）。
 */
export function forEachRawMessage(msgs: unknown, handler: (msg: unknown) => void): void {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    for (const msg of list) {
        if (!msg || typeof msg !== "object") {
            continue;
        }
        handler(msg);
    }
}

/** 共享状态（self-host.ts 入口创建，各模块读写）。
 *  - wrapperExports：dlopen 截获的 wrapper.node exports
 *  - qqSession / qqLoginService：Proxy 捕获的 QQ 实例
 *  - bootstrapped：kernel 引导是否已启动（防重入） */
export interface SharedState {
    wrapperExports: Record<string, unknown> | null;
    qqSession: unknown;
    qqLoginService: unknown;
    bootstrapped: boolean;
}

export function createState(): SharedState {
    return {
        wrapperExports: null,
        qqSession: null,
        qqLoginService: null,
        bootstrapped: false,
    };
}
