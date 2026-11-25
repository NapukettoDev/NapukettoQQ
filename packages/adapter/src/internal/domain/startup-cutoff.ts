/**
 * 启动 / 重连的历史积压基准（issue #122，四协议共用）
 *
 * QQNT 在登录、重连或审批回调后会把历史消息与旧好友申请全量重放一遍；收链路只应报
 * 订阅之后产生的「实时」数据，否则下游会误回复几天前的消息、或对旧申请再次自动同意
 * （进而触发下一次全量重放，成死循环）。
 *
 * 基准取「订阅时刻 − 容差」：握手期间到达的实时数据带着略早于订阅时刻的时间戳，容差
 * 保证它们不被错杀。时间戳缺失 / 非法（`toUnixSeconds` 归一为 0）时调用方放行——
 * 宁可多报不可错杀。
 *
 * 时间戳是服务端时间、基准是宿主时钟，容差同时吸收两者的同步偏差。它只影响启动瞬间
 * 的那一批数据，稳态不受影响；宿主时钟明显快于服务器时可能误杀实时消息，属已知取舍
 * （拦截条数以 debug 留痕，便于现场诊断）。
 */
import { MS_TO_SEC } from "./uid-uin.js";

/** 启动 / 重连容差（秒）：握手期间到达的实时数据不算历史积压。 */
export const STARTUP_GRACE_SEC = 5;

/** 订阅基准时刻（Unix 秒）：早于它的消息 / 申请视为启动前历史积压。 */
export function startupBaselineSec(graceSec: number = STARTUP_GRACE_SEC): number {
    return Math.floor(Date.now() / MS_TO_SEC) - graceSec;
}
