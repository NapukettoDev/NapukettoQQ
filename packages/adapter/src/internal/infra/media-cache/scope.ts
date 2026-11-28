/** 同进程内的缓存互斥、引用计数与动作作用域。 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Scope } from "./schema.js";

// 同一进程内，配置相同根目录的协议实例共享互斥锁；定时器由各实例持有。
const locks = new Map<string, Promise<void>>();
const active = new Map<string, number>();
export const scopes = new AsyncLocalStorage<Scope>();

export async function locked<T>(root: string, task: () => Promise<T>): Promise<T> {
    const prior = locks.get(root) ?? Promise.resolve();
    let release = (): void => undefined;
    const next = new Promise<void>((done) => {
        release = done;
    });
    locks.set(root, next);
    await prior;
    try {
        return await task();
    } finally {
        release();
        if (locks.get(root) === next) locks.delete(root);
    }
}

export function pin(dir: string): void {
    active.set(dir, (active.get(dir) ?? 0) + 1);
}
export function unpin(dir: string): void {
    const count = active.get(dir) ?? 0;
    if (count <= 1) active.delete(dir);
    else active.set(dir, count - 1);
}

export function isPinned(dir: string): boolean {
    return active.has(dir);
}
