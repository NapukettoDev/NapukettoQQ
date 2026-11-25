/**
 * runtime/ 公共出口（L3 有状态运行时与内核装配）
 *
 * 全仓唯一可以同时依赖 L0/L1/L2 的层：登录状态机、缓存、装配上下文与内核门面。
 * 子域：login（登录生命周期 + 扫码）/ cache（群成员/好友/精华缓存）/
 * core（NapukettoCore）/ context（CoreContext）/ lifecycle（业务服务装配）。
 *
 * 禁 `export *`（biome performance/noReExportAll）。
 */

// ---- cache ----
export type {
    BuddyCacheEventChannel,
    BuddyCacheListener,
    BuddyCacheOptions,
    EssenceAddedItem,
    EssenceCacheEntry,
    EssenceDiffResult,
    EssenceListSyncDeps,
    GroupCacheOptions,
} from "./cache/index.js";
export {
    BuddyCache,
    diffEssenceList,
    EssenceListSync,
    GroupCache,
    narrowBuddyCategories,
    narrowEssenceGroupArg,
} from "./cache/index.js";
// ---- context ----
export type { CoreContext, CoreContextOptions } from "./context.js";
export { createCoreContext } from "./context.js";
// ---- core ----
export type { CoreLoginOptions, LoginProgress, NapukettoCoreOptions } from "./core.js";
export { NapukettoCore } from "./core.js";
// ---- lifecycle（原 src/runtime.ts）----
export type { KernelRuntime, KernelRuntimeOptions } from "./lifecycle.js";
export { createKernelRuntime } from "./lifecycle.js";
// ---- login ----
export type {
    LoginAccountInfo,
    LoginListItem,
    LoginResult,
    LoginState,
    QrCodeData,
    QuickLoginOptions,
    SelfInfo,
} from "./login/index.js";
export {
    initAndStartSession,
    listLoginAccounts,
    QrLoginSession,
    quickLogin,
    waitForNetworkConnection,
    waitSessionReady,
} from "./login/index.js";
