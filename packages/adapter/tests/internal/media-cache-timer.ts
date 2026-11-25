import { expect, vi } from "vitest";

/** Observe a real Node timer through the protocol lifecycle, without advancing fake I/O clocks. */
export async function expectCacheTimerReleased(
    start: () => Promise<void>,
    stop: () => Promise<void> | void,
): Promise<void> {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    try {
        await start();
        const index = intervals.mock.calls.findIndex((call) => call[1] === 60_000);
        expect(index).toBeGreaterThanOrEqual(0);
        const timer = intervals.mock.results[index]?.value as NodeJS.Timeout;
        expect(timer.hasRef()).toBe(false);
        await stop();
        expect(cleared).toHaveBeenCalledWith(timer);
    } finally {
        await stop();
        intervals.mockRestore();
        cleared.mockRestore();
    }
}
