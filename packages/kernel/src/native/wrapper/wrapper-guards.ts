/**
 * wrapper 原生反射层专属类型守卫：wrapper.node 通过 NAPI 暴露 C++ 包装实例，方法可能挂在原型链、
 * 实例自身甚至构造器函数上，形状随 QQ 版本漂移，本模块把「探测 → 收窄」集中到一处。守卫只验证
 * **调用点真正依赖的方法面**——完整方法面探测属于 probe 子系统，装配不因可选方法缺失而拒绝实例。
 */

import {
    getOwnProp,
    hasCallableProp,
    hasMethodSurface,
    isRecord,
} from "../../infra/type-guards.js";
import type {
    NodeIKernelLoginService,
    NodeIQQNTStartupSessionWrapper,
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperSession,
    WrapperNodeApi,
} from "../../types/wrapper.js";

/** wrapper.node 顶层导出至少含一个已知符号（dlopen 后立即校验，细节由下游守卫补足）。 */
export function isWrapperNodeApi(val: unknown): val is WrapperNodeApi {
    if (!isRecord(val)) {
        return false;
    }
    return (
        "NodeIQQNTWrapperSession" in val ||
        "NodeIQQNTWrapperEngine" in val ||
        "NodeIKernelLoginService" in val ||
        "NodeQQNTWrapperUtil" in val
    );
}

/** engine 实例最小可用面：`initWithDeskTopConfig`（`readyToShow` 为可选增强）。 */
export function isWrapperEngine(val: unknown): val is NodeIQQNTWrapperEngine {
    return hasMethodSurface(val, ["initWithDeskTopConfig"]);
}

/** StartupSessionWrapper 实例可用面：`start()`。 */
export function isStartupSessionWrapper(val: unknown): val is NodeIQQNTStartupSessionWrapper {
    return hasCallableProp(val, "start");
}

/** session 实例最小可用面：`getMsgService()`（service 挂载即 session 可用）。 */
export function isWrapperSession(val: unknown): val is NodeIQQNTWrapperSession {
    return hasCallableProp(val, "getMsgService");
}

/** LoginService 完整方法面（探测/诊断用；装配层允许老版本缺可选方法）。 */
export function isKernelLoginService(val: unknown): val is NodeIKernelLoginService {
    return hasMethodSurface(val, ["addKernelLoginListener", "getLoginList", "getQRCodePicture"]);
}

/** Electron 进程类型（Node 的 process 类型无此字段；"browser" / "utility"。 */
export function getElectronProcessType(proc: unknown): string | undefined {
    const t = getOwnProp(proc, "type");
    return typeof t === "string" ? t : undefined;
}
