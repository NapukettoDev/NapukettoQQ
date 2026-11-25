/**
 * module-loader.ts：file:// 动态模块加载与导出面守卫（唯一实现，2026-11-25）。
 *
 * 背景：loader 编译期不依赖 adapter / network / kernel，全部运行期 `import(file://…)`。
 * 此前 assemble-protocols.ts 与 ipc/ob11-bridge.ts 各写了一份「反斜杠转正 + 拼子路径 +
 * 守卫收窄 + 报错文案」的逻辑——两份实现容易在错误文案与守卫顺序上漂移。
 * 本模块是这条链路的单一来源：
 *
 *  - `toFileUrl`：Windows 反斜杠 → 正斜杠的 file:// 前缀（**不用 pathToFileURL**：
 *    既有产物契约与报错文案按这个形态断言，改动属行为变更）
 *  - `subpathEntry`：adapter 入口 `index.mjs` → `<subpath>/index.mjs`（ADR-014 子路径导出）
 *  - `importNetworkModule` / `importSubpathModule`：导入 + 守卫 + 统一报错
 *  - `importOptionalModule`：账号段为空时**零加载**（ADR-014 按需加载）
 *  - `loadOb11BridgeModules`：IPC 模式下 OB11 动作桥的三模块装配（可注入 import 便于单测）
 */
import { BACKSLASH_RE, INDEX_MJS_RE, type ProtocolKey } from "./constants.js";
import { isAdapterCoreModule, isNetworkModule, isOb11Module } from "./module-guards.js";
import type { AdapterCoreModuleLike, NetworkModuleLike, Ob11ModuleLike } from "./protocol-types.js";

/** file:// URL 化（Windows 反斜杠转正斜杠）。 */
function toFileUrl(p: string): string {
    return `file://${p.replace(BACKSLASH_RE, "/")}`;
}

/** adapter 入口 index.mjs → 子路径入口（`core` = 配置框架，其余为协议键）。 */
function subpathEntry(adapterEntry: string, subpath: ProtocolKey | "core"): string {
    return adapterEntry.replace(INDEX_MJS_RE, `${subpath}/index.mjs`);
}

/** 动态 import network 并校验导出面。 */
export async function importNetworkModule(networkEntry: string): Promise<NetworkModuleLike> {
    const raw: unknown = await import(toFileUrl(networkEntry));
    if (!isNetworkModule(raw)) {
        throw new Error(`Invalid @napuketto/network module exports at ${networkEntry}`);
    }
    return raw;
}

/**
 * 动态 import adapter 子路径并校验导出面（ADR-014：子路径导出，按需加载）。
 * 子路径名即协议键（`core` 为配置框架）；错误消息统一为
 * `Invalid @napuketto/adapter/<subpath> exports at <url>`（与逐协议手写版本逐字一致）。
 */
export async function importSubpathModule<T>(
    adapterEntry: string,
    subpath: ProtocolKey | "core",
    guard: (val: unknown) => val is T,
): Promise<T> {
    const url = subpathEntry(adapterEntry, subpath);
    const raw: unknown = await import(toFileUrl(url));
    if (!guard(raw)) {
        throw new Error(`Invalid @napuketto/adapter/${subpath} exports at ${url}`);
    }
    return raw;
}

/** 「段存在即启用、不写不启用」：空段 = 该可选协议关闭。 */
export function hasSection(section: Record<string, unknown>): boolean {
    return Object.keys(section).length > 0;
}

/** 可选协议子路径按需加载：账号段非空才 `import()`（未启用协议零加载）。 */
export async function importOptionalModule<T>(
    adapterEntry: string,
    subpath: ProtocolKey,
    section: Record<string, unknown>,
    guard: (val: unknown) => val is T,
): Promise<T | undefined> {
    if (!hasSection(section)) {
        return undefined;
    }
    return await importSubpathModule(adapterEntry, subpath, guard);
}

/** 动态 import（file:// URL；全动态表达式，打包器不静态解析）。 */
export async function importFileUrl(url: string): Promise<unknown> {
    return import(url);
}

/** OB11 桥依赖的已校验模块面。 */
export interface Ob11BridgeModules {
    network: NetworkModuleLike;
    adapter: Ob11ModuleLike;
    adapterCore: AdapterCoreModuleLike;
}

/** OB11 桥装配需要的两个入口（adapter 包入口 / network 包入口）。 */
export interface Ob11BridgeEntries {
    adapterEntry: string;
    networkEntry: string;
}

/** 动态 import 并校验 network / onebot11 / core 三个模块（失败抛出）。 */
export async function loadOb11BridgeModules(
    importModule: (url: string) => Promise<unknown>,
    entries: Ob11BridgeEntries,
): Promise<Ob11BridgeModules> {
    const rawNetwork: unknown = await importModule(toFileUrl(entries.networkEntry));
    if (!isNetworkModule(rawNetwork)) {
        throw new Error(`Invalid @napuketto/network module exports at ${entries.networkEntry}`);
    }
    // adapter 子路径导出（ADR-014）：onebot11 面 / core 框架各走各的入口
    const onebot11Entry = subpathEntry(entries.adapterEntry, "onebot11");
    const coreEntry = subpathEntry(entries.adapterEntry, "core");
    const rawAdapter: unknown = await importModule(toFileUrl(onebot11Entry));
    if (!isOb11Module(rawAdapter)) {
        throw new Error(`Invalid @napuketto/adapter/onebot11 exports at ${onebot11Entry}`);
    }
    const rawAdapterCore: unknown = await importModule(toFileUrl(coreEntry));
    if (!isAdapterCoreModule(rawAdapterCore)) {
        throw new Error(`Invalid @napuketto/adapter/core exports at ${coreEntry}`);
    }
    return { network: rawNetwork, adapter: rawAdapter, adapterCore: rawAdapterCore };
}
