/**
 * 出向传输首连容错（issue #144）
 *
 * 背景：`network.WsClient.open()` 的契约是「首连失败即 reject，不自动重试」
 * （重连只覆盖已建立连接后的断线，见 `WsClient.onClose`）。协议装配层若直接
 * `await client.open()`，对端 WS 服务暂时未启动/不可达（ECONNREFUSED、
 * ENOTFOUND host.docker.internal）就会让整个 `startProtocols` 抛错 →
 * `self-host` exit 1，已登录成功的 QQ 宿主被一个外部服务拖死。
 *
 * 本模块在 adapter 层补足容错：首连失败只记 warn，并在后台按指数退避重试，
 * 不阻塞协议装配、不影响宿主运行；`stop()` 时经返回的取消函数清掉定时器。
 * 底层 `WsClient.open()` 失败语义保持不变（network 单测契约不动）。
 *
 * 退避从配置的 `reconnectDelayMs` 起按 2 倍递增并封顶（60s），与 supervisor
 * 的子进程重启退避同一思路；连接建立后的断线仍由 `WsClient` 自己的 reconnect
 * 策略处理，两者不重叠。
 */
import { errorMessage } from "@napuketto/kernel";
import type { TransportAdapter } from "@napuketto/network";
import type { AdapterLoggerLike } from "./log.js";

/** 后台重连延迟上限（毫秒）。 */
const MAX_RETRY_DELAY_MS = 60_000;

/** 首连容错参数。 */
export interface OutboundOpenOptions {
    /** 日志标识（协议名 + 地址，如 `onebot11 正向 WS ws://…`）。 */
    label: string;
    /** 首次重连延迟（毫秒；后续按 2 倍指数退避）。 */
    delayMs: number;
    /** 最大重连次数（不含首连）；缺省无限。 */
    maxAttempts?: number | undefined;
    /** 校准日志（缺省静默）。 */
    logger?: AdapterLoggerLike | undefined;
}

/**
 * 打开出向传输（首连失败不抛出）：失败后 warn + 后台退避重试。
 * @returns 取消函数（`stop()` / 热更新重建传输时调用，清定时器且不再重试）
 */
export function openOutboundWithRetry(
    transport: TransportAdapter,
    opts: OutboundOpenOptions,
): () => void {
    let stopped = false;
    /** 已安排的重试次数（不含首连）。 */
    let attempt = 0;
    let timer: NodeJS.Timeout | undefined;
    const baseDelayMs = Math.max(opts.delayMs, 1);

    const scheduleRetry = (): void => {
        if (stopped) {
            return;
        }
        if (opts.maxAttempts !== undefined && attempt >= opts.maxAttempts) {
            opts.logger?.warn(
                { label: opts.label, attempts: attempt },
                "出向传输仍不可达，已达最大重连次数，停止重试（宿主继续运行）",
            );
            return;
        }
        const delayMs = Math.min(baseDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
        attempt += 1;
        timer = setTimeout(() => {
            timer = undefined;
            void tryOpen();
        }, delayMs);
        // ⚠️ 不能 unref：只配置正向 WS（无 server、heartbeat=0）时，这里是唯一
        // 维持事件循环的句柄；unref 会让进程 code=0 提前退出，再被 supervisor 拉起。
        // 生命周期由 close() / 取消函数 clearTimeout 负责。
    };

    const tryOpen = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        try {
            await transport.open();
        } catch (err) {
            // 取消期间失败的 open：不再告警/排重试（避免 stop 后仍刷日志）
            if (stopped) {
                return;
            }
            opts.logger?.warn(
                { err: errorMessage(err), label: opts.label, retry: attempt + 1 },
                "出向传输连接失败，后台按重连策略重试（不影响宿主运行）",
            );
            scheduleRetry();
            return;
        }
        // 竞态关闭（stopAll / reload 在握手途中取消）：open 可能在取消后才 resolve，
        // 此时这条连接已无人管理——立即关闭，避免留下僵尸 WS 连接。
        if (stopped) {
            try {
                await transport.close();
            } catch (err) {
                // 取消路径的清理失败不阻断 stopAll（记录后由下层 close 再兜底）
                opts.logger?.warn(
                    { err: errorMessage(err), label: opts.label },
                    "取消后关闭出向传输失败",
                );
            }
        }
    };

    void tryOpen();

    return () => {
        stopped = true;
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
}
