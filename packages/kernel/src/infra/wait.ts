/**
 * 等待/延迟工具（通用底层原语，2026-08-08 克隆合并；2026-11 下沉至 infra）
 *
 * 纯 promise 工具，无任何业务依赖——login / cache 等上层模块经
 * `infra/index.js` 复用，杜绝 cache -> login 的跨领域依赖。
 */

/** 等待条件满足（轮询，带超时）。 */
export function waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs = 500,
): Promise<boolean> {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = (): void => {
            if (predicate()) {
                resolve(true);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                resolve(false);
                return;
            }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

/** 短延迟。 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
