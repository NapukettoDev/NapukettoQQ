# @napuketto/network

## 0.4.4

### Patch Changes

- 2ff0da0: 修复 Milky 活跃 SSE/WS 导致的关闭阻塞；HttpServer 有界回收普通请求、流式连接及同端口升级资源，重复关闭安全。监听失败 reject 并支持清理后重试；落实普通请求 timeoutMs（504），首次响应生效，迟到/重复 respond 忽略，同步处理及序列化异常回 500。流式响应不受普通请求超时影响。

## 0.4.3

### Patch Changes

- 1ac012f: 修复 Satori WS 事件服务越权泄露：配了 `token` 时，未认证连接此前仍会收到全部 `EVENT`
  （token 校验失败只是「不响应」，连接保持 OPEN 并留在广播集合里）。
  
  - Satori 新增 `SatoriEventHub`：接管 wsServers 的 `send`/`open`/`close`，只向完成
    `IDENTIFY` 的连接广播事件；token 不符或连接建立后 10s 内未 `IDENTIFY` 以 close code
    `4004` 断开。token 为空仍表示不鉴权（连接即视为已认证）。
  - `WsServer` 新增 `onConnection` 钩子，并把连接作为 `onRequest` 第三参透传，供
    「连接后才认证」的协议登记认证状态（可选能力，向后兼容）。

## 0.4.2

### Patch Changes

- 8e2e220: 规范化 npm 发布元数据（仅 `package.json` 元信息，无运行时改动）：五个包统一补齐 `$schema`、
  `keywords`、指向包内 README 的 `homepage`、`bugs`，`repository` 补上 `directory`，`author`
  改为结构化对象；`description` 统一为英文并补全语义（`loader` 原中文描述改写为英文，与其余四个包一致）。
  `adapter` 的 `exports` 与 `tsdown.entry`、`loader` 的 `files` 只调整键序，条目集合不变。
  
  导出子路径、依赖声明与包版本均未变化，按 patch 发布，刷新 registry 上的描述 / 关键词 / 仓库链接。
  `tooling/package-exports.test.ts` 的子路径白名单断言同步改为集合比较，不再把 `exports` 键序当契约。

## 0.4.1

### Patch Changes

- 2098f16: 二阶段类型安全清零：原生反射边界（wrapper / loader / network）与全仓残余断言改用运行时类型守卫。
  
  - kernel：`type-guards` 扩展（`isCallable` / `getOwnProp` / `hasMethodSurface` / `getErrorCode` 等），新增 `wrapper/wrapper-guards`；`wrapper-loader`、`session-resolver`、`probe/**` 零断言；`GroupMember` / `EssenceMsgItem` 的非保证字段改为可选并在守卫中逐字段校验；`login-bridge`、`event-channel`、`msg` / `recent-contact` / `profile`、日志与配置解析同步清零。
  - loader：新增本地 `type-guards` / `module-guards`，动态 `import()` 结果与 IPC 反射调用全部运行时校验；`CoreContextLike` / `KernelServices` 补齐精确结构，删除下游强转；diagnostic `sessionCall` 拦截 `onLine` / `wifiphoto` 危险方法。
  - network / media：`JSON.parse` 与原生 server 收窄改守卫；ffprobe 输出安全构造。
  - adapter / apps：`buddy-req` / essence / milky / kurobot / OB11 请求分发与 CLI 配置解析改用守卫，畸形载荷安全降级。

## 0.4.0

### Minor Changes

- d11321f: 嵌入式 SDK 体验（DX）收口：补齐 Public API 导出与 `ProtocolConfig` 兼容导出，新增 `createKernelRuntime` 服务聚合与 `NapukettoCore.activateSession/createRuntime`，支持 Plain Object 协议配置与可选 `broadcaster`，并修复定时器/原生监听器泄漏、异步监听异常逃逸与幂等 `dispose()` 生命周期。

## 0.3.2

### Patch Changes

- 1ed167a: 统一全仓命名规范、错误消息提取与抛错范式，并收敛重复工具函数（纯重构，公开 API 保留
  `@deprecated` 别名与旧环境变量双读回退）。
  
  - `kernel` 新增唯一权威 `errorMessage(err)`；`adapter` / `apps/cli` 统一复用，删除各包内联
    `err instanceof Error ? err.message : String(err)` 与本地 `errMsgString`。
  - 环境变量前缀统一为 `NAPUKETTO_*`（读取侧回退 `NAPKETTO_*` / `NAPUTO_*`；`loader` 注入侧
    切换到新前缀，`NAPUTO_DISABLE_MEDIA_PATCH` / `NAPUTO_MEDIA_PATCH_STATUS` 两个原生契约键
    保持不变），布尔解析统一走 `isEnvEnabled`（`"1"` / `"true"`）。
  - `adapter` 动作 / 适配器生命周期抛错统一为 `kernelError`：Satori 动作的 `NOT_FOUND` /
    `INVALID_PARAM` 现分别映射为 HTTP 404 / 400（此前落 `UNKNOWN` → 500），OB11 下载类失败
    映射为 `SEND_CODE_FAILED`（100）。
  - `media` 下载与转码统一抛 `MediaError`；`network` 统一 `incomingMessageToRequestContext`；
    跨包重复的 `replaceExt` / `NUMERIC_RE` / `fileUriToPath` / Zod schema / 动态模块契约接口
    收敛到单一来源。
  - 文件命名统一：`one-bot-api.ts` → `onebot-api.ts`、`log-cfg.ts` → `log-config.ts`、
    `group/group-files-*.ts` → `group/files-*.ts`；`IKernelLoginListener` / `SatoriAction` /
    `QQVersion*` 等旧名保留 `@deprecated` 别名导出。

## 0.3.1

### Patch Changes

- 06bf7a9: fix(release): 发布包不再泄漏 `catalog:` 协议（0.6.x–0.7.x 的 npm 包无法安装）
  
  2026-11-03 引入 pnpm catalog 后，`catalog:` 写法进了三个包的运行时依赖：
  `@napuketto/network`（hono / @hono/node-server / ws）、`@napuketto/adapter` 与
  `@napuketto/loader`（zod）。`changeset version` 只改写 `workspace:*`、从不碰 catalog，
  发布链也没有兜底，于是这些版本把 `"zod": "catalog:"` 原样发上 npm——用户侧
  `npm install @napuketto/loader` 直接 `EUNSUPPORTEDPROTOCOL`（2026-11-10 Linux 原生宿主
  nightly smoke 第一次走到「装已发布包」这一步时抓到；本地 `pnpm pack` 会改写 catalog，
  所以此前的手工验证看不出来）。
  
  修复在发布链（`tooling/release`）：发布前按 `pnpm-workspace.yaml` 的 `catalog:` 段把
  `catalog:` 改写为真实版本范围、发布后恢复原样；改写完再断言四个依赖字段里没有
  `workspace:` / `catalog:` 残留，有就中断发布。本组补丁版本用带修复的发布链重发，
  代码本身无行为变化。

## 0.3.0

### Minor Changes

- 39d98d8: **network（minor）**：新增 `WsSocket` 类型与 `isWsOpen()` 导出，协议层不再需要直接声明 `ws`；
  `WsServer` 与 `HttpServer` 的同端口升级显式设置 `skipUTF8Validation: false`（文本帧进入
  `JSON.parse` / 日志前强校验 UTF-8），并明确不装 `bufferutil` / `utf-8-validate` 原生加速插件
  （Node 22/24 内置实现已足够快，也符合「只有 kernel 允许原生层」的约束）。
  
  **adapter（minor）**：KuroBot 连接层改用 Node 内置 `WebSocket`（undici，子协议 / close code /
  事件模型都覆盖），`ws` 与 `@types/ws` 降为 devDependencies（仅供测试的假服务端起真端口）——
  发布的 adapter 包不再声明 `ws` 运行时依赖；Milky `/event` 的 socket 类型改走 network 的
  `WsSocket` / `isWsOpen()`。
  
  **create-napukettoqq（patch）**：终端着色改用 `node:util` 的 `styleText`，移除 `picocolors`
  直接依赖（`NO_COLOR` / `FORCE_COLOR` / 非 TTY 纯文本行为不变）。
  
  配套仓库级门禁（不单独占用版本号）：`pnpm-workspace.yaml` 开 `engineStrict: true`（Node 不满足
  `engines` 时安装直接失败）、7 个发布包补 `publishConfig.provenance: true`（OIDC 发布带 SLSA
  溯源，本地发布由 release 脚本自动 `--no-provenance`）、`tooling/package-exports.test.ts` 新增
  catalog 强制令 / media 产物 50 KB 熔断 / `files` 白名单断言。

## 0.2.0

### Minor Changes

- d08fdf1: chore(deps): 依赖审计整改（供应链 / 包边界 / 外部输入加固）
  
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

## 0.1.0

### Minor Changes

- 51a0ce8: feat(milky): Milky 协议适配器 P0（第四协议，目标 Milky 1.3.0）——
  
  - adapter：`@napuketto/adapter/milky` 子路径导出 `NapukettoMilkyAdapter` + `milkyConfigSchema`。单端口 HTTP（`POST /api/:api` 规范信封 + 401/404/415 语义；`GET /event` SSE/WS 事件推送）+ WebHook；P0 动作 9 个（get_login_info / get_impl_info / send_private_message / send_group_message / get_message / recall_*_message / get_friend_list / get_group_list），事件 2 个（message_receive 三场景 / message_recall）；类型层为官方 JSON Schema 的自研描述（P0 子集）；seq↔msgId 走 adapter 侧 MessageSeqIndex 双向映射（接收登记 + 历史扫描兜底）；发送核心含媒体 URI 解析（file:// / base64:// / http(s):// 落盘）
  - network：SSE 事件流原语（`createSseResponse`）+ `HttpServer` 流式响应注入点（`onRawRequest`）与同端口 WS 升级注入点（`onUpgrade`）+ 空 body 响应支持（respond undefined）——均协议无关
  - loader：`[accounts.milky]` 账号段读取与装配分支（段存在才装配，enabled=true 生效）
  - cli / create：账号配置 schema 增 `milky` 段，配置模板与脚手架模板同步

## 0.0.3

### Patch Changes

- cb4bd37: chore(release): 接入 npm OIDC 可信发布与 PR-only 门禁（无功能变更，一次性 patch 用于实证发布链）
  
  - 新增 `.github/workflows/release.yml`：合并带 changeset 的 PR 后，prepare 消费 changeset、构建、测试并推送版本提交；publish 在 `release` environment 审批后逐包 `npm publish`（OIDC 短时 token，无长期凭证，自动 provenance）。
  - 发布前逐包预检 npm 信任配置（`tooling/release/release-trust.ts`），缺配置整批不发，杜绝半批发上 npm。
  - 发布链拆成 `release:version` / `release:build` / `release:test` / `release:publish`，本地 `pnpm release` 复用同口径，仅作演练与应急。
  - CI 增加 `merge_group` 触发，配合主分支 merge queue 与必需状态检查；一切改动走 PR（发布链的版本提交是唯一既定例外）。

## 0.0.2

### Patch Changes

- be5845c: feat: Koishi 插件 IPC 模式整表挂载 OB11 动作容器（79 动作 + ob11 事件透出）——① loader 新增 ipc-ob11 桥：检测 NAPUTO_ADAPTER_ENTRY/NAPUTO_NETWORK_ENTRY 注入时动态 import adapter/network，实例化 NapukettoOneBot11Adapter 仅 subscribeOnly()（接收链路，零网络传输/零配置文件 IO），全部动作名平铺合并进共享 IPC 动作表，OB11 事件经 broadcaster → sendEvent("ob11") 透出，装配失败 fail-soft 降级；② adapter 新增 subscribeOnly()/unsubscribeOnly() 公共方法与公开 registry（IPC 桥枚举挂载用）；③ adapter/network 根导出补 require 条件（koishi 插件 CJS 产物 createRequire.resolve 定位入口用，实际消费仍走 ESM 动态 import）；④ koishi 插件新增 @napuketto/adapter/@napuketto/network 依赖与 ob11Actions 配置（默认开），launcher 透传入口，bot.onOb11 暴露原始 OB11 事件订阅口，bot.internal.\_request("send_like", ...) 直达全部 OB11 动作（返回 OB11 标准信封）
