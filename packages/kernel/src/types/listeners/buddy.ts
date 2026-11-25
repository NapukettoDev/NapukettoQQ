/**
 * BuddyListener：BuddyService 的原生回调监听类型。方法名证据：wrapper.node（9.9.33-52230）
 * 二进制字符串提取（`grep -aoE "onBuddy[A-Za-z0-9]+"`），与 Group/Msg listener 同源验证；
 * ⚠️ 回调参数形状未经真实事件校准，一律 unknown 透传、订阅方自行防御性收窄。
 */

/** 好友服务（BuddyService）的原生回调监听接口。
 * 用 type 别名（非 interface）：需满足 ListenerShape（Record<string, unknown>）
 * 约束——interface 无隐式索引签名不兼容；type 对象类型天然满足。 */
export type BuddyListener = {
    /** 好友申请列表变化（好友请求事件源；参数形状待真实事件校准）。 */
    onBuddyReqChange: (arg: unknown) => void;
    /** 好友列表变化（参数形状待真实事件校准）。 */
    onBuddyListChange: (arg: unknown) => void;
    /** 好友列表变化 V2（参数形状待真实事件校准）。 */
    onBuddyListChangedV2: (arg: unknown) => void;
    /** 好友被删除（参数形状待真实事件校准）。 */
    onBuddyDeleted: (arg: unknown) => void;
};
