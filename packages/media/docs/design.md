# @napuketto/media 设计书

> 本包是**独立的媒体处理层**（ADR-011）：语音 SILK 编解码、视频探测与转码、图片/文件
> 类型识别、HTTP(S) 下载。kernel 严禁依赖本包；本包只被协议层 `@napuketto/adapter` 消费。
> 媒体能力属于协议语义，不属于原生交互，也不属于传输原语。

运行时和构建统一使用 Node.js 24.11.0 及以上版本，见[运行链路](../../../docs/architecture/runtime.md#nodejs-版本契约)。

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
| HTTP(S) 媒体下载 | `downloader.ts` / `public-download.ts` | Node 内建 `fetch`、HTTP(S)、DNS |

硬性边界（与 `docs/architecture/overview.md` 的依赖方向一致）：

- **无内部依赖**：`@napuketto/media` 不 import 任何 `@napuketto/*` 包。
- **只被 adapter 消费**：adapter 用 `encodePcmToSilk` / `decodeSilkToWav` /
  `transcodeVideo` / `downloadPublicUrl` / `downloadUrl` / `inferExtension`（见
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
| `src/downloader.ts` | `downloadUrl`、`downloadPublicUrl`、`inferExtension`、`DownloadUrlOptions`、`MediaOutboundPolicy` | 共享逐跳校验、流式落盘、超时（缺省 15s）、大小上限（缺省 30 MiB）和失败清理。创建目标目录，成功文件由调用方管理 |
| `src/public-download.ts` | 包内传输 | 绑定公网 DNS 校验与实际连接，逐跳直连并保留 TLS 主机认证 |
| `src/types.ts` | `ImageSize`、`FileTypeResult`、`AudioInfo`、`VideoInfo`、`DecodedAudio`、`TranscodeOptions`、`DecodeSilkToWavOptions`、`MediaError` | 跨模块公共类型与统一错误类 |
| `src/index.ts` | 上述全部 | 公开包门面，只做 re-export |
| `src/audio/` | — | 私有实现：SILK 帧扫描与限额、Worker 取消与退出等待、WAV 头与 PCM 块定位、PCM 归一化与安全写出 |
| `src/silk-worker.mts` | — | 随包构建的私有 Worker 入口，执行同步 WASM 编解码 |
| `tests/audio.test.ts` | — | `audio.test.ts` 基线测试：锁定 `encodePcmToSilk` 的格式分派与 `MediaError` 失败路径；以 `vi.mock("execa")` 桩掉 `ffmpeg`，不依赖真实二进制 |

### 下载地址的归一化与兼容性

地址策略在 WHATWG `URL` 解析之后执行：IPv4 的整数、缩写、十六进制与八进制写法
统一按归一化后的 IPv4 判段；IPv4-mapped IPv6 的点分尾部、十六进制尾部、大小写与
压缩/展开写法统一为 `::ffff:h:h`，提取低 32 位并复用同一 IPv4 拒绝表。
原生 IPv6 继续拒绝未指定地址、`fe80::/10` 链路本地与 `ff00::/8` 多播，判断不依赖输入的压缩方式。
拒绝表中基准测试段为 `198.18.0.0/15`，文档示例段 `198.51.100.0/24` 独立列出，
避免错误掩码漏拦基准测试地址或扩大到相邻公网段。
每次重定向在发起下一跳请求前执行相同校验；环回、RFC1918、IPv6 ULA 与合法公网
维持放行（含其 IPv4-mapped 表达）。

`downloadPublicUrl` 为只允许公网出站的调用方提供独立入口。每跳拒绝 URL 凭据和非公网字面地址，
并在 Node socket 的 lookup 中检查系统解析返回的全部地址。通过校验的地址交回同一次连接。
连接保留 URL 的 HTTP Host 和 HTTPS SNI/证书验证，逐跳直连，禁用连接复用和全局代理。
IPv4 含 mapped 地址复用兼容拒绝表后再拒绝环回和私网等特殊地址。IPv6 仅接受常规全局单播，
排除特殊前缀和过渡地址。内部路由和出口访问规则仍由部署环境约束。
`downloadUrl` 保留 LAN 兼容语义，`downloadPublicUrl` 执行公网策略。公开类型
`MediaOutboundPolicy` 定义 `public-only` 和 `compat`，供协议配置与嵌入方复用。
两个入口共用重定向、流式写盘、全程超时和失败清理。最终响应同时校验声明长度和实际写入量，
跳转响应直接关闭，最多跟随 5 次。公网入口请求 identity 编码，2xx 响应显式指定其他编码时主动销毁响应，保留原目标且不留下临时文件。

公网入口回归测试使用受控系统 DNS 结果和仅连接回环 HTTP 服务的传输夹具。下载器的 DNS 回调在实际连接查找阶段执行，空结果和混合地址在发送 HTTP 前拒绝，每次跳转都重新检查；字面非公网地址在解析与连接前直接拒绝。允许时核对请求编码、落盘字节和目录内容，拒绝编码时核对响应销毁及目标文件状态。

两个入口都允许调用者为初始源设置普通 GET 请求头（包括鉴权、自定义 API 头、Origin 和 Referer）。
传输和路由头由传输层管理，包括 Host、连接与消息分帧头、Proxy-*、Sec-*、Accept-Encoding、
Forwarded 和 X-Forwarded-*，调用者设置会被忽略。头名匹配不区分大小写。
同源跳转保留已接受的头，源按 scheme、主机和有效端口计算。跨源时清空所有调用者头，
以后即使跳回初始源也不会恢复。响应的 `headers.get(name)` 不区分大小写。

`inferExtension` 只从显式的媒体 MIME 类型表推断扩展名（忽略参数和大小写）。未知或畸形类型
回退到 URL 最后一个路径段的 1–5 位 ASCII 字母数字扩展名，再回退到 `.bin`。

## 外部媒体进程与资源边界

`MediaOutputOptions.maxOutputBytes` 可收紧视频转码和抽帧的硬上限，写入 FFmpeg 输出时逐块校验。
`SilkEncodeOptions` 使用同一字段限制归一化 PCM 与 SILK 的累计写入量，各自仍受固有硬上限。
PCM 读入后先清除，再写 SILK。调用方可指定独占的 `outputPath`，从已有受控输入转码，
并通过 `onPcmWritten` 获取中间 PCM 字节数。上限允许零字节，实际输出超额抛 `MediaSizeLimitError`，
中止 FFmpeg 并清理部分产物。下载使用同一错误类型报告声明或流式字节超限。

- 所有 ffmpeg/ffprobe 使用共同进程选项：探测 15s、抽帧 30s、音频归一化 120s、
  视频转码 300s；超时先 SIGTERM，1s 后强杀，等待进程退出后清理。禁用交互 stdin，
  FFprobe stdout 与进程 stderr 各限 1 MiB，FFmpeg 的媒体 stdout 按实际写入量单独限额；
  spawn、超时、非零退出及缺失/空输出均为 `MediaError`。
- 输入只接受当前平台可解析的本地普通文件（相对路径、绝对路径及指向普通文件的符号链接）；
  拒绝 URL/协议表达式、Windows UNC/设备路径、目录与管道。传给工具的路径统一绝对化，
  避免连字符文件名被解析成选项。Windows 盘符路径按平台处理。
- 每个输入前设置 `protocol_whitelist=file`，不放行 pipe、http(s)、tcp、tls、concat 等协议；
  demuxer 白名单限定常见独立容器/音频（mov/mp4、matroska/webm、avi、flv、asf、mpeg/ts、
  ogg、wav、mp3、flac、aac、amr、aiff、ape、ac3/eac3、dts、au），不接受 HLS/DASH、
  concat、SDP 或图片序列。MOV 外部轨道保持 FFmpeg 默认禁用（专属选项不能传给其他
  demuxer，否则 WAV 等输入会报 option not found）。依据 FFmpeg 官方
  [协议选项](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options) 与
  [格式选项](https://ffmpeg.org/ffmpeg-formats.html#Format-Options)。
  **这不是本地文件隔离**：file 白名单不能限制读取目录，符号链接、挂载盘与宿主权限仍有效；
  不引入允许目录契约或操作系统沙箱，部署需以受限账号运行。播放列表不再作为媒体输入支持。
- `transcodeVideo` 返回输入同目录独占临时目录内的真实非空 `.mp4`，绝不覆盖输入或已有
  同名 `.mp4`；失败（含超时）删除整个目录。成功后所有权交给调用方：消费结束后删除
  返回文件及其父临时目录，不能提前清理。Satori 的 `message.create` 在转换前建立请求级
  所有权集合，成功转换即登记，在转换/发送结束（含失败）后统一清理。独立使用转换器时
  调用方通过 `onVideoTranscoded` 接管清理；未提供时必须自行清理返回路径。抽帧先写
  独占目录，成功后 rename 到调用方给定路径，失败保留旧目标；缩略图仍由
  `prepareVideoElements.cleanup` 发送后清理。
- 图片尺寸最多读取 512 KiB，魔数检测最多读取 1 MiB。类型或尺寸信息超出探测窗口而无法识别时返回
  `MediaError`。图片尺寸读取只解析头部元数据，不执行整图解码。
- 公开常量 `MAX_AUDIO_INPUT_BYTES`（32 MiB）、`MAX_AUDIO_SECONDS`（600s）与
  `SILK_SAMPLE_RATE`（24 kHz）供嵌入方共用。SILK 元数据逐块计帧并校验包边界。
  解码支持 8、12、16、24、48 kHz，输出最多 600s 的单声道 16-bit PCM，WAV 额外写 44 字节头。
  按实际解码后字节及库报告的时长判断，包含编解码器填充。压缩音频按头部识别，
  由 FFmpeg 归一化成 24 kHz 单声道 PCM，实际输出在写入前按 28,800,000 字节逐块限制。
  未在头部窗口内识别为单声道 16-bit PCM 的 WAV 也经 FFmpeg 归一化。
- SILK 编解码在独立 Worker 执行，最长 30s。超时和取消等待 Worker 退出；外部进程同样等待退出
  后再清理。公开音视频入口接受可选 `AbortSignal`；取消和预算失败以 `MediaError` 报告。
  音频文件先写同目录独占临时文件再原子换名，提交前失败保留原目标，成功产物由调用方删除。
  下游接收侧用每次调用独占的 `outDir` 避免重名，播放器或上传方完成消费后再删除文件和目录。
- 视频用有限大小的 FFprobe 输出核验主视频流的尺寸、帧率与时长。输入至多 128 MiB，
  视频至多 600s、60 fps、单边 4096、8,294,400 像素；整段转码另限 18,662,400,000 像素帧。
  转码宽高须为偶整数 [2, 4096]，单边缺省保持比例并在运行前检查推导尺寸。帧率须为
  [1, 60] 的有限数。FFmpeg 限制单次分配、流数、解码像素及处理线程，实际转码帧数在
  输出端复核。H.264/AAC 分片 MP4 经管道逐块写入，上限 128 MiB，PNG 抽帧上限 16 MiB。
  显式帧率在视频过滤器中换算，H.264 禁用 B 帧以减少分片输出的时戳偏移。
  达到停止哨兵、输出为空、输出校验失败或超限时删除部分文件。分片 MP4 需要支持该封装的播放端。
  FFmpeg 需要稳定、可寻址的输入文件，协议层使用已取得的缓存副本。预检文件大小以启动前的状态为准。
  这些是每次操作的预算，进程总内存和并发容量由部署环境管理。

## 构建与发布形态

- tsdown 从 `src/index.ts` 构建 `dist/index.mjs`，并构建独立的 SILK Worker 入口。包级 `tsconfig.json` 开启
  `isolatedDeclarations`，tsdown 使用 Oxc 生成 `dist/index.d.mts`。
- `exports` 的 `types` 和 `default` 分别指向声明和 ESM 入口。CJS 消费方通过
  Node.js 的 `require(esm)` 加载同一个 ESM 入口。
- `execa`、`file-type`、`image-size` 和 `silk-wasm` 通过 `dependencies` 安装，
  由 tsdown 保持 external。

## 测试布局

单元测试统一放包根 `tests/`（镜像 `src/` 子目录结构，避免测试文件与源码同层平铺）。
测试通过根 `vitest.config.ts` 的 `packages/*/tests/**/*.test.ts` 发现，相对导入
仍保留 NodeNext 的 `.js` 后缀（如 `../src/audio.js`）。
