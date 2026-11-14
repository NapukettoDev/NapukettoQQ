/**
 * 列表查找共享骨架（milky api.ts 与 satori action 的通知/申请查找收拢，
 * 2026-11-14）
 *
 * 「依序拉取候选列表 → 谓词取首个命中」的公共循环；错误语义（未命中的抛错
 * 类型与消息）归调用方——milky 走 kernelError(NOT_FOUND)，satori 沿用动作层
 * 纯 Error，各自保持协议响应口径。
 */

/**
 * 依序拉取候选列表并按谓词取首个命中；全部列表无命中返回 undefined。
 * 列表惰性拉取（前一屏命中则不拉后续屏——群通知先非可疑后可疑的规范序）。
 */
export async function findFirstMatch<T>(
    fetchers: readonly (() => Promise<T[]>)[],
    match: (item: T) => boolean,
): Promise<T | undefined> {
    for (const fetch of fetchers) {
        const hit = (await fetch()).find(match);
        if (hit !== undefined) {
            return hit;
        }
    }
    return undefined;
}
