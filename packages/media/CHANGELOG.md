# @napuketto/media

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
