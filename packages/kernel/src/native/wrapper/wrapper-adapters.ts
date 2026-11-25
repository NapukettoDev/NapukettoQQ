/**
 * wrapper NAPI 回调适配器实现：exports 里没有 NodeI*Adapter/Listener 构造器，
 * engine.initWithDeskTopConfig / session.init 的 adapter 与 listener 参数一律接受普通 JS 对象
 * ——NAPI 按方法名反射读取回调，因此这些占位类可直接 new 传入。
 */

import type {
    KernelLoginListener,
    NodeIDependsAdapter,
    NodeIDispatcherAdapter,
    NodeIGlobalAdapter,
    NodeIKernelSessionListener,
} from "../../types/index.js";

/** NAPI 回调占位（方法存在即可被反射调用，无副作用）。 */
const noop = (): void => undefined;

/** NodeIGlobalAdapter 实现（engine.initWithDeskTopConfig 第二参）。 */
export class GlobalAdapter implements NodeIGlobalAdapter {
    onLog = noop;
    onGetSrvCalTime = noop;
    onShowErrUITips = noop;
    fixPicImgType = noop;
    getAppSetting = noop;
    onInstallFinished = noop;
    onUpdateGeneralFlag = noop;
    onGetOfflineMsg = noop;
}

/** NodeIDependsAdapter 实现（session.init 第二参）。 */
export class DependsAdapter implements NodeIDependsAdapter {
    onMSFStatusChange = noop;
    onMSFSsoError = noop;
    getGroupCode = noop;
}

/** NodeIDispatcherAdapter 实现（session.init 第三参）。 */
export class DispatcherAdapter implements NodeIDispatcherAdapter {
    dispatchRequest = noop;
    dispatchCall = noop;
    dispatchCallWithJson = noop;
}

/** 会话监听器选项。 */
export interface SessionListenerOptions {
    /** 事件日志回调（默认静默——boot 阶段事件对用户是噪音；调试时可传回调观察）。 */
    onEvent?: ((name: string, ...args: unknown[]) => void) | undefined;
}

/**
 * 创建会话监听器（默认静默，boot 阶段默认；login 模块接入后可覆盖）。
 * 回调方法必须存在（NAPI 按方法名反射），但输出与否由调用方决定——
 * onNTSessionCreate / onOpentelemetryInit 等对用户无信息量，默认不打 stdout。
 */
export function createSessionListener(
    opts: SessionListenerOptions = {},
): NodeIKernelSessionListener {
    const { onEvent } = opts;
    const emit = (name: string, ...args: unknown[]): void => {
        onEvent?.(name, ...args);
    };
    return {
        onNTSessionCreate: (sessionId) => emit("onNTSessionCreate", sessionId),
        onGProSessionCreate: (sessionId) => emit("onGProSessionCreate", sessionId),
        onSessionInitComplete: (sessionId) => emit("onSessionInitComplete", sessionId),
        onOpentelemetryInit: (info) => emit("onOpentelemetryInit", info),
        onUserOnlineResult: (result) => emit("onUserOnlineResult", result),
        onGetSelfTinyId: (result) => emit("onGetSelfTinyId", result),
    };
}

/** 创建登录监听器（占位，登录器接入时填充）。 */
export function createLoginListener(): KernelLoginListener {
    return {};
}
