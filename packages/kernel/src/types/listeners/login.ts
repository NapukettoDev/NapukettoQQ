/**
 * 登录状态监听转发面（LoginBridge 通道类型，2026-11-01 批次三）
 *
 * ⚠️ 参数形状零样本（三轮录制无下线操作）——...args unknown 透传，订阅方
 * 防御性收窄 + 校准日志。原生完整回调面见 types/wrapper.ts IKernelLoginListener
 * （二进制字符串提取产物）；本类型只收 bot_offline 候选的两个回调。
 * 用 type 别名（非 interface）：需满足 ListenerShape（Record<string, unknown>）
 * 约束；方法必须必选（optional 会破坏事件通道的 Extract 推导）。
 */
export type LoginListener = {
    /** 连接断开（bot_offline 候选源；被踢/掉线语义待野捕校准）。 */
    onLoginDisConnected: (...args: unknown[]) => void;
    /** 登出成功（主动登出路径）。 */
    onLogoutSucceed: (...args: unknown[]) => void;
};
