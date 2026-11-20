# @napuketto/media 设计书

> 本包是**独立的媒体处理层**（ADR-011）：语音 SILK 编解码、视频探测与转码、图片/文件
> 类型识别、HTTP(S) 下载。kernel 严禁依赖本包；本包只被协议层 `@napuketto/adapter` 消费。
> 媒体能力属于协议语义，不属于原生交互，也不属于传输原语。

## 包职责与架构边界（ADR-011）

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
  `packages/adapter/docs/design.md` 的媒体依赖面）。协议语义留在 adapter，本包只提供
  与协议无关的媒体原语。
- **kernel 严禁依赖**：kernel 的 `package.json` 不得出现本包；反向 import 视为
  架构违规（红线 6：media 严格解耦，kernel 不背媒体依赖）。
- **外部二进制**：`ffmpeg` / `ffprobe` 由 `execa` 以子进程调用，依赖系统
  `PATH`；本包不内置、不下载、不打包二进制。
- **错误语义**：可预期的媒体失败统一抛 `MediaError`（`types.ts`），不静默回落，
  便于协议层映射为错误码。

## 模块清单

| 文件 | 导出 | 职责 |
| :--- | :--- | :--- |
| `src/audio.ts` | `encodePcmToSilk`、`decodeSilkToPcm`、`decodeSilkToWav`、`getSilkInfo`、`SILK_SAMPLE_RATE` | SILK 编解码。QQ 语音 silk v3 固定 24000Hz 单声道：单声道 16-bit PCM WAV / 原始 `pcm_s16le` 直接交 `silk-wasm`；立体声、非 16-bit 或压缩编码（mp3/ogg/amr/flac…）先经 `ffmpeg` 归一化为 24000Hz 单声道 `pcm_s16le` 再编码 |
| `src/video.ts` | `transcodeVideo`、`getVideoInfo`、`extractVideoFrame` | 视频转码/缩放/帧率、解析 `ffprobe` JSON 取宽高与时长、抽首帧作缩略图（QQ 视频消息发送必需） |
| `src/image.ts` | `getImageSize`、`detectFileType` | `image-size` 读缓冲区算宽高；`file-type` 按魔数识别类型（返回 `undefined` → `MediaError`） |
| `src/downloader.ts` | `downloadUrl`、`inferExtension`（内部 `assertDownloadUrlSafe`） | 下载原语：`fetch` + 大小上限（缺省 30MB）+ 超时（缺省 15s），**流式落盘**（临时文件 + rename，失败清理）；仅允许 http/https，手动跟随 30x（≤5 跳）且每跳复检，字面 IP 拒绝链路本地（含云元数据）/未指定/多播/保留段（环回与 RFC1918 放行，见该文件头）；从 URL pathname 推断扩展名。目录由本原语创建，清理由调用方负责 |
| `src/types.ts` | `ImageSize`、`FileTypeResult`、`AudioInfo`、`VideoInfo`、`DecodedAudio`、`TranscodeOptions`、`DecodeSilkToWavOptions`、`DownloadUrlOptions`、`MediaError` | 跨模块公共类型与统一错误类 |
| `src/index.ts` | 上述全部 | 包门面（唯一构建入口）：只做 re-export，不含逻辑 |
| `src/__tests__/audio.test.ts` | — | `audio.test.ts` 基线测试：锁定 `encodePcmToSilk` 的格式分派与 `MediaError` 失败路径；以 `vi.mock("execa")` 桩掉 `ffmpeg`，不依赖真实二进制 |

### 下载地址的归一化与兼容性

地址策略在 WHATWG `URL` 解析之后执行：IPv4 的整数、缩写、十六进制与八进制写法
统一按归一化后的 IPv4 判段；IPv4-mapped IPv6 的点分尾部、十六进制尾部、大小写与
压缩/展开写法统一为 `::ffff:h:h`，提取低 32 位并复用同一 IPv4 拒绝表。
原生 IPv6 继续拒绝未指定地址、`fe80::/10` 链路本地与 `ff00::/8` 多播，判断不依赖输入的压缩方式。
拒绝表中基准测试段为 `198.18.0.0/15`，文档示例段 `198.51.100.0/24` 独立列出，
避免错误掩码漏拦基准测试地址或扩大到相邻公网段。
每次重定向在发起下一跳请求前执行相同校验；环回、RFC1918、IPv6 ULA 与合法公网
维持放行（含其 IPv4-mapped 表达）。不新增 DNS 解析、域名策略或本地文件白名单；
流式写盘、全程超时、字节上限和失败清理契约不变。

## 构建与发布形态

产物为 **ESM + CJS 双格式**（`tsdown.config.ts`）：

- `dist/index.mjs`（ESM）+ `dist/index.cjs`（CJS），类型声明 `dist/index.d.mts` /
  `dist/index.d.cts`；`package.json` 的 `exports` 同时保留 `import` 与 `require`
  条件。
- **为什么必须双格式**（历史生产事故）：koishi 适配器发布形态是 CJS
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

## 测试布局

单元测试统一放 `src/__tests__/`（与 kernel/adapter 等包一致，避免测试文件与源码
同层平铺）。测试通过根 `vitest.config.ts` 的 `packages/*/src/**/*.test.ts` 发现，
相对导入下沉一层后仍保留 NodeNext 的 `.js` 后缀（`../audio.js`）。
