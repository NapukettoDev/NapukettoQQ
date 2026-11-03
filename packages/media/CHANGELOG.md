# @napuketto/media

## 0.1.0

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

## 0.0.7

### Patch Changes

- 0e8a808: fix(packaging): `exports["."]` 顶层补 `types` 条件，修复 NodeNext 类型解析
  
  双格式包（`dist` 同时产出 `.mjs` / `.cjs`）此前只在 `import` / `require` 分支内声明
  `types`，只读取顶层 `types` 条件的解析器拿不到声明文件。现于 `exports["."]` 顶层补
  `"types": "./dist/index.d.mts"`，并保留分支内各自的 `types`——顶层这行必须排在
  `import` / `require` 之后，否则 CJS 消费者会被条件匹配劫持到 ESM 声明文件
  （attw: Masquerading as ESM）。
  
  新增 `tooling/package-exports.test.ts` 锁定该形状；attw（node10 / node16 CJS /
  node16 ESM / bundler）与 TS 5.9 / 7.0 消费者矩阵验证通过。

## 0.0.6

### Patch Changes

- cb4bd37: chore(release): 接入 npm OIDC 可信发布与 PR-only 门禁（无功能变更，一次性 patch 用于实证发布链）
  
  - 新增 `.github/workflows/release.yml`：合并带 changeset 的 PR 后，prepare 消费 changeset、构建、测试并推送版本提交；publish 在 `release` environment 审批后逐包 `npm publish`（OIDC 短时 token，无长期凭证，自动 provenance）。
  - 发布前逐包预检 npm 信任配置（`tooling/release/release-trust.ts`），缺配置整批不发，杜绝半批发上 npm。
  - 发布链拆成 `release:version` / `release:build` / `release:test` / `release:publish`，本地 `pnpm release` 复用同口径，仅作演练与应急。
  - CI 增加 `merge_group` 触发，配合主分支 merge queue 与必需状态检查；一切改动走 PR（发布链的版本提交是唯一既定例外）。

## 0.0.5

### Patch Changes

- 3665e63: feat(kernel): 支持视频消息发送（VIDEO 元素）
  
  - canonical `video` 元素扩展 `thumbPath` / `width` / `height` / `durationSec`，收向
    `videoToCanonical` 同步补全（`thumbWidth`/`thumbHeight`/`fileTime`/`Map` thumbPath）。
  - 新增 `MsgApi.prepareVideoElement`：md5 → `getRichMediaFilePathForGuild`
    （`downloadType=1` 原文件 / `2` 缩略图）→ `util.copyFile` 放置 → 完整
    `videoElement`（`thumbPath` 为真实 `Map<0, path>`，JSON 边界会丢成 `{}`）。
  - **修复关键坑**：缩略图目标路径必须用**视频 md5**（`Thumb/<videoMd5>_0.png`），
    `thumbMd5` 只是缩略图内容 md5；用 thumbMd5 算路径会让 native 传输找不到缩略图，
    报 `rich media transfer failed`。
  - `placeMediaFile` 增加 `downloadType` 参数（PIC/PTT 行为不变）。
  - `toSendElements` 的 `video` 分支改为显式报错「需经预处理」，防止绕过。
  - 自建宿主实测（2026-10-17）：`sendMsg` 成功（sendStatus 2/3），群内收到可播放视频；
    详见 `packages/kernel/docs/design.md` §8。
  
  feat(media): 新增 `extractVideoFrame`（ffmpeg 抽首帧 PNG 作视频缩略图）

## 0.0.4

### Patch Changes

- 43a42e1: feat(media/adapter/loader): get_image/get_record 接主动下载——media 包新增 downloadUrl/inferExtension（fetch + 大小上限 + 超时）；get_image 本地 NT 相对路径按 mediaBaseDir（QQ NT global 目录，装配链经 resolveQqUserDataRoot 解析注入）解析，未命中且有 picUrl 时下载到 cacheDir/media 返回 file；get_record 本地解析命中返回绝对路径（语音主动下载缺口：downloadRichMedia 原生签名未探测，待实测后接入）
- 59e5492: feat(media/adapter): 媒体收发方向接线——media 新增 decodeSilkToWav（silk → 可播放 WAV，收方向语音）并加固 transcodeVideo（exitCode/产物存在性校验，失败抛 MediaError 不再返回幽灵路径）；satori video 非 mp4 输入发送前 ffmpeg 归一化（fail-soft 原样透传）

## 0.0.3

### Patch Changes

- 3f99e1f: fix(media): 补充 CJS 入口（双格式构建 + exports require 条件），修复 koishi 适配器生产加载报 ERR_PACKAGE_PATH_NOT_EXPORTED。execa / file-type（ESM-only）强制打进产物，避免 CJS require 抛 ERR_REQUIRE_ESM。

## 0.0.2

### Patch Changes

- 2c099aa: fix(media): 修复语音发送「显示 3 分钟却只播放 5 秒」——encodePcmToSilk 对非 WAV 输入（mp3/ogg/amr 等）原本把压缩字节当 PCM 且采样率传 0 触发 silk-wasm「divide by zero」，被上层静默回落为原文件原样发送，导致时长按文件大小估算严重失真、QQ 端只播放开头一小段；现改为经 ffmpeg 归一化为 24000Hz 单声道 pcm_s16le 再编码，同时修复立体声 WAV 被 silk-wasm 只取单声道导致时长减半的问题。
