# @napuketto/media 设计书（2026-11-03 首版）

> 本包是**独立的媒体处理层**（ADR-011）：语音 SILK 编解码、视频探测与转码、
> 图片/文件类型识别、HTTP(S) 媒体下载。`@napuketto/kernel` 是唯一原生交互层，
> **严禁依赖本包**；本包也只被协议层 `@napuketto/adapter` 消费。边界只有一句话：
> 媒体能力属于协议语义，不属于原生交互，也不属于传输原语。

## 1. 包职责与架构边界（ADR-011）

ADR-011 否决了「媒体工具放进 kernel 或 common utils」：`ffmpeg`（外部进程）与
`silk-wasm`（WASM）只有协议层的语音/视频收发需要，放进 kernel 会让所有宿主
（包括只用登录 + 事件订阅的场景）被动加载媒体依赖，也让 kernel 的依赖面从
「pino + smol-toml」膨胀成「编解码 + 子进程」。

| 职责 | 实现主体 | 运行时依赖 |
| :--- | :--- | :--- |
| 音频 SILK 编解码（语音消息） | `audio.ts` | `silk-wasm`、`ffmpeg`（PATH） |
| 视频探测 / 转码 / 抽帧（视频消息与缩略图） | `video.ts` | `execa` + `ffmpeg` / `ffprobe`（PATH） |
| 图片尺寸、文件类型（魔数）识别 | `image.ts` | `image-size`、`file-type` |
| HTTP(S) 媒体下载（主动取图/语音） | `downloader.ts` | Node 内建 `fetch`（零额外依赖） |

硬性边界（与 `docs/architecture/overview.md` 的依赖方向一致）：

- **无内部依赖**：`@napuketto/media` 不 import 任何 `@napuketto/*` 包。
- **只被 adapter 消费**：adapter 用 `encodePcmToSilk` / `decodeSilkToWav` /
  `transcodeVideo` / `downloadUrl` / `inferExtension`（见
  `packages/adapter/docs/design.md` §5）。协议语义留在 adapter，本包只提供
  与协议无关的媒体原语。
- **kernel 严禁依赖**：kernel 的 `package.json` 不得出现本包；反向 import 视为
  架构违规（红线 6：media 严格解耦，kernel 不背媒体依赖）。
- **外部二进制**：`ffmpeg` / `ffprobe` 由 `execa` 以子进程调用，依赖系统
  `PATH`；本包不内置、不下载、不打包二进制。
- **错误语义**：可预期的媒体失败统一抛 `MediaError`（`types.ts`），不静默回落，
  便于协议层映射为错误码。

## 2. 模块清单

| 文件 | 导出 | 职责 |
| :--- | :--- | :--- |
| `src/audio.ts` | `encodePcmToSilk`、`decodeSilkToPcm`、`decodeSilkToWav`、`getSilkInfo`、`SILK_SAMPLE_RATE` | SILK 编解码。QQ 语音 silk v3 固定 24000Hz 单声道：单声道 16-bit PCM WAV / 原始 `pcm_s16le` 直接交 `silk-wasm`；立体声、非 16-bit 或压缩编码（mp3/ogg/amr/flac…）先经 `ffmpeg` 归一化为 24000Hz 单声道 `pcm_s16le` 再编码 |
| `src/video.ts` | `transcodeVideo`、`getVideoInfo`、`extractVideoFrame` | 视频转码/缩放/帧率、解析 `ffprobe` JSON 取宽高与时长、抽首帧作缩略图（QQ 视频消息发送必需） |
| `src/image.ts` | `getImageSize`、`detectFileType` | `image-size` 读缓冲区算宽高；`file-type` 按魔数识别类型（返回 `undefined` → `MediaError`） |
| `src/downloader.ts` | `downloadUrl`、`inferExtension` | 最小下载原语：`fetch` + 大小上限（缺省 30MB）+ 超时（缺省 15s），写目标路径；从 URL pathname 推断扩展名。目录创建与清理由调用方负责 |
| `src/types.ts` | `ImageSize`、`FileTypeResult`、`AudioInfo`、`VideoInfo`、`DecodedAudio`、`TranscodeOptions`、`DecodeSilkToWavOptions`、`DownloadUrlOptions`、`MediaError` | 跨模块公共类型与统一错误类 |
| `src/index.ts` | 上述全部 | 包门面（唯一构建入口）：只做 re-export，不含逻辑 |
| `src/__tests__/audio.test.ts` | — | `audio.test.ts` 基线测试：锁定 `encodePcmToSilk` 的格式分派与 `MediaError` 失败路径；以 `vi.mock("execa")` 桩掉 `ffmpeg`，不依赖真实二进制 |

## 3. 构建与发布形态

产物为 **ESM + CJS 双格式**（`tsdown.config.ts`）：

- `dist/index.mjs`（ESM）+ `dist/index.cjs`（CJS），类型声明 `dist/index.d.mts` /
  `dist/index.d.cts`；`package.json` 的 `exports` 同时保留 `import` 与 `require`
  条件。
- **为什么必须双格式**（2026-08-24 生产事故）：koishi 适配器发布形态是 CJS
  （`lib/index.cjs`），koishi loader 用 `require()` 加载插件 → 插件 CJS 产物
  `require` 本包。此前本包只有 ESM 入口，CJS 解析报
  `ERR_PACKAGE_PATH_NOT_EXPORTED`。修复方式是与 kernel/loader 一致补双格式 +
  `require` 条件。
- **`deps.alwaysBundle: ["execa", "file-type"]` 的原因**：这两个依赖是纯 ESM、
  无 CJS 入口（`execa` v10 / `file-type` v22），CJS 产物 `require` 它们会在
  Node <22.12 抛 `ERR_REQUIRE_ESM`。因此由 tsdown 把它们**内联进产物**（ESM
  产物同样内联，无碍——ESM 消费方不受影响）。
- **保持 external 的依赖**：`image-size`（双格式）与 `silk-wasm`（CJS）本身可被
  CJS `require` 正常加载，按默认 externals 处理，避免无谓增大产物体积。

## 4. 测试布局

单元测试统一放 `src/__tests__/`（与 kernel/adapter 等包一致，避免测试文件与源码
同层平铺）。测试通过根 `vitest.config.ts` 的 `packages/*/src/**/*.test.ts` 发现，
相对导入下沉一层后仍保留 NodeNext 的 `.js` 后缀（`../audio.js`）。
