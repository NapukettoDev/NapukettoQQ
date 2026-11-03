---
"@napuketto/kernel": minor
"@napuketto/media": minor
"@napuketto/network": minor
"@napuketto/adapter": minor
"@napuketto/loader": minor
"@napuketto/cli": minor
"create-napukettoqq": patch
---

chore(deps): 依赖审计整改（供应链 / 包边界 / 外部输入加固）

按 2026-11-03 依赖审计报告的顾问意见执行，一次性收口依赖拓扑与发布形态。

**发布形态（破坏性）：全仓 Pure ESM**
- `kernel` / `media` / `loader` / `network` / `adapter` / `cli` 不再产出 `.cjs` /
  `.d.cts`，`exports` 统一为 `types` + `default`（子路径同样补 `default`）。
  运行时底线 Node ≥22.12（`commander@15` 已硬性要求），CJS 消费方
  `require()` 经 `require(esm)` 原生加载 `.mjs`；此前 `adapter/onebot11` 等子路径
  只声明 `import` 条件，CJS 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`，本次修复。
  `loader` 仍保留内部被 spawn 的 `dist/host/self-host.cjs`（不是对外 API）。
- 7 个发布包补齐 `engines.node: ">=22.12.0"`、`publishConfig.access: "public"`；
  库包补 `sideEffects: false`。bin 包（`cli` / `create-napukettoqq`）不声明
  `sideEffects: false`——它们 import 即执行 `main()`。

**依赖拓扑**
- `media` 取消对 `execa` / `file-type` 的 `alwaysBundle` 内联：产物从 ~383 KB
  降到 ~13 KB，两个包回归普通 `dependencies`。下游 `pnpm audit --prod` 重新可见
  这 30 个传递依赖，安全公告可用 `overrides` 热修，`signal-exit` 不再出现第二份
  进程级单例，MIT 版权随各包自带 LICENSE 分发（不再需要 banner）。
- `kernel` 的 `pino-pretty` 改为 **optional peerDependency**，`cli` 显式依赖它；
  kernel 内部从静态 `import` 改为运行时 `require` + 失败降级。Koishi / 无头宿主
  不再被迫安装 pino-pretty 及其 18 个传递依赖；CLI 终端体验不变。
- `create-napukettoqq` 的 `@napuketto/cli` 从 `dependencies` 移到
  `devDependencies`（仅用于读取自身版本号拼模板）：`pnpm create napukettoqq`
  不再预装 95 个生产包。
- `pnpm-workspace.yaml` 引入 `catalog:`，`zod` / `hono` / `@hono/node-server` /
  `ws` / `@types/ws` / `@types/node` / `tsdown` / `vitest` / `@vitest/coverage-v8`
  全仓单版本；`@types/node` 统一回与运行时一致的 24（不再 24/26 双份）。

**安全修复**
- `zod` 4.6.1 → 4.6.7（GHSA-mrhx-c7xc-m3w5，CVSS 7.5，CWE-770 内存放大）。
- 外部输入上界：Milky 消息段 ≤ 200、OneBot 11 三类发送动作消息段 ≤ 200、
  合并转发节点 ≤ 500、批量文件 id ≤ 100、批量翻译词条 ≤ 2000。
- `network` 新增请求体上限（默认 16 MiB，`bodyLimitBytes` 可覆盖）与 WS 单消息
  上限（默认 32 MiB，`maxPayloadBytes` / `wsMaxPayloadBytes` 可覆盖），默认值
  按 base64 媒体尺寸留足余量。
- `launch-editor` 传递依赖经 override 升到 2.14.2（1 high + 2 moderate）。

**工作区配置**
- 删除 `trustLockfile: true` 与 `verifyDepsBeforeRun: false`（日常安装恢复完整
  冷却期 / lockfile 校验，发布链局部用 `npm_config_trust_lockfile`）；
  `minimumReleaseAgeExclude` 改 `@napuketto/*` 通配；删掉无效的
  `@typescript-eslint/*` overrides、root `workspaces` / `overrides` 与失效的
  `vue-demi` allowBuilds 条目。
- CI gate 增加 `pnpm audit --prod --audit-level=high`；新增
  `.github/dependabot.yml`（weekly 分组更新，忽略 workspace 内部包）。
