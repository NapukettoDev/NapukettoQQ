/**
 * tsdown.config.ts：@napuketto/media 构建（2026-11-03 起 Pure ESM + 不内联依赖）。
 *
 * 产物：dist/index.mjs（ESM）+ dist/index.d.mts。
 *
 * 2026-08-24 曾为「koishi 适配器 CJS require media」出双格式，并把纯 ESM 的
 * execa@10 / file-type@22 用 deps.alwaysBundle 打进产物（否则 CJS 侧
 * ERR_REQUIRE_ESM）。2026-11-03 审计后这些前提都消失了：
 *   - 运行时底线 Node >=22.12，require(esm) 原生可用，不再需要 .cjs；
 *   - 内联会让下游 `pnpm audit --prod` 看不见 execa/file-type 及其 30 个传递
 *     依赖，CVE 也没法用 overrides 热修；signal-exit 这类进程级单例还会被复制
 *     成第二份闭包。现在一律 external，按普通 dependencies 分发，MIT 版权随各包
 *     自带 LICENSE 一起走（不再需要往产物里拼 banner）。
 */
import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    clean: true,
    dts: true,
});
