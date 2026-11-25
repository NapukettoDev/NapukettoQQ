/**
 * 等待/延迟工具（通用底层原语，无业务依赖）。
 * login / cache 等上层模块经 `infra/index.js` 复用，杜绝 cache → login 的跨领域依赖。
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

/**
 * 底层 NAPI promise 超时竞速：promise 先 settle 用其结果，超时先到用
 * onTimeout 产物（可抛错 → 整体 reject）。底层 promise 无法取消，超时后
 * 悬挂丢弃——勿做清理动作引发二次问题；败者的迟到 settle 由 race 吞掉。
 */
export function raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => T,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
            try {
                resolve(onTimeout());
            } catch (err) {
                reject(err);
            }
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== null) {
            clearTimeout(timer);
        }
    });
}
