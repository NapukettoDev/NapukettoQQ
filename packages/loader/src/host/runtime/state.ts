/**
 * state.ts：引导进程共享状态（self-host.ts 入口创建，各拆分模块读写）。
 *
 * 分层：`host/runtime/` 是子进程共享基础层；本文件只有类型与纯函数，0 import。
 */

/**
 * 逐条处理消息回调参数（onRecvMsg 为消息数组——2026-08-07 运行时实证；
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

/** 共享状态（self-host.ts 入口创建，各拆分模块读写）。
 *  - wrapperExports：dlopen 截获的 wrapper.node exports
 *  - qqSession / qqLoginService：Proxy 捕获的 QQ 实例（V1 路线）
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
