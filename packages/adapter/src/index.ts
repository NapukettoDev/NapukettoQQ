/**
 * @napuketto/adapter 入口
 *
 * ⚠️ 本文件是**包根 / dist 路径锚点**，运行期不导出任何实现——构建产物
 * 只有一行 `export {};`。它的作用不是提供 API，而是让包根可被解析：
 *
 * 1. `package.json` 的 `"."` 子路径需要真实文件存在，`import.meta.resolve()` /
 *    `createRequire().resolve()` 才解析得到本包（外部消费方据此定位 dist）；
 * 2. cli 把解析结果注入 `NAPUTO_ADAPTER_ENTRY`，loader 再按 `index.mjs` →
 *    `core|onebot11|satori|kurobot|milky/index.mjs` 字符串替换推出各协议入口
 *    （见 loader `assemble-protocols.ts` / `ipc-ob11.ts` 的 `INDEX_MJS_RE`）。
 *
 * 因此**不要删除本文件**；协议面一律走子路径（./core、./onebot11、./satori、
 * ./kurobot、./milky），根入口只做锚点、不聚合协议（tree-shaking 友好）。
 * 确需移除时，必须同步改 cli 的 `packageEntry()` 与 loader 两处 `INDEX_MJS_RE` 推导。
 */

// 显式空导出：保持本文件是 ESM 模块（否则退化为全局 script，产物/声明都不稳定）。
export {};
