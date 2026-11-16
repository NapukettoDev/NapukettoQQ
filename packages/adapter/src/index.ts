/**
 * @napuketto/adapter 入口
 *
 * 本文件是**包根 / dist 路径锚点**，同时提供开箱即用的聚合导出：嵌入式
 * 调用方 `import { NapukettoOneBot11Adapter, ... } from "@napuketto/adapter"`
 * 即可获得完整 IDE 自动补全，不必记住子路径。
 *
 * 重要（路径契约，勿删）：
 * 1. `package.json` 的 `"."` 子路径需要真实文件存在，`import.meta.resolve()` /
 *    `createRequire().resolve()` 才解析得到本包（外部消费方据此定位 dist）；
 * 2. cli 把解析结果注入 `NAPUTO_ADAPTER_ENTRY`，loader 再按 `index.mjs` →
 *    `core|onebot11|satori|kurobot|milky/index.mjs` 字符串替换推出各协议入口
 *    （见 loader `assemble-protocols.ts` / `ipc-ob11.ts` 的 `INDEX_MJS_RE`）。
 *
 * 子路径导出（./core、./onebot11、./satori、./kurobot、./milky）保持不变；
 * 本文件只追加聚合，不改变任何子路径的解析结果。
 */

export type {
    ActionKernelSpec,
    ActionOutcome,
    ConfigFormat,
    ConfigOptions,
    ConfigSchema,
    ErrorCodeMap,
    ProtocolHooks,
} from "./core/index.js";
export {
    ActionRegistry,
    BaseProtocolAdapter,
    ConfigBase,
    createServerSchema,
    ProtocolConfig,
    runAction,
} from "./core/index.js";
export type { KurobotAdapterOptions, KurobotConfig } from "./kurobot/index.js";
export { kurobotConfigSchema, NapukettoKurobotAdapter } from "./kurobot/index.js";
export type { MilkyAdapterOptions, MilkyConfig } from "./milky/index.js";
export { milkyConfigSchema, NapukettoMilkyAdapter } from "./milky/index.js";
export type { OB11Config, OneBot11AdapterOptions } from "./onebot11/index.js";
export { NapukettoOneBot11Adapter, ob11ConfigSchema } from "./onebot11/index.js";
export type { SatoriAdapterOptions, SatoriConfig } from "./satori/index.js";
export { NapukettoSatoriAdapter, satoriConfigSchema } from "./satori/index.js";
