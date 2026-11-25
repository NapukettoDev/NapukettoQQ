/** runtime/cache 聚合出口（ADR-008）：群/成员缓存、好友缓存、群精华列表缓存与串行 diff（ADR-028）。 */

export type {
    BuddyCacheEventChannel,
    BuddyCacheListener,
    BuddyCacheOptions,
} from "./buddy-cache.js";
export { BuddyCache, narrowBuddyCategories } from "./buddy-cache.js";
export type {
    EssenceAddedItem,
    EssenceCacheEntry,
    EssenceDiffResult,
    EssenceListSyncDeps,
} from "./essence-cache.js";
export { diffEssenceList, EssenceListSync, narrowEssenceGroupArg } from "./essence-cache.js";
export type { GroupCacheOptions } from "./group-cache.js";
export { GroupCache } from "./group-cache.js";
