/**
 * 带过期去重键缓存（Milky 批次三）
 *
 * 两个场景共用：friend_file_upload 双回调（onRecvOfflineFileMsg / onFileMsgCome
 * 同载荷，按 msgId 去重）与 group_essence_message_change 双路径（732:1 快路径
 * vs 列表 diff，按 群:seq:方向 去重）。claim 语义 = 未登记过（或已过期）则登记
 * 并返回 true——调用方据此决定是否广播。
 */
export class RecentKeyCache {
    private readonly entries = new Map<string, number>();
    private readonly ttlMs: number;

    constructor(ttlMs: number) {
        this.ttlMs = ttlMs;
    }

    /** 未命中则登记并返回 true（应广播）；命中（窗口内重复）返回 false。 */
    claim(key: string, now = Date.now()): boolean {
        this.prune(now);
        const expiry = this.entries.get(key);
        if (expiry !== undefined && expiry > now) {
            return false;
        }
        this.entries.set(key, now + this.ttlMs);
        return true;
    }

    /** 惰性清理过期键（每次 claim 顺带执行，量级小无需定时器）。 */
    private prune(now: number): void {
        for (const [key, expiry] of this.entries) {
            if (expiry <= now) {
                this.entries.delete(key);
            }
        }
    }
}
