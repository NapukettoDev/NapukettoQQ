/**
 * apis 测试公共设施：桩 session 构造（getter → 桩 service），不依赖真实 wrapper。
 * 各 API 的 service 方法面差异大，service 对象由各测试文件自带；
 * 本文件只收敛「getter 名 → service」的 session 包装与常用断言辅助。
 */
import type { NodeIQQNTWrapperSession } from "../types/index.js";

/** 构造桩 session：getters 的键为 service getter 名（getMsgService 等）。 */
export function makeSession(getters: Record<string, unknown>): NodeIQQNTWrapperSession {
    return getters as unknown as NodeIQQNTWrapperSession;
}
