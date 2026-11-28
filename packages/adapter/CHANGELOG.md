# @napuketto/adapter

## 0.26.1

### Patch Changes

- Updated dependencies [7834465]
  - @napuketto/kernel@0.19.8

## 0.26.0

### Minor Changes

- 52c92ee: OB11 支持按账号配置消息媒体项数和累计字节预算，统一约束本地快照、下载、缓存引用以及转码和缩略图，并为嵌入调用方提供媒体准备统计。IPC 动作桥与 CLI 配置校验采用同一预算配置。媒体包允许调用方收紧 SILK、视频转码与抽帧的输出字节上限。

### Patch Changes

- Updated dependencies [52c92ee]
  - @napuketto/media@0.5.0

## 0.25.0

### Minor Changes

- 17197b5: 为群空间 WebApi 的精华分页和荣誉查询加入 HTTP 期限、正文上限和可选取消信号。
  Webhook 按目的地址串行投递，限制等待事件与正文总量，默认从提交起 5 秒超时，关闭丢弃待发送事件并取消在途请求。
  WsClient 入站消息默认限制为 32 MiB，独立 WsServer 关停发送 1001 并在 250 ms 宽限期后终止剩余连接。
  直接使用 HttpClient 的调用方可配置正整数 `timeoutMs` 并用 `onError` 观察拒收，关闭后调用 `open()` 恢复。
  直接使用 WsClient 且业务确需大于 32 MiB 单条消息时，可配置 `maxPayloadBytes`。

### Patch Changes

- Updated dependencies [17197b5]
  - @napuketto/kernel@0.19.7
  - @napuketto/network@0.6.0

## 0.24.6

### Patch Changes

- 8c38d3b: 隔离群缓存失效前后的异步回填，防止退群、停用和软重登后旧请求污染新状态。OB11 和 Milky 会清理失效的群精华同步任务并合并同群触发，队列满时由后续更新事件补拉。
- Updated dependencies [8c38d3b]
  - @napuketto/kernel@0.19.6

## 0.24.5

### Patch Changes

- cbccf58: 消除重复类型守卫、强拆的二级 switch 与一次性微函数（零运行时行为变更）：
  
  kernel 新增 `hasNullableStringProp` / `hasNullableNumberProp` / `hasOptionalStringProp`，
  群成员守卫收敛为单一实现；adapter 与 cli 改用统一守卫。milky segments、sysmsg 解码、
  satori 解析与 OB11 段守卫收敛为单一 switch；probe / log-format / loader 稳定结构改为具名接口。
- Updated dependencies [cbccf58]
  - @napuketto/kernel@0.19.5

## 0.24.4

### Patch Changes

- 7ef349d: 内部路径脱敏重命名（零行为变更、零对外 API 变化）：
  
  - loader 产物链目录 `src/qq/` → `src/artifacts/`，版本清单形状模块
    `manifests/qq-releases.ts` → `manifests/releases.ts`；包根清单
    `qq-releases.json` → `releases.json`（`files` 白名单同步）。
  - CI 更新脚本与 workflow 更名：`tooling/qq-releases/` → `tooling/releases/`、
    `update-qq-releases.yml` → `update-releases.yml`（日志前缀与分支名同步）。
  - adapter 包内私有目录 `src/internal/qq/` → `src/internal/domain/`，与
    `internal/infra/` 形成 `domain / infra` 对仗。
  
  导出的符号、类型、`@deprecated` 别名与 `package.json#exports` 均保持不变。

## 0.24.3

### Patch Changes

- 0c75301: fix: 群聊 at 段目标不再被 QQNT 归零为 `"0"`（issue #192）
  
  QQNT `TextElement` 的 at 目标分两个字段：`atNtUid` 是 `u_...` NT UID（QQNT 解析真实
  提及依赖它），`atUid` 只是数字 UIN 的镜像（写入非数字会被 wrapper 归零成 `"0"`）。
  发送方向单人 at 改为把目标写进 `atNtUid`（纯数字目标才写 `atUid`），`content` 统一归一
  为带 `@` 前缀的显示文本，`@全体` 按原生形态发 `atType=1` + `atNtUid="all"`；接收方向
  优先读 `atNtUid`，仅在缺失时回退到非空且非 `"0"` 的 `atUid`，两者都无效时降级为普通
  文本，不再把 `"0"` 传给 uid→uin 转换（`getUinByUids` 的 `Data Not Existed!`）。
  OB11 发送侧对 `u_...` 目标直通（不重复调 `uinToUid`），群聊 at 缺 `name` 时用群成员
  缓存补群名片/昵称作 `display`。
- Updated dependencies [0c75301]
  - @napuketto/kernel@0.19.4

## 0.24.2

### Patch Changes

- Updated dependencies [a11f079]
  - @napuketto/kernel@0.19.3

## 0.24.1

### Patch Changes

- 2b35549: fix: 图片发送写入真实尺寸与格式（手机端空白修复）
  
  kernel 的 `prepareImageElement` 不再把 `picWidth` / `picHeight` 硬编码为 0、`picType`
  硬编码为 1000：优先使用 canonical `size` / `mime`，缺失时由 `apis/image-meta.ts`
  零依赖解析 PNG / GIF / BMP / WebP / JPEG 文件头补齐，并按 MIME/扩展名映射 NTQQ
  picType（PNG 1001、WebP 1002、BMP 1005、GIF 2000、JPG 1000）。adapter 侧新增
  `prepareImageElements`，在 OB11 / Milky / Satori 发送链路用 `@napuketto/media` 预填
  `size` / `mime`，探测失败 warn 降级不阻断发送。
- Updated dependencies [2b35549]
  - @napuketto/kernel@0.19.2

## 0.24.0

### Minor Changes

- bd46334: refactor(brand)!: 品牌与仓库名去掉 QQ 后缀，统一为 `Napuketto`
  
  - 品牌面（全部包）：仓库、镜像、脚手架与文档统一为 `Napuketto` —— 仓库 `NapukettoDev/Napuketto`、镜像 `ghcr.io/napukettodev/napuketto`；npm 脚手架改名为 `create-napuketto`（`pnpm create napuketto`），其在 monorepo 内的目录同步改为 `apps/create`。
  - 协议自报实现名（`@napuketto/adapter`）：统一为 `napuketto` —— OneBot 11 `get_version_info.app_name`、Milky `get_impl_info.impl_name`、KuroBot `hello.client` 缺省 `napuketto/<版本>`。
  - CLI 与模板（`@napuketto/cli`）：启动 banner 去掉 `QQ` 字符画、`napuketto.toml` 模板标题与 KuroBot `client` 示例文案同步为 `Napuketto` / `napuketto`。
  - 包元数据（其余包）：`description` / `homepage` / `bugs` / `repository` 指向新仓库名，`keywords` 移除品牌相关 `qq`（保留 `qqnt` 平台关键词）。
  - 保持不变（运行契约）：QQ NT 原生文件名与安装路径（`QQ.exe` / `QQNT.dll` / `wrapper.node` / `/opt/QQ` / `nt_qq`）、各协议 `qq` 字段、`napuketto.toml` 的 `qq` 字段、`-q` / `--qq-path` 参数与 `NAPUKETTO_QQ_*` 环境变量。

### Patch Changes

- Updated dependencies [bd46334]
  - @napuketto/kernel@0.19.1
  - @napuketto/media@0.4.1
  - @napuketto/network@0.5.1

## 0.23.1

### Patch Changes

- Updated dependencies [b6124d4]
  - @napuketto/kernel@0.19.0

## 0.23.0

### Minor Changes

- f478aab: 限制媒体探测、SILK、视频转码和 Milky Base64 媒体的输入与产物，支持通过 AbortSignal
  取消音视频处理，等待后台工作退出并清理临时文件。视频转码产出分片 H.264/AAC MP4，
  缩放宽高接受 2–4096 的偶整数，帧率接受 1–60。Milky Base64 接受标准和 URL-safe
  载荷及省略填充，载荷中的空白和无效字符会被拒绝。富媒体 MD5 改为分块读取。

### Patch Changes

- Updated dependencies [f478aab]
  - @napuketto/media@0.4.0
  - @napuketto/kernel@0.18.1

## 0.22.0

### Minor Changes

- da84db0: 贯通群邀请和申请的队列与审批引用，新增 IPC 群请求事件和受限审批动作。修复 Satori 历史分页的游标和页尾判断，明确撤回消息的 ID 空间，并区分好友的 UID 与可空 UIN。

### Patch Changes

- Updated dependencies [da84db0]
  - @napuketto/kernel@0.18.0

## 0.21.1

### Patch Changes

- Updated dependencies [cde973b]
  - @napuketto/kernel@0.17.0

## 0.21.0

### Minor Changes

- f572475: 默认隔离 OB11（含 IPC）、Milky 和 Satori 的调用方本地媒体。需要读取共享文件的集成可在
  对应账号协议的 `media.localMediaRoots` 列出导出目录。QQ 媒体查询和下载返回具有账号与协议归属、
  带有效期的缓存路径，旧缓存路径请重新获取。Satori 仅接受当前账号已发布的内部缓存引用。

## 0.20.0

### Minor Changes

- 5966a5e: 协议媒体下载默认仅允许公网。OneBot 11（含 IPC 动作桥）、Satori 和 Milky 的受信任 LAN 部署可在对应账号协议段的 `media.outboundPolicy` 设为 `compat`。IPC 动态注入需使用支持该配置的 adapter。
  
  `downloadUrl` 保留 LAN 兼容下载，`downloadPublicUrl` 支持首跳及同源重定向的自定义请求头。两者忽略传输及路由头并在跨源后清空调用者请求头。公共扩展名推断使用 MIME 白名单，响应头查询忽略大小写。

### Patch Changes

- Updated dependencies [5966a5e]
  - @napuketto/media@0.3.0

## 0.19.0

### Minor Changes

- 75d9b18: F-03 同端口 Upgrade 钩子须同步选择接受或拒绝。未匹配、拒绝及决策异常会收到 HTTP 响应，随后关闭连接。Milky 继续在 `/event` 完成鉴权和握手。
  
  F-04 OneBot 11、Satori 和 Milky 的已启用非回环监听要求有效 token。部署请替换空白和占位 token 并同步客户端。可信本机部署可绑定数值回环后免鉴权。
  
  F-13 请求和传输失败日志使用固定错误类别、路由模板或配置索引。鉴权解析失败回调改为无参通知。

### Patch Changes

- Updated dependencies [75d9b18]
  - @napuketto/network@0.5.0

## 0.18.22

### Patch Changes

- e9ea614: Add the Loader IPC action `msg.addReaction` for QQ system emoji reactions on native message IDs. Resolve the message sequence in the requested conversation for both IPC and the Satori reaction actions.
- Updated dependencies [e9ea614]
  - @napuketto/kernel@0.16.4

## 0.18.21

### Patch Changes

- Updated dependencies [4340a0f]
  - @napuketto/media@0.2.3

## 0.18.20

### Patch Changes

- Updated dependencies [d1d85ae]
  - @napuketto/kernel@0.16.3

## 0.18.19

### Patch Changes

- 2169832: 修复 M-01 WebSocket 可靠性。启用心跳时以匹配的 pong 判活，超时即回收连接。WS 文本发送按连接检查缓冲上限，超限立即断开且不重放；Satori 仍只向已认证连接推送，Milky 的 WS 事件也受同一上限保护。
  
  `WsClient` 首次自动重连仍等待 `delayMs`，后续连续失败使用有上限的指数退避与抖动。`maxAttempts` 保持有效，连通后重置，显式关闭会取消待重连和进行中的握手。
- Updated dependencies [2169832]
  - @napuketto/network@0.4.5

## 0.18.18

### Patch Changes

- d7ede96: 修复 Milky base64 文件扩展名缺点号；三协议采用独占媒体缓存目录、动作级使用租约、TTL 和容量拒绝策略，发送后及失败时清理临时文件，保护 OB11 返回路径的 24 小时引用期，避免误删用户/QQ 文件与同名下载覆盖。

## 0.18.17

### Patch Changes

- Updated dependencies [893bbdd]
  - @napuketto/kernel@0.16.2

## 0.18.16

### Patch Changes

- 37087d5: 修复 H-02：媒体外部进程增加超时、强制终止与失败清理；限制本地输入协议和独立媒体格式，拒绝播放列表与协议输入。视频转码返回独占目录中的输出，避免覆盖源文件或已有 MP4，成功产物由调用方消费后清理。音频增加输入、时长及归一化 PCM 字节上限，防止下载后解码膨胀；保留 Satori 的 MP4 直通及转换失败回退行为。
- Updated dependencies [37087d5]
  - @napuketto/media@0.2.2

## 0.18.15

### Patch Changes

- 8e15df9: 协议 token 统一使用固定长度摘要与 timingSafeEqual 比较，覆盖 Bearer、裸头、查询参数及 Satori IDENTIFY，安全处理不同长度和 Unicode；修复 OB11 裸 Authorization 头大小写不一致，保留空 token、前缀与回退语义。此项为鉴权原语加固，不代表已证实存在可远程利用的时序攻击。
- Updated dependencies [8e15df9]
  - @napuketto/kernel@0.16.1

## 0.18.14

### Patch Changes

- 2ff0da0: 修复 Milky 活跃 SSE/WS 导致的关闭阻塞；HttpServer 有界回收普通请求、流式连接及同端口升级资源，重复关闭安全。监听失败 reject 并支持清理后重试；落实普通请求 timeoutMs（504），首次响应生效，迟到/重复 respond 忽略，同步处理及序列化异常回 500。流式响应不受普通请求超时影响。
- Updated dependencies [2ff0da0]
  - @napuketto/network@0.4.4

## 0.18.13

### Patch Changes

- Updated dependencies [5ff7ae3]
  - @napuketto/media@0.2.1

## 0.18.12

### Patch Changes

- 401918f: 修复 Linux 3.2.x 原生 `wrapper.node` 入站消息元素显式 `null` 导致的空值崩溃（OneBot 11 收不到 message 事件 / `send_group_msg` / `get_group_msg_history` 报 `retcode 999`）：
  
  - kernel：`picLocalCandidates`、全部 `*ToCanonical`、`readVideoThumbPath`、`emptyToUndefined` 与 `pttDownloadResult` / `findPttElement` / `findForwardElement` 统一改为 `== null` / `!= null`（同时兼容 Windows 的 `undefined` 与 Linux 的 `null`）。
  - kernel：`pic-path-grace` 只处理 `elementType === PIC` 且 `picElement != null` 的元素；`MsgBridge.emitPicAware` 对 `hasPendingPicPaths` 增加异常隔离，单条畸形元素不再阻断整批 `channel.emit`。
  - kernel：`RawElement` / `GrayTipElement` 及其子元素的可选字段扩展为 `T | null`，让编译器持续拦截同类漏网读取（类型面为扩展，读取方需按空值收窄）。
  - adapter：同步修复 grayTip uid 收集、Milky 群成员变动/文件/转发、OB11 get_record / group_upload / notice 等处的 null 读取。
- Updated dependencies [401918f]
  - @napuketto/kernel@0.16.0

## 0.18.11

### Patch Changes

- 691fea6: 媒体下载路径收敛与出站加固（对应安全审计 C-02 的下载面）：
  
  - `downloadUrl` 改为**流式落盘**（同目录临时文件 + 原子 rename，失败清理），内存占用不随文件大小增长；超时覆盖重定向与读 body 全过程。
  - 仅允许 `http`/`https`；手动跟随 30x（上限 5 跳）且**每一跳重新校验**，阻断「首跳合法、跳转内网」。字面 IP 目标拒绝链路本地（含 `169.254.169.254` 云元数据）、未指定、多播与保留段；环回与 RFC1918 私有段保留（自建 LAN 媒体服务/本机渲染服务是受支持部署形态）。
  - 新增 `headers` 透传选项。adapter 的 `downloadBufferToFile` 不再裸 `fetch` + `arrayBuffer()`（无超时、无大小上限，超大响应可直接打爆堆），统一走该原语。
  - Satori `resolveAsset` 修复 URL 尾段为 `..` / `.` 时文件名逃出缓存目录的问题（回退 `asset-<时间戳>`）。
  
  已知边界：本层不解析域名（DNS rebinding 由部署侧网络策略兜底）；本地文件路径白名单需要协议配置契约，留待后续单独变更。
- Updated dependencies [691fea6]
  - @napuketto/media@0.2.0

## 0.18.10

### Patch Changes

- 1ac012f: 修复 Satori WS 事件服务越权泄露：配了 `token` 时，未认证连接此前仍会收到全部 `EVENT`
  （token 校验失败只是「不响应」，连接保持 OPEN 并留在广播集合里）。
  
  - Satori 新增 `SatoriEventHub`：接管 wsServers 的 `send`/`open`/`close`，只向完成
    `IDENTIFY` 的连接广播事件；token 不符或连接建立后 10s 内未 `IDENTIFY` 以 close code
    `4004` 断开。token 为空仍表示不鉴权（连接即视为已认证）。
  - `WsServer` 新增 `onConnection` 钩子，并把连接作为 `onRequest` 第三参透传，供
    「连接后才认证」的协议登记认证状态（可选能力，向后兼容）。
- Updated dependencies [1ac012f]
  - @napuketto/network@0.4.3

## 0.18.9

### Patch Changes

- Updated dependencies [cd2694e]
  - @napuketto/kernel@0.15.4

## 0.18.8

### Patch Changes

- b68326b: 修复 Docker 部署下登录成功却秒退（issue #144）：
  
  - boot 进程透传 self-host 的异常退出码（含 78），supervisor 的「配置失败免重启」恢复生效；
  - 正向 WS 对端未启动/不可达时不再拖垮宿主，warn 后按 `reconnectDelayMs` 后台退避重连；
    Docker Compose 补齐 `host.docker.internal:host-gateway` 映射；
  - 引导/协议装配致命错误同步输出到 stderr（含 `napuketto-boot.log` 路径，不污染 IPC stdout JSON）；
  - supervisor 对运行不足 30s 的连续秒退按指数退避（60s 封顶）重启，稳定运行后计数清零。

## 0.18.7

### Patch Changes

- Updated dependencies [65c0d70]
  - @napuketto/kernel@0.15.3

## 0.18.6

### Patch Changes

- 8e2e220: 规范化 npm 发布元数据（仅 `package.json` 元信息，无运行时改动）：五个包统一补齐 `$schema`、
  `keywords`、指向包内 README 的 `homepage`、`bugs`，`repository` 补上 `directory`，`author`
  改为结构化对象；`description` 统一为英文并补全语义（`loader` 原中文描述改写为英文，与其余四个包一致）。
  `adapter` 的 `exports` 与 `tsdown.entry`、`loader` 的 `files` 只调整键序，条目集合不变。
  
  导出子路径、依赖声明与包版本均未变化，按 patch 发布，刷新 registry 上的描述 / 关键词 / 仓库链接。
  `tooling/package-exports.test.ts` 的子路径白名单断言同步改为集合比较，不再把 `exports` 键序当契约。
- Updated dependencies [8e2e220]
  - @napuketto/kernel@0.15.2
  - @napuketto/media@0.1.4
  - @napuketto/network@0.4.2

## 0.18.5

### Patch Changes

- 4451df9: 按可见性轴重整包内分层：`src/core/` → `src/framework/`（公开契约层，仍以子路径 `@napuketto/adapter/core` 导出），`src/shared/` → `src/internal/{qq,infra}/`（包内私有，无 barrel）。
  
  - `framework/` 与 `internal/` 物理隔离公开 SDK 与私有实现；`dist/core/index.mjs` 产物路径不变（tsdown 对象 entry 映射），loader 与外部消费方零改动
  - 边界由 biome `noRestrictedImports` 强制：`framework/**` 不得 import `internal/**`
  - 嵌入式 DX 契约测试从 `src/__tests__/` 迁至 `tooling/embedded-dx.test.ts`：它断言 dist 产物、与 `package-exports.test.ts` 同属产物契约测试，不再按「包内模块单测」口径被误读（本地跑测试前须 `pnpm -r build`）
  - 纯内部重构，导出符号与子路径集合不变

## 0.18.4

### Patch Changes

- b6d975e: 群精华列表缓存与串行 diff 同步器下沉 kernel 缓存层（ADR-028）：`@napuketto/kernel` 新增
  `EssenceListSync` / `diffEssenceList` / `narrowEssenceGroupArg` 及 `EssenceAddedItem` /
  `EssenceCacheEntry` / `EssenceDiffResult` / `EssenceListSyncDeps` 类型导出
  （`src/cache/essence-cache.ts`）；`@napuketto/adapter` 的 `shared/essence.ts` 只保留
  `extractEssenceSetSysMsg`，OB11 / Milky 的事件语义与日志口径不变。
- Updated dependencies [b6d975e]
  - @napuketto/kernel@0.15.1

## 0.18.3

### Patch Changes

- 52d0a72: 收链路共享原语收敛：`shared/uid-uin` 新增 `collectGroupNotifyUids` 与
  `resolveUidToUinWithFallback`（批量 `uidToUin` + 前 10 条资料详情兜底，OB11 / Milky
  `enrichment` 共用），`shared/buddy-req` 新增 `processInboundBuddyReqs`（unreadNums 短路 →
  收窄 → 可处理性过滤 → 去重入口管线）。OB11 / Milky 的事件语义与日志口径不变。

## 0.18.2

### Patch Changes

- ce3ebd7: `core` 新增协议层 Token 鉴权原语 `createTokenAuthorize` / `matchTokenCredential`，
  参数化支持 Bearer 头、OB11 裸 `authorization` 头与 OB11 / Milky 的 `?access_token=`
  查询参数；OneBot 11、Milky、Satori 的 transport 改为复用该原语，对外鉴权方言不变。

## 0.18.1

### Patch Changes

- 705f2f9: 运行时边界硬化（审计复核后的真实缺陷）：
  
  - kernel：`DoubtFriendRequestInfo.uin` 改为可选——uid 无法解析为正整数 uin 时不再产出
    NaN（JSON 序列化会变 null），`get_doubt_friends_add_request` 不再返回假 uin。
  - kernel：`createSession` 的 `new Session` 与 `initSession` 的 `session.init` 增加调用点
    可调用性检查，wrapper 导出漂移时抛 `KernelError` 而非裸 TypeError；`create()` 返回值
    同样过 session 方法面守卫。
  - adapter：`ProtocolConfigInput` 去掉 `| Record<string, unknown>` 逃生舱，避免任意对象
    绕过 `Partial<TConfig>` 约束（别的协议的 ConfigBase 也能塞进来）。
  - cli：`config validate` 对非空协议段执行与 loader 装配同 schema 的 zod 校验（空段 =
    不启用，跳过），消除「校验通过但启动 exit 78」的假承诺。
- Updated dependencies [705f2f9]
  - @napuketto/kernel@0.15.0

## 0.18.0

### Minor Changes

- 2098f16: 二阶段类型安全清零：原生反射边界（wrapper / loader / network）与全仓残余断言改用运行时类型守卫。
  
  - kernel：`type-guards` 扩展（`isCallable` / `getOwnProp` / `hasMethodSurface` / `getErrorCode` 等），新增 `wrapper/wrapper-guards`；`wrapper-loader`、`session-resolver`、`probe/**` 零断言；`GroupMember` / `EssenceMsgItem` 的非保证字段改为可选并在守卫中逐字段校验；`login-bridge`、`event-channel`、`msg` / `recent-contact` / `profile`、日志与配置解析同步清零。
  - loader：新增本地 `type-guards` / `module-guards`，动态 `import()` 结果与 IPC 反射调用全部运行时校验；`CoreContextLike` / `KernelServices` 补齐精确结构，删除下游强转；diagnostic `sessionCall` 拦截 `onLine` / `wifiphoto` 危险方法。
  - network / media：`JSON.parse` 与原生 server 收窄改守卫；ffprobe 输出安全构造。
  - adapter / apps：`buddy-req` / essence / milky / kurobot / OB11 请求分发与 CLI 配置解析改用守卫，畸形载荷安全降级。

### Patch Changes

- Updated dependencies [2098f16]
  - @napuketto/kernel@0.14.0
  - @napuketto/network@0.4.1
  - @napuketto/media@0.1.3

## 0.17.1

### Patch Changes

- 018c721: 清理全仓「虚假类型安全」：以类型守卫 / 可辨识联合 / 泛型容器替换 `as unknown as`、
  `as never` 与整值强转（公共 API 签名与返回字段名零破坏）。
  
  - kernel：新增 `utils/type-guards.ts`（`isRecord` / `has*Prop` / `requireKernelService`）
    并对外导出；`NodeIQQNTWrapperSession.get*Service()` 按各 Service 接口精确收窄
    （`NodeIKernel*Service | null`），14 处会话服务取用改走 `requireKernelService`
    校验空句柄与方法面；`LoginProgress` / `MilkyActionResult` / `ActionResult` 重构为
    可辨识联合（属性名不变）；群详情 / 成员 / 通知 / 群文件 / 精华消息 / 登录服务
    全部走元素级守卫与 `isRecord` 收窄；`GroupCache` 的 in-flight 去重按返回类型
    拆分为三个精确容器；`fetchQunJson` 响应体先收窄再取字段；cookies 超时/网络
    失败统一抛 `kernelError`（`TIMEOUT` / `UNKNOWN`）。
  - adapter：OB11 入站 segment 新增 `isOB11MessageSegment` / `parseOB11MessageSegments`
    严格校验（`[null]`、缺必填字段、未知类型均抛 `INVALID_PARAM`），
    `canonicalToSegment` / `segmentToCanonical` 改为可辨识联合 `switch`；Milky 发送段
    以 `RawOutgoingSegment` + 字段守卫替代 `ZodType` 强转，已知段缺字段抛
    `INVALID_PARAM`、forward 内嵌段逐项校验；`forEachRawMessage` 逐条过
    `isRawMessage`；Satori WS 信令与 `has*` 守卫收窄。
  - cli：`runtime.json` / `supervisor.json` 读取改为严格形状守卫（损坏/旧格式返回
    null）；二维码标记行与 `CliConfig → TOML` 显式映射，移除整值强转与
    `NodeJS.ErrnoException` 强转。
- Updated dependencies [018c721]
  - @napuketto/kernel@0.13.1

## 0.17.0

### Minor Changes

- d11321f: 嵌入式 SDK 体验（DX）收口：补齐 Public API 导出与 `ProtocolConfig` 兼容导出，新增 `createKernelRuntime` 服务聚合与 `NapukettoCore.activateSession/createRuntime`，支持 Plain Object 协议配置与可选 `broadcaster`，并修复定时器/原生监听器泄漏、异步监听异常逃逸与幂等 `dispose()` 生命周期。

### Patch Changes

- Updated dependencies [d11321f]
  - @napuketto/kernel@0.13.0
  - @napuketto/network@0.4.0
  - @napuketto/media@0.1.2

## 0.16.4

### Patch Changes

- fdd3834: 重构：全仓架构与依赖拓扑解耦（零公共 API / exports 契约破坏）。
  
  - kernel：`LogLevel` 下沉至 `infra/log-config.ts`、`waitFor/sleep` 下沉至
    `infra/wait.ts`（`login/wait.ts` 与 `types/message-element.ts` 保留桥接重导出）；
    消息元素运行时转换迁入新 `codec/message-element.ts`（类型层不再 import `node:fs`）；
    新增自建宿主原生引导原语 `dlopenWrapper` / `activateO3MiscService` 并对外导出。
  - adapter：kurobot / onebot11 契约下沉到 `types.ts`、`api/onebot-api.ts` 消除类型环；
    远程下载与 `file://` 解析统一收口到 `shared/media.ts`（异步落盘，移除同步阻塞 I/O）；
    协议内部统一经 `core/index.js` 与各子域 `index.ts` 消费。
  - loader：`QqInstallInfo` 一族与 `KernelServices` 下沉到 `qq/qq-types.ts` /
    `host/types.ts`，消除 qq 与 host 的目录环；IPC 契约统一经 `host/ipc/index.js` 出口。
  - cli：`config/store.ts` 改为注入式日志回调，解除 `config/ <-> logger.ts` 双向值依赖。
- Updated dependencies [fdd3834]
  - @napuketto/kernel@0.12.3

## 0.16.3

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
- Updated dependencies [1ed167a]
  - @napuketto/kernel@0.12.2
  - @napuketto/media@0.1.1
  - @napuketto/network@0.3.2

## 0.16.2

### Patch Changes

- 7784ce1: 修复启动 / 重连时把历史消息与旧好友申请当实时数据上报（issue #122）。
  
  消息侧：登录 / 重连时 QQNT 会把离线与历史消息全量同步进 `Msg/onRecvMsg`，
  此前直接上报，下游会误回复几天甚至几周前的消息。现在统一在
  `shared/raw-message.ts` 的 `subscribeRawMessages` 里按订阅时刻（−5s 容差）过滤，
  四个协议共用同一入口（satori / kurobot 此前连共享封装都没走，本次一并切换）。
  `msgTime` 缺失或非法时放行，宁可多报不错杀。
  
  好友申请侧：`Buddy/onBuddyReqChange` 在登录 / 重连 / 审批后会整批重放历史申请，
  而收链路没有任何过滤——下游开启自动同意会陷入「全量重放 → 自动同意 → 触发回调 →
  再次全量重放」的死循环。现在只推实时待处理项：
  
  - 过滤 `isInitiator=true`（自己发起）、`isUnread=false`（已读）、`unreadNums=0`、
    `isDecide=true`（reqType 13 `KMEINITIATORWAITPEERCONFIRM` 除外）与
    `reqTime` 早于启动基准的历史积压；批级 `unreadNums=0` 整批短路。
  - 剩余项按 `${friendUid}:${reqTime}` 做实例级去重（上限 512 条，跨
    `reloadTransports` 保留）。
  - `comment` 改取 QQNT 实际字段 `extWords`（空则回退 `words`）——此前恒为空串。
  - 陌生人 `user_id` 不再恒为 0：群成员口径（`GroupApi.uidToUin`）查不到时回退
    kernel 新增的 `ProfileApi.getUinByUid`（`getUserDetailInfo` 反查 `detail.uin`，
    fail-soft，单批上限 10 次），OB11 与 Milky 两侧共用。
  
  字段判定一律「存在且明确」才生效：这些原生字段名仍是说明书参考，缺字段时放行而不是
  静默丢申请。
- Updated dependencies [7784ce1]
  - @napuketto/kernel@0.12.1

## 0.16.1

### Patch Changes

- b0e527c: adapter 跨平台不变量修复（Linux 原生宿主兼容）与生命周期边界加固。
  
  时间归一：全部 `msgTime` 换算收敛到 `shared/raw-message.ts` 的 `toUnixSeconds`
  （Windows 毫秒 / Linux 秒按量级自动识别），覆盖 milky 的 api / seq-index /
  message-query / 事件翻译 / friend_file_upload 与 satori 的 `created_at` /
  `timestamp`（Satori 规范毫秒级，归一后换算）——此前 Linux 秒级样本会被二次
  除 1000 退化成 1970。
  
  元素判空：变体字段存在性判定统一 `== null`（Linux 3.2.x 原生对象把未命中的
  变体显式置 null，`=== undefined` 会漏判后直读字段抛错），覆盖撤回
  （revokeElement）、群成员变动（groupElement）、语音/图片媒体（pttElement /
  picElement）与 grayTip 循环守卫；OB11 错误响应（缺 action / 未知动作 404 与
  请求处理异常兜底）透传 `echo`。
  
  生命周期：`BaseProtocolAdapter.start/stop` 增加并发去重与 start↔stop 交错
  等待；`reload()` 未启动时 no-op（原实现会对未启动实例重建传输，留下
  started=false 但传输已运行、后续 stop 空转的状态不一致）；OB11 心跳启动前
  清理残留定时器；Satori 非登录事件的 `login.sn` 不再混用全局事件序号（固定
  0）并新增可选 `logger` 注入（翻译失败由静默吞错改为 warn 留痕）；
  `KurobotConnection` 对非法 URL 的构造期异常走 error 日志 +
  `onEnded({permanent: true})` 永久停止。
  
  杂项：`MS_TO_SEC` 局部定义收敛到 `shared/uid-uin.ts`；修正 4 处指向
  `core/shared/...` 的旧路径注释（目录重构前遗留）。

## 0.16.0

### Minor Changes

- 4244ef2: 重构 adapter 动作体系与目录边界（动作名、zod schema、错误码映射与事件格式均不变）：
  
  - 动作从类样板（`class XxxAction extends BaseXxxAction`）改为 `{ name, schema, handle }`
    声明式对象，由各协议运行时工厂 `defineOb11Action` / `defineMilkyAction` /
    `defineSatoriAction` 组装（闭包依赖、统一信封与错误映射）；动作注册表改为按领域
    工厂遍历注册。
  - `@napuketto/adapter/core` 协议中立化：OB11 专属的 `BaseAction` / `ActionResult`
    信封移入 `./onebot11` 子路径内部；`ProtocolConfig` 空壳删除，配置基类直接用 kernel
    `ConfigBase`（从 `./core` 重导出）；`createHttpServerSchema` / `createWsServerSchema`
    合并为 `createServerSchema`。
  - QQ NT 共享原语（sysmsg 解码、grayTip、uid↔uin、媒体准备、RawMessage 规范化与
    `toUnixSeconds`）移至包内 `src/shared/`，不再从 `@napuketto/adapter/core` 导出；
    `./core` 只保留通用适配器框架（`runAction` / `ActionRegistry` /
    `BaseProtocolAdapter` / `ProtocolHooks` / `ConfigBase`）。
  - 收链路异步事件翻译统一挂 `.catch` 错误边界（单条/整批丢弃 + warn 留痕），
    单条消息回填异常不再产生 Unhandled Rejection。

## 0.15.4

### Patch Changes

- 4a380d7: adapter 静默降级分支治理与测试类型安全化（结构重构会话 5/5）。
  
  生产代码：fail-soft 降级分支补齐可观测日志——milky（api/enrichment/transport/动作层
  17 处）、onebot11（OneBotApi 新增可选 `logger` 字段并贯穿 media/history/send/enrichment
  8 处）、core（`ensureSilk` 转码失败可选 logger warn）、kurobot（版本探测降级 debug）。
  kernel API 调用失败 warn、纯解析兜底 debug 或保留映射语义注释；sysmsg 解码三态与 satori
  翻译层按既有口径保留。`milky/api` 的 uin→uid 失败现以 `cause` 保留原始错误。
  
  测试：全包 `as unknown as` 强转 153 → 43（新增 `core/__tests__/stub.ts` 的
  `stub<T>`/`stubList<T>` 强类型桩工厂 + 各协议 test-support 强类型工厂）；合并
  `*-branches`/`*-extra` 碎片测试 5 个到对应主测试文件（用例逐条保留）。
  
  纯结构调整与日志增补，不改协议信封、注册表与动作语义。

## 0.15.3

### Patch Changes

- 937ec67: refactor: Milky 动作域拆分 + 内部空壳 barrel 清理（结构重构会话 4/5）
  
  - `milky/action/group.ts`（826 行）按子领域拆为 4 文件：group-query（群信息 /
    成员查询 / 公告列表读取）、group-manage（群管 + 头像 / 头衔 / 公告发布删除 /
    群戳一戳）、group-essence（精华 + 表态）、group-notice（通知列表 + 应答）；
    `message.ts`（624 行）拆为 message-send（发送链 + forward 组装链）、
    message-query（get_message / history / forwarded）、message-ops（recall / 已读 /
    资源反查 / upload_private_file）。全部落在 150~300 行，动作类实现原样搬运。
  - `milky/action/index.ts` 注册表改为按新域文件导入，P0 → P1 → P2 批次二注册
    顺序与 64 个动作名不变。
  - 测试按源码域重组：`milky/action/__tests__/` 10 个批次命名文件（p1-* / p2-* /
    p3-* / message.test）归并为 11 个域对齐文件（group-query / group-manage /
    group-essence / group-notice / group-file / message-send / message-query /
    message-ops / profile / social / registry），180 个用例标题全部保留（仅重复
    用例加"补测"后缀消歧），共享桩上移 `test-support.ts`（groupRegistry /
    messageApi / indexableMsg）。
  - 清理 4 个单模块转发壳 `index.ts`：`onebot11/api`、`satori/api`、`satori/event`、
    `satori/helper/element`，改为直接引用目标模块；`package.json` exports 声明的
    6 个子路径入口与有实际聚合面的 barrel（协议根 / core / onebot11/types 等）
    保留。不改 milky 的 HTTP/SSE/WS 传输协议与 API 行为语义。
  
  纯结构调整，无行为变化。

## 0.15.2

### Patch Changes

- 98107a7: refactor: OB11 动作微文件按领域合并（结构重构会话 3/5）
  
  - `onebot11/action/` 62 个 20~110 行单动作微文件合并为领域文件（120~300 行）：
    message/ → send / history / ops / media / forward；group/ → manage / query /
    essence（含群荣誉）/ notify；friend/ → query + manage；system/ → info /
    status / account / file（download_file 与闪传 upload 合并入 file）。群系统
    消息与群文件操作/查询三文件已在此粒度，保持不动。
  - 动作类与 `create*Actions(api)` 工厂同文件导出，`action/index.ts` 重写为
    遍历工厂注册（345→约 90 行），消除 12 个 `register*Actions` 手工样板；
    公共面 re-export（`ob11ErrorCodeMap` / `resolveUid` / `AtAllRemainInfo` /
    `Ob11ActionDeps` / `createOb11ActionRegistry`）不变。
  - 全部 81 个动作的 `action.name`、zod schema、retcode 映射与返回字段不变；
    搬运保持实现原样（仅合并重复 import 与同义常量命名）。
  - 域内 16 个测试文件同步导入路径；registry 测试的 81 动作名全集断言全程通过。
  
  纯结构调整，无行为变化。

## 0.15.1

### Patch Changes

- 66203cb: refactor: inbound 域处理器分层（event-pipeline 拆订阅接线板 + inbound/ 域处理 + sysmsg 通用管线）
  
  - 各协议 `event-pipeline.ts` 瘦身为纯订阅接线板（unsubscribes 管理 + applyConfig
    开关 + kernel 频道 → 域处理器路由）：onebot11 495→99 行、milky 628→97 行、
    kurobot 331→45 行。
  - 事件域处理拆入各协议 `inbound/`：onebot11（message / sysmsg / essence /
    request / file-notice）、milky（base / message / sysmsg / essence / request /
    file-notice / pin）、kurobot（message / server-frames，另有 session.ts 共享
    状态：绑定集 / pending 表 / status 快照 / 接收过滤），单文件 ≤110 行。
  - sysmsg 单条字节块「解码 → 信封 → 识别 → 分流 → 校准日志」通用管线收拢
    `core/shared/sysmsg.ts` `processSysMsgBlob`；onebot11 / milky 只持识别表与
    命中处理。解码失败日志级别保持协议既有口径（OB11 warn / Milky debug）。
  - 顺手清理：OB11 notice 翻译失败补 debug 日志（丢弃整个事件的原语义不变）、
    milky 置顶基线播种失败补 debug 日志、OB11 群通知按 kernel `GroupNotify`
    类型消费（消除 unknown 属性断言）、milky 732:1 快路径载荷改守卫收窄。
  - 公共面无变化：`Napuketto*Adapter` 类名、构造参数与公开方法签名不变，包导出
    子路径不变。
  
  纯结构调整，无行为变化（上条日志补记除外）。
- 57fdaf2: refactor: 协议适配器协调层拆分（onebot11 / milky / kurobot 巨型 adapter.ts 分层）
  
  - `adapter.ts` 瘦身为纯协调层（构造装配 / 生命周期 / 传输启停；OB11 另有 IPC 桥
    `subscribeOnly` / `unsubscribeOnly` 公共面）；各协议新增 `event-pipeline.ts`
    （事件通道订阅与派发、自消息过滤、去重缓存 fileKeys / essenceKeys / pinWatch）
    与 `enrichment.ts`（翻译前异步回填：批量 uidToUin、群实体、msgId 反查、精华
    diff 触发），翻译函数保持纯函数（ADR-008）。
  - 公共面无变化：`Napuketto*Adapter` 类名、构造参数与公开方法签名不变，包导出
    子路径不变。
  - 内联工具收拢 `core/shared/`：新增 `log.ts`（`truncRaw` / `sliceRaw` /
    `AdapterLoggerLike`）、uid-uin 的 `numericUin`、gray-tip 的 `findRevokeElement`。
  
  纯结构调整，无行为变化。

## 0.15.0

### Minor Changes

- bb5dd6c: adapter core 框架收拢（结构重构会话 1/5）：
  
  - `ProtocolHooks` 泛型化（`ProtocolHooks<TConfig>`）：onStart/onReload 强类型透传协议
    配置，删除四个协议 adapter 内的 `config as XConfig` 强转；默认类型参数保持
    `ProtocolHooks` 旧用法可编译。
  - 新增动作执行内核 `runAction`（`@napuketto/adapter/core` 导出）：OB11 / Milky /
    Satori 三套动作基类共用 safeParse + `isKernelError` 统一映射骨架，校验失败 retcode、
    消息模板与结果包装参数化。行为收口一处：非 KernelError 的「带 code 普通 Error」不再
    按 code 映射，统一落映射表 UNKNOWN 兜底（此前 OB11 为形状嗅探）。
  - 删除死代码：`AdapterRegistry` / `ProtocolAdapterLike` 不再从 `@napuketto/adapter/core`
    导出（装配方直接持有各协议适配器，cli/loader 无引用）；`satori/action/registry.ts`
    空壳别名文件删除，`SatoriActionRegistry` 类型并入 `satori/action/index.ts` 导出。
  - 跨协议重复原语收拢 `core/shared`：`toUin` / `toUinString`（OB11 / Milky / Satori 共
    5 处本地实现收敛）、`hasGrayTip`（OB11 / Milky）、`EssenceListSync`（精华列表缓存 +
    串行链，OB11 / Milky adapter 共用）、`findFirstMatch`（milky api 与 satori action 的
    通知/申请查找骨架）。

## 0.14.2

### Patch Changes

- 7716d89: OB11 `uinToUid` / `uidToUin` 便捷方法改为绑定实例的类字段（issue #110 侧报）：此前动作把
  方法裸传为回调（resolveUid 等），脱绑调用 `this` 为 undefined，get_friend_msg_history /
  set_input_status / mark_msg_as_read（含别名）/ send_private_forward_msg / set_friend_remark /
  delete_friend / send_like 抛 `Cannot read properties of undefined (reading 'groupApi')`。

## 0.14.1

### Patch Changes

- Updated dependencies [da55567]
  - @napuketto/kernel@0.12.0

## 0.14.0

### Minor Changes

- 3807d6f: feat(adapter): `upload_group_file` / `upload_private_file` 改走闪传（文件投递可用）
  
  文件消息路线被服务端传输命令拒（`170019002`，逐维扫参无效），改走 kernel `FlashTransferApi`：
  上传文件集 + 发分享卡片。OB11 新增同名两动作（81 个动作），milky 两动作改道。
  
  语义降级（已在协议文档明示）：发出的是「分享链接卡片」，不是文件消息、也不进群文件列表；
  返回的 `file_id` 是闪传文件集 id，不能用于群文件动作。原 `sendFileMessage`（缺 `fileUuid` 时
  把 msgId 当 file_id 返回的静默假成功）已删除。

### Patch Changes

- Updated dependencies [3807d6f]
  - @napuketto/kernel@0.11.0

## 0.13.2

### Patch Changes

- fa012b6: fix: Linux 原生宿主入站字段收口（图片 `sourcePath`、`sender.nickname` 回退、milky 空值嗅探）
  
  - kernel `picToCanonical`：Linux `picElement` 没有 `picPath`/`picUrl`，原图落在
    `sourcePath`（绝对路径）。路径取值改为 `picPath → picUrl → sourcePath`，空串
    视为缺失；`url` 仍只在 `picUrl` 非空时提供（`originImageUrl` 是无 host 的相对
    路径，不伪造 CDN 域名）。修复 Linux 入站图片段 `file` 恒为空。
  - adapter OB11：Linux `sendNickName` 是空串、显示名在 `sendMemberName`。事件与
    `get_msg`/历史消息统一经 `senderNickname()` 回退（Windows 仍昵称优先）。
  - adapter milky：元素存在性嗅探统一 `!= null`（grayTip / 多转发 / 撤回 /
    fileElement / aioOp），避免 Linux 显式 `null` 变体被误判。
- Updated dependencies [fa012b6]
  - @napuketto/kernel@0.10.2

## 0.13.1

### Patch Changes

- 7fac4ad: fix(adapter): Linux 原生宿主入站消息可投递（元素变体 null 形状 + msgTime 单位归一）
  
  真机复现：`NAPUTO_LINUX_NATIVE=1` 下他人消息到达 kernel，但 OB11 WS 收不到任何
  `message` 事件。插桩确认不是原生调用挂起（`groupMemberRole` 566ms 正常返回），
  而是两处 Linux 原生对象形状差异：
  
  - **元素变体显式 `null`**：Linux 3.2.x 把未命中的元素变体置 `null`（Windows 省略
    字段），OB11 `hasGrayTip` / `hasFileElement` 用 `!== undefined` 判定 → 每条普通
    消息都被误判为 grayTip 转入 notice 分支后静默丢弃；Satori `hasSatoriGrayTip` 的
    `g === undefined` 同源（读 `null.subElementType` 抛错被事件通道吞掉）。统一改空值
    判定（`!= null`），并覆盖 `toGroupUpload` / poke 判定。
  - **`msgTime` 单位**：Linux 为秒字符串、Windows 为毫秒，统一 `/1000` 会让 Linux
    事件时间退化成 1970。新增 `core/shared/time.ts` 的 `toUnixSeconds()` 按量级归一，
    OB11 消息事件 / notice / 历史消息翻译统一使用。
  
  实测：群 `1101729931`（第二账号 `3054108135`）与自然群流量（群 `521584745`）的
  文本 / 图片 / reply 消息均广播为 `post_type=message`、`message_type=group`、真实
  `user_id` 与当前 Unix 秒时间；同时启用 OB11 + Satori 时两端口各自只收到本协议信封。
  新增 null 形状回归单测与 `toUnixSeconds` 单测。

## 0.13.0

### Minor Changes

- ce60427: feat(adapter): OneBot 11 发送视频时自动补首帧缩略图与时长/尺寸
  
  QQ 视频消息要求 `thumbMd5 / thumbSize / thumbPath(Map) / thumbWidth / thumbHeight`
  与秒级 `fileTime` 成套出现；kernel 只在 canonical 带 `thumbPath` 时才写这套字段，
  所以「只给 `file` 的 `video` 段」在 native 侧必然失败，且只回 `sendStatus=0`
  （没有错误信息，2026-11-10 Linux 原生宿主实测）。
  
  adapter 现在在发送前归一化（`core/shared/media.ts` 的 `prepareVideoElements`）：
  用 `@napuketto/media` 的 `getVideoInfo`（ffprobe）取宽高与时长、`extractVideoFrame`
  （ffmpeg）抽首帧写系统临时目录，补 `thumbPath / width / height / durationSec`，
  发送结束清理临时目录；抽帧失败抛可读 `MediaError`，不再让 native 静默回
  `sendStatus=0`。
  
  代价：OB11 发视频从此要求系统有 `ffmpeg` / `ffprobe`（与 satori 的 `transcodeVideo`
  同一前提）。Linux 原生宿主实测：1s 64×64 H.264 mp4 发送 `retcode 0`、缩略图按视频
  md5 落盘、撤回通过。satori / milky / kurobot 的发送路径暂未接入本函数。

## 0.12.4

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
- Updated dependencies [06bf7a9]
  - @napuketto/network@0.3.1

## 0.12.3

### Patch Changes

- Updated dependencies [959ee4d]
  - @napuketto/kernel@0.10.1

## 0.12.2

### Patch Changes

- Updated dependencies [dd2e4ad]
- Updated dependencies [94d6d3c]
  - @napuketto/kernel@0.10.0

## 0.12.1

### Patch Changes

- 4b76806: refactor(adapter): 根入口 `src/index.ts` 改为「dist 路径锚点」注释（ADR-014），并移除无人使用的
  `ProtocolId` 类型导出。根入口运行期本就只有 `export {};`——它的真实职责是让包根可被
  `import.meta.resolve()` 解析，供 cli 注入 `NAPUTO_ADAPTER_ENTRY`、loader 按 `index.mjs` 字符串
  替换推出各协议子入口；协议面继续只走子路径（./core、./onebot11、./satori、./kurobot、./milky）。

## 0.12.0

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

### Patch Changes

- Updated dependencies [39d98d8]
  - @napuketto/network@0.3.0

## 0.11.1

### Patch Changes

- Updated dependencies [3fe6499]
  - @napuketto/kernel@0.9.1

## 0.11.0

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

### Patch Changes

- Updated dependencies [d08fdf1]
  - @napuketto/kernel@0.9.0
  - @napuketto/media@0.1.0
  - @napuketto/network@0.2.0

## 0.10.0

### Minor Changes

- 94cf013: feat(adapter): OB11 group_essence 群精华变更通知接线（onebot11.md §4.2 欠账清零）
  
  数据源复用 Milky 批次三成果（diff 翻译层上移 `adapter/src/core/essence.ts`
  共享，milky 行为不变）：
  
  - **唯一发射路径 = 列表 diff**：`Group/onGroupEssenceListChange`（录制实证
    payload 首项群号）→ getEssenceMsgList 全量 diff（基线未建立只建基线，
    essenceChain 串行防乱序）。
  - **sysmsg 732:1 作加速触发器**：push 内无 sender/operator，不直接翻译，
    命中后踢入同一串行链——diff 幂等 + 串行天然去重。
  - **字段口径**：sender_id 必填（列表 sender_uin / prev 缓存回填，缺失跳过
    事件）；operator_id 仅 add 回填 add_digest_uin（类型改为可选，delete 无
    任何数据源）；message_id 经 fetchMessages 近段扫描（60 条）→
    MessageUnique.alloc 幂等分配（与消息事件同一空间，可被 get_msg 反查，
    对照 recall 的 msgSeq 错位），解析失败跳过事件 + 校准日志。
  - 顺手修正文档过期描述：sysmsg 识别表已含 732:21（group_card），
    "识别表为空" 表述更新；OB11Adapter sysmsg 处理 JSDoc 归位。

## 0.9.0

### Minor Changes

- d2e6287: feat(kernel,adapter,loader): Milky 批次三——5 个无源事件接线 + sysmsg 识别表共享化（milky.md §0.8.6）
  
  三轮 listener 录制 + set_peer_pin 自触发翻转实验取齐证据后，Milky 事件面补齐
  批次三 5 个事件（此前 P1 事件覆盖缺口）：
  
  - **peer_pin_change**：新增 kernel RecentContactBridge（onRecentContactListChangedVer2
    转发，录制实证条目含 chatType/topFlag/topFlagTime）；milky 按「同会话 topFlag
    翻转」检测广播（回调随消息活动高频快照，不能见条目就广播），启动以
    getPinnedContacts 播种基线（PinnedContact 新增 peerUin）。
  - **friend_file_upload**：Msg 桥补转发 onFileMsgCome（录制实证与
    onRecvOfflineFileMsg 同载荷），onRecvOfflineFileMsg 参数类型同步收窄为
    RawMessage[]；milky 双回调按 msgId 去重；file_hash 官方语义 TriSHA1、实测取
    file10MMd5（md5）充值（FileElement/RawMessage 补录制实证字段）。
  - **group_message_reaction**：sysmsg 732:16（识别表实证）；operator 不在原生
    push（f4 为 bot 自身占位）——user_id 省略（P1 不产出半成品字段惯例）。
  - **group_essence_message_change**：732:1 set 快路径 + onGroupEssenceListChange
    → getEssenceMsgList 列表 diff（remove 路径 + operator_id=add_digest_uin 回填；
    取消精华无独立 sysmsg 只能 diff 发现）；双路径去重缓存谁先到谁广播。
  - **bot_offline**：新增 kernel LoginBridge（loginService 由装配注入
    ctx.wrapper.loginService，onLoginDisConnected/onLogoutSucceed 转发）；回调
    载荷零样本，reason 暂为固定值 + raw 校准日志待野捕。
  
  sysmsg 解码层（wire-format 解码 / 信封提取 / 参数收窄）自 onebot11/helper 上移
  adapter/src/core 共享，识别层泛型化 SysMsgKindRule<TEvent>：
  onebot11 识别表不再是空表——732:21 群名片变更（OB11 group_card，三轮录制首个
  实证条目，uid→uin 经 collectUids 钩子批量解析）；milky 识别表 732:16 / 732:1。
  
  loader 装配：kernel-services 新增 RecentContact/Login 通道与桥（dispose 面随
  之扩展），IPC 转发与 milky 传参同步接线。

### Patch Changes

- Updated dependencies [d2e6287]
  - @napuketto/kernel@0.8.0

## 0.8.4

### Patch Changes

- 8414800: fix(adapter): milky HTTP 传输从未监听——startTransports 缺 open（P0 起存量）
  
  置顶翻转校准实验（milky.md §0.8.5 批次三前置）首次实机启用 `[accounts.milky]`
  段发现：`bootstrap: milky adapter started` 但端口从未绑定——
  `startTransports` 装配传输后**没有调 `open()`**（satori 在 P0 同期写对了：
  `Promise.all(adapters.map((t) => t.open()))`；OB11 也在 startTransports 里
  显式 open）。集成测试一直显式 `set.adapters[0]?.open()` 自己补了 listen，
  掩盖了适配器路径的缺口。
  
  修复：startTransports 装配后 `Promise.all(set.adapters.map((a) => a.open()))`
  ——server.open 实绑端口，hub / webhook client 的 open 均为 no-op。
  适配器级回归测试：NapukettoMilkyAdapter.start() 后直接 fetch
  /api/get_impl_info 可达（旧代码 ECONNREFUSED）。
- Updated dependencies [8414800]
- Updated dependencies [8414800]
  - @napuketto/kernel@0.7.3

## 0.8.3

### Patch Changes

- Updated dependencies [708924b]
- Updated dependencies [708924b]
  - @napuketto/kernel@0.7.2

## 0.8.2

### Patch Changes

- Updated dependencies [0c3444b]
  - @napuketto/kernel@0.7.1

## 0.8.1

### Patch Changes

- Updated dependencies [a668d31]
  - @napuketto/kernel@0.7.0

## 0.8.0

### Minor Changes

- aab6e62: feat(adapter,kernel,loader): Milky P2 批次二——15 动作接实机探测 kernel 出口（milky.md §0.7）
  
  实机探测（NAPUTO_PROBE=1，names-only 修复后）拿到 56 个服务方法面，批次二据此设计；
  规范形状取官方 API 文档（1.3.0，MIT）。全部「方法名实测确认、参数待校准」——失败抛
  KernelError，原始响应经 MilkyApi.logger 记 debug 供实机校准。
  
  kernel 新出口：
  
  - MsgApi：file 元素发送链（P2-2 预留口子，pic/ptt/video 同款 NapCat 式
    md5 → getRichMediaFilePathForGuild(FILE) → copyFile → fileElement）+
    sendNudge / setContactTop（setContactLocalTop）/ queryFavEmojis
    （queryFavEmojiByDesc）。
  - GroupApi：getGroupAnnouncements / publishGroupAnnouncement
    （uploadGroupBulletinPic + publishGroupBulletin 两步）/ deleteGroupAnnouncement /
    setMemberSpecialTitle（setIdentityTitleInfo）/ setGroupAvatar（setHeader）。
  - RichMediaApi：renameGroupFolder（renameGroupFile 同款 5 参）+
    getGroupFileDownloadUrl（getGroupFileList 按 fileId 查 url 字段）。
  - 新增 RecentContactApi（getRecentContactList，get_peer_pins 数据源）；
    loader kernel-services 装配 + assemble-protocols 透传。
  - **修复 getGroupFileList 解包**：旧逻辑 `result !== 0` 即抛错 + extractFileList(0)
    恒空——真实返回形状（result 即列表 / 顶层列表 / 嵌套 items）下要么误抛要么恒空
    （P1 群文件列表实机必挂，此前无实机路径触达）。改宽松解包（checkLooseResult +
    result/raw 双位提取）。
  
  adapter 新动作 15 个（注册表 49 → 64）：send_friend_nudge / send_group_nudge /
  get_peer_pins / set_peer_pin / get_group_announcements / send_group_announcement /
  delete_group_announcement / set_group_avatar / set_group_member_special_title /
  get_custom_face_url_list / get_resource_temp_url / upload_private_file /
  upload_group_file / get_group_file_download_url / rename_group_folder。
  
  已知差异（文档明示，milky.md §0.7）：get_resource_temp_url 当前 resource_id 即临时
  链接原样返回（无独立资源索引）；upload_group_file 走消息发送链（群内产文件消息，
  生态同款），parent_folder_id 暂不参与定位；get_group_file_download_url 仅根目录
  可达。get_private_file_download_url 延后批次三（rkey/TriSHA1 校准）。
  
  fallow：kernel apis 实现文件加入 ignoreFindings（公开方法全部跨包消费，静态图
  看不见；任一改动行位移即把存量成员翻成「本次引入」卡死增量门禁，与 barrel 豁免
  同根因）。

### Patch Changes

- Updated dependencies [aab6e62]
  - @napuketto/kernel@0.6.0

## 0.7.3

### Patch Changes

- Updated dependencies [513df56]
  - @napuketto/kernel@0.5.3

## 0.7.2

### Patch Changes

- Updated dependencies [695e017]
  - @napuketto/kernel@0.5.2

## 0.7.1

### Patch Changes

- Updated dependencies [64809d8]
  - @napuketto/kernel@0.5.1

## 0.7.0

### Minor Changes

- 19fc7cf: feat(adapter): Milky forward 发送段落地（P2 批次一）
  
  Milky 发送消息段补全至 10/10：send_private_message / send_group_message 现支持
  forward 段（messages 任意内容组装）。实现走临时消息法（kernel 零改动）：逐条
  临时发送 → buildMultiForwardMsg 组装转发 → best-effort 撤回临时消息。
  
  已知差异（待实机联调校准）：节点发送者恒为机器人自己（user_id / sender_name /
  time 不参与组装）；title / preview / summary / prompt 忽略；临时消息在撤回前
  可见、其撤回会产生 message_recall 事件（operator 为自己）；forward 段须单独发送。
  
  配套：MilkyApi 增可选 logger（动作层可观测出口，服务于撤回失败 warn）。
  P2 批次二（群公告 / 置顶 / nudge 发送 / 群文件下载地址 / resource 反查 /
  重命名文件夹 / 上传等 + 5 个无源事件）依赖实机探测产物（NAPUTO_PROBE=1），见
  docs/protocols/milky.md §0.6。

## 0.6.0

### Minor Changes

- d089f71: feat(milky): Milky 协议 P1 扩面——动作 9 到 49、事件 2 到 15、转发内容反查
  
  - 动作扩面 40 个：资料/票据（get_user_profile / get_friend_info / set_avatar /
    set_nickname / set_bio / get_cookies / get_csrf_token）、好友操作（send_profile_like /
    delete_friend / get_friend_requests / accept/reject_friend_request）、消息
    （get_history_messages / get_forwarded_messages / mark_message_as_read）、群管与精华
    （get_group_info / get_group_member_list / get_group_member_info / set_group_name /
    set_group_member_card / set_group_member_admin / set_group_member_mute /
    set_group_whole_mute / kick_group_member / quit_group / get_group_essence_messages /
    set_group_essence_message / send_group_message_reaction）、群通知与应答
    （get_group_notifications / accept/reject_group_request /
    accept/reject_group_invitation）、群文件（get_group_files / move_group_file /
    rename_group_file / delete_group_file / persist_group_file / create_group_folder /
    delete_group_folder）。
  - 事件扩面 13 个：friend_request / group_join_request / group_invited_join_request /
    group_invitation（Group/Buddy 事件通道）、group_member_increase / decrease /
    group_mute / group_whole_mute / group_name_change / group_disband（grayTip 系）、
    friend_nudge / group_nudge（aioOp best-effort + 校准日志）、group_file_upload
    （群场景文件消息替代 message_receive）。
  - 合并转发：接收段 forward_id 改为 resId（规范「转发消息 ID」语义），
    MessageSeqIndex 增转发索引，get_forwarded_messages 经索引定位会话。
  - 装配：loader services.self 增 uid；milky 装配透传 profileLikeApi / ticketApi /
    webApi / groupNotifyApi / richMediaApi 与群/好友事件通道。
  - 翻译共享收敛到 adapter core（uid→uin 解析 / request 上下文 / BuddyReq 防御收窄 /
    grayTip 未翻译提取器），OB11 行为不变。

## 0.5.0

### Minor Changes

- 51a0ce8: feat(milky): Milky 协议适配器 P0（第四协议，目标 Milky 1.3.0）——
  
  - adapter：`@napuketto/adapter/milky` 子路径导出 `NapukettoMilkyAdapter` + `milkyConfigSchema`。单端口 HTTP（`POST /api/:api` 规范信封 + 401/404/415 语义；`GET /event` SSE/WS 事件推送）+ WebHook；P0 动作 9 个（get_login_info / get_impl_info / send_private_message / send_group_message / get_message / recall_*_message / get_friend_list / get_group_list），事件 2 个（message_receive 三场景 / message_recall）；类型层为官方 JSON Schema 的自研描述（P0 子集）；seq↔msgId 走 adapter 侧 MessageSeqIndex 双向映射（接收登记 + 历史扫描兜底）；发送核心含媒体 URI 解析（file:// / base64:// / http(s):// 落盘）
  - network：SSE 事件流原语（`createSseResponse`）+ `HttpServer` 流式响应注入点（`onRawRequest`）与同端口 WS 升级注入点（`onUpgrade`）+ 空 body 响应支持（respond undefined）——均协议无关
  - loader：`[accounts.milky]` 账号段读取与装配分支（段存在才装配，enabled=true 生效）
  - cli / create：账号配置 schema 增 `milky` 段，配置模板与脚手架模板同步

### Patch Changes

- Updated dependencies [51a0ce8]
  - @napuketto/network@0.1.0

## 0.4.2

### Patch Changes

- 99af200: fix(adapter): OB11 消息事件与 get_msg/历史消息的 sender.role 接群成员缓存判定 owner/admin——此前恒为 "member"（docs/protocols/onebot11.md 缺口清单项）。经 OneBotApi.groupMemberRole(s) 查 kernel GroupCache（缓存优先，缺失惰性回填；角色映射复用 GroupApi.roleToString），查询失败或未装配缓存时回退缺省 "member"，不阻塞消息上报；角色经 ReceiveTranslateContext.senderRole 注入，翻译层保持纯函数
- Updated dependencies [9785cc2]
  - @napuketto/kernel@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [a120cdd]
  - @napuketto/kernel@0.4.0

## 0.4.0

### Minor Changes

- 8f55c0e: feat(log): 日志可配置化与嵌入式宿主优化——新增 napuketto.toml [log] 段（format: pretty/single-line/json、level 全局+按模块覆盖 cli/kernel/loader/ob11、banner、timestamp: local/iso8601/elapsed、unboundReceive、[log.file] 独立文件 sink 可分级），环境变量覆盖 NAPUKETTO_LOG_LEVEL / NAPUKETTO_LOG_FORMAT / NAPUKETTO_NO_BANNER（兼容旧拼写 NAPKETTO_LOG_LEVEL，全进程链生效）
  
  行为变化（默认生效）：
  - 级别重分配：ob11 校准遥测（onRecvSysMsg/onRecvOnlineFileMsg/onGroupEssenceListChange，含 protobuf hex）与 loader 接收行降 debug；QQ 文件来源/数据目录/自建宿主引导/wrapper 装配/启动账号等引导细节降 debug；账号上线、QR 状态、握手结果、致命错误保持 info 及以上。终端要看接收行配 [log.levels] loader = "debug"
  - warn 级 raw 字段截断为 64 字符 + 缺省长度标注（完整值在 debug 级与日志文件）
  - 时间戳统一单调墙钟（performance.timeOrigin + performance.now()）：修复 QQNT 原生层在 onRecvSysMsg 回调窗口内篡改 Date 导致的假时间戳（实测记录时间冻结为 02:01:55.3 一类常量）
  - 非 TTY（管道/重定向）自动 single-line 且无 ANSI 颜色；TTY 终端输出不变
  - banner 每进程树至多一次（supervisor 派生子进程注入 NO_BANNER）；banner=false 可全关
  - 补过滤 mmkv 变体噪音行（loadFromFile> loading [mmkv）
  
  feat(lifecycle): 优雅关停通道与退出码契约——停止哨兵 <数据根>/napuketto.stop（内容 = 账号 uin 或 all，宿主写文件即触发）与 SIGINT/SIGTERM/SIGBREAK（Windows CTRL_BREAK_EVENT 可达）双通道，内部有序清理（协议适配器停止、事件桥退订）后 exit 0；退出码契约 0 = 请求式正常退出 / 非 0 = 引导失败或致命；napuketto stop 改哨兵优先 + 树杀兜底，taskkill /F 兜底行为保留

### Patch Changes

- Updated dependencies [8f55c0e]
  - @napuketto/kernel@0.3.0

## 0.3.6

### Patch Changes

- Updated dependencies [3501c01]
  - @napuketto/kernel@0.2.5

## 0.3.5

### Patch Changes

- Updated dependencies [677f0ed]
  - @napuketto/kernel@0.2.4

## 0.3.4

### Patch Changes

- Updated dependencies [0e8a808]
  - @napuketto/kernel@0.2.3
  - @napuketto/media@0.0.7

## 0.3.3

### Patch Changes

- cb4bd37: chore(release): 接入 npm OIDC 可信发布与 PR-only 门禁（无功能变更，一次性 patch 用于实证发布链）
  
  - 新增 `.github/workflows/release.yml`：合并带 changeset 的 PR 后，prepare 消费 changeset、构建、测试并推送版本提交；publish 在 `release` environment 审批后逐包 `npm publish`（OIDC 短时 token，无长期凭证，自动 provenance）。
  - 发布前逐包预检 npm 信任配置（`tooling/release/release-trust.ts`），缺配置整批不发，杜绝半批发上 npm。
  - 发布链拆成 `release:version` / `release:build` / `release:test` / `release:publish`，本地 `pnpm release` 复用同口径，仅作演练与应急。
  - CI 增加 `merge_group` 触发，配合主分支 merge queue 与必需状态检查；一切改动走 PR（发布链的版本提交是唯一既定例外）。
- Updated dependencies [cb4bd37]
  - @napuketto/kernel@0.2.2
  - @napuketto/network@0.0.3
  - @napuketto/media@0.0.6

## 0.3.2

### Patch Changes

- Updated dependencies [3665e63]
  - @napuketto/kernel@0.2.0
  - @napuketto/media@0.0.5

## 0.3.1

### Patch Changes

- 5bc2aea: fix(adapter): 协议镜像对齐 KuroBridge 改名（kurobridge-ws.v1 / 0.4.0）+ 修复 0.1.18/0.3.0 发布物损坏
  
  - 协议镜像（adapter `schema.ts`）随 KuroAdapter ADR-030 品牌改名对齐：WS 子协议
    `kurobot-ws.v1` → `kurobridge-ws.v1`，PROTOCOL_VERSION 0.3.1 → 0.4.0（帧形状与
    0.3.1 逐字段一致，仅品牌字符串与版本号变更）。**本版起仅与 kurobridge-ws.v1
    服务端（KuroAdapter 改名后版本）互通**；TOML `[accounts.kurobot]` 段名不变。
  - 0.1.18 / 0.3.0 的 npm 发布物 manifest 泄漏 `workspace:*`（`npm install` 直接
    EUNSUPPORTEDPROTOCOL，无法安装），两个版本号作废；本版经 pnpm release 链重新
    发布（release-npm 的 workspace 改写兜底覆盖）。

## 0.3.0

### Minor Changes

- 524e5dc: feat(adapter): 新增 kurobot 协议适配器（KuroBot MVP-3 群服互通）
  
  账号 TOML 配了 `[accounts.kurobot]` 段即启用：作为 kurobot-ws **客户端**主动连入
  KuroBot 服务端（Minecraft 服务器），实现 QQ 群 ↔ MC 双向互通——QQ 群文字进游戏
  广播、游戏聊天/进服/退服/死亡事件渲染进群、群命令前缀转发为游戏命令（结果回群）。
  
  - 连接层自建（子协议 `kurobot-ws.v1`、应用层 ping 15s、断线指数退避 1s→60s、
    close 1002/1008 停止重连）；协议 schema 镜像 KuroAdapter `bridge/protocol`
    0.3.1（golden 帧对表锁漂移）。
  - 配置段：`url` 必填，`token`/`commandPrefix`/`pingIntervalMs`/四个渲染模板可选
    （缺省见 cli 模板注释）；段存在即启用、不写不启用。
  - 装配：loader 按账号段装配（非 IPC 模式）；cli `config-parse`/模板与
    create-napukettoqq 脚手架模板同步。

## 0.2.1

### Patch Changes

- fd1daf3: fix(adapter): parseCqMessage 改为线性 indexOf 扫描，消除不可信消息文本下的多项式回溯（CodeQL polynomial-redos 高危告警）

## 0.2.0

### Minor Changes

- e4bdcb3: feat(adapter): onRecvSysMsg protobuf 解码器落地——手写 wire-format 解码（零依赖，BigInt 保 64 位精度）+ 回调参数防御性收窄 + 信封提取（2 条真实样本校准字段号）+ 识别层。⚠️ 识别表当前为空：card/title/sign 的 (msgType, subType) 判别值无样本支撑，宁可漏报不错报——未识别一律打结构化校准日志不广播；后续拿到真实样本只需往 KIND_TABLE 登记规则即可开始广播对应 OB11 notice。

### Patch Changes

- Updated dependencies [d424c67]
  - @napuketto/kernel@0.1.1

## 0.1.0

### Minor Changes

- 08119ae: feat(kernel/adapter): 无源 notice 事件找源与接线（c3 探测轮）

  - kernel：MsgBridge 新增 onRecvOfflineFileMsg / onRecvOnlineFileMsg / onRecvSysMsg 三通道，GroupBridge 新增 onGroupEssenceListChange（方法名证据 = wrapper.node 9.9.33-52230 字符串扫描：小写回调名偏移同簇 + RTTI + argc 断言；onRecvSysMsg 经 90s 观测窗运行时实触，payload 为原始 protobuf 字节）
  - adapter：新 helper notice-extra.ts——Msg/onRecvOfflineFileMsg 防御性收窄翻译为 OB11 offline_file notice（未知形状 raw 日志）；onRecvSysMsg / onRecvOnlineFileMsg / onGroupEssenceListChange 挂 raw 校准日志（sys msg 为 group_card/group_title/group_sign 的总载体，protobuf 解码为下轮翻译前置）
  - 附带记录：downloadRichMediaInVisit 参数面破案（base 五字段 + elem 元素对象，实测 ok）；msg_emoji_like 无推送回调（仅 API 面）；探测脚本 scripts/probe-scan-strings.mjs 与 scripts/probe-notice-sources.mjs 入库

### Patch Changes

- Updated dependencies [08119ae]
  - @napuketto/kernel@0.1.0

## 0.0.22

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

- Updated dependencies [98385c2]
  - @napuketto/kernel@0.0.17

## 0.0.21

### Patch Changes

- 43a42e1: feat(media/adapter/loader): get_image/get_record 接主动下载——media 包新增 downloadUrl/inferExtension（fetch + 大小上限 + 超时）；get_image 本地 NT 相对路径按 mediaBaseDir（QQ NT global 目录，装配链经 resolveQqUserDataRoot 解析注入）解析，未命中且有 picUrl 时下载到 cacheDir/media 返回 file；get_record 本地解析命中返回绝对路径（语音主动下载缺口：downloadRichMedia 原生签名未探测，待实测后接入）
- 59e5492: feat(media/adapter): 媒体收发方向接线——media 新增 decodeSilkToWav（silk → 可播放 WAV，收方向语音）并加固 transcodeVideo（exitCode/产物存在性校验，失败抛 MediaError 不再返回幽灵路径）；satori video 非 mp4 输入发送前 ffmpeg 归一化（fail-soft 原样透传）
- 36b0144: feat(adapter): OB11 notice 补全——好友撤回（C2C grayTip REVOKE → friend_recall）、戳一戳（aioOpGrayTipElement → notify.poke，待真实事件验证）；未知 grayTip 子类型与 Buddy 列表变化打 raw JSON 校准日志（friend_add/lucky_notify/honor/essence 翻译的数据源积累入口）
- 968ed50: feat(kernel/adapter/loader): OB11 request 事件链接线——FriendBridge 好友事件桥（onBuddyReqChange 等回调，方法名来自 wrapper.node 字符串证据）+ OB11 适配器订阅群通知/好友申请推送翻译 request 事件（friend/group_add/group_invite，flag 与应答动作匹配路径一致），loader 装配 Buddy 通道并 IPC 转发
- 94cdb8e: feat(adapter): onReload 热更新实现——OB11/Satori 配置变更后 stop 旧传输（心跳/退订/关闭）→ 按新配置重建（P2-6 兑现）；OB11 IPC 桥模式（subscribeOnly）无传输不重建，仅刷新上报开关与消息格式
- d480a06: fix(adapter): WS/HTTP 查询参数鉴权修复——hasAccessTokenQuery 对 req.url（纯路径无 origin）做 new URL 必抛，access_token 参数鉴权从未生效（连接全被 4401 关闭；T10 E2E 实测抓到，改用 dummy base 解析）；OB11 动作 params 缺省空对象（规范允许省略，此前缺 params 一律 1400）
- Updated dependencies [43a42e1]
- Updated dependencies [59e5492]
- Updated dependencies [968ed50]
  - @napuketto/media@0.0.4
  - @napuketto/kernel@0.0.16

## 0.0.20

### Patch Changes

- be5845c: feat: Koishi 插件 IPC 模式整表挂载 OB11 动作容器（79 动作 + ob11 事件透出）——① loader 新增 ipc-ob11 桥：检测 NAPUTO_ADAPTER_ENTRY/NAPUTO_NETWORK_ENTRY 注入时动态 import adapter/network，实例化 NapukettoOneBot11Adapter 仅 subscribeOnly()（接收链路，零网络传输/零配置文件 IO），全部动作名平铺合并进共享 IPC 动作表，OB11 事件经 broadcaster → sendEvent("ob11") 透出，装配失败 fail-soft 降级；② adapter 新增 subscribeOnly()/unsubscribeOnly() 公共方法与公开 registry（IPC 桥枚举挂载用）；③ adapter/network 根导出补 require 条件（koishi 插件 CJS 产物 createRequire.resolve 定位入口用，实际消费仍走 ESM 动态 import）；④ koishi 插件新增 @napuketto/adapter/@napuketto/network 依赖与 ob11Actions 配置（默认开），launcher 透传入口，bot.onOb11 暴露原始 OB11 事件订阅口，bot.internal.\_request("send_like", ...) 直达全部 OB11 动作（返回 OB11 标准信封）
- Updated dependencies [be5845c]
  - @napuketto/network@0.0.2

## 0.0.19

### Patch Changes

- Updated dependencies [3f99e1f]
  - @napuketto/media@0.0.3

## 0.0.18

### Patch Changes

- Updated dependencies [7e35821]
  - @napuketto/kernel@0.0.15

## 0.0.17

### Patch Changes

- Updated dependencies [19baba2]
  - @napuketto/kernel@0.0.14

## 0.0.16

### Patch Changes

- Updated dependencies [426cf43]
  - @napuketto/kernel@0.0.13

## 0.0.15

### Patch Changes

- Updated dependencies [abbde2f]
  - @napuketto/kernel@0.0.12

## 0.0.14

### Patch Changes

- 45af90f: feat(adapter): Satori guild.member.mute 从 501 桩转真实现——接入 kernel GroupApi.setMemberShutUp（Satori duration 毫秒 → QQ 秒），群成员禁言能力接通。
- f807879: fix(adapter): OB11 record 段发送语音时，非 silk 音频自动转码为 silk（QQ 语音格式）再送 kernel；ensureSilk 上移为 adapter core 共享 helper（onebot11/satori 共用），kernel 不 import media 的解耦红线不变。
- Updated dependencies [555e284]
- Updated dependencies [ebc59b5]
  - @napuketto/kernel@0.0.11

## 0.0.13

### Patch Changes

- 7872faf: fix(release): 重新发布以修复 npm 包依赖泄漏——此前发布环节绕过 changeset 直发，published 包的 @napuketto/_ 依赖仍是 workspace:_，yarn create / npm install 被迫交互选版本或直接失败；release-npm.ts 现已在发布前把 workspace:\* 改写为 caret 真实版本（发布后恢复），本次随版本号重新发布修正依赖声明

## 0.0.12

### Patch Changes

- Updated dependencies [2c099aa]
  - @napuketto/media@0.0.2

## 0.0.11

### Patch Changes

- Updated dependencies [98c27a3]
  - @napuketto/kernel@0.0.10

## 0.0.10

### Patch Changes

- Updated dependencies [9b031ea]
  - @napuketto/kernel@0.0.9

## 0.0.9

### Patch Changes

- Updated dependencies [c60c34c]
  - @napuketto/kernel@0.0.8

## 0.0.8

### Patch Changes

- Updated dependencies [42a9786]
  - @napuketto/kernel@0.0.7

## 0.0.7

### Patch Changes

- Updated dependencies [d6f4b56]
- Updated dependencies [f744cf7]
- Updated dependencies [769d457]
  - @napuketto/kernel@0.0.6

## 0.0.6

### Patch Changes

- Updated dependencies [d6f4b56]
  - @napuketto/kernel@0.0.5

## 0.0.5

### Patch Changes

- Updated dependencies
  - @napuketto/kernel@0.0.4

## 0.0.4

### Patch Changes

- fix(kernel): 群列表数据源校准（2026-08-08，e27fb55）——原生 getGroupList 返回值无数据（仅 `{ result, errMsg }`），列表实际经 onGroupListUpdate 事件推送；GroupCache 新增 listGroups / listGroupsRefreshed；IPC 动作表与 OB11 / Satori 群列表动作改从缓存读，force / no_cache 触发原生刷新
- Updated dependencies
  - @napuketto/kernel@0.0.3

## 0.0.3

### Patch Changes

- 564e383: Barrel 规范化整理（纯结构重构，行为零变化，2026-08-08）：

  - **kernel**：`infra/`、`types/`（含 `listeners/`、`services/` 子 barrel）、`login/`、
    `bridge/`、`apis/` 各建 `index.ts` barrel；`index.ts` 与全 kernel 跨目录引用改走 barrel，
    同目录组内引用保持相对路径（`./result.js` 等）
  - **adapter**：`onebot11/action/index.ts` 升级为真正 barrel（re-export 全部 79 个动作类 +
    error-map + resolve-uid + Ob11ActionDeps + createOb11ActionRegistry）；`onebot11/api/`、
    `satori/api/` 单文件建统一入口；`satori/helper/` 建 barrel（config/error/ids/translate，
    element 子域独立 barrel 不绕行）
  - 包对外 API 签名不变（`packages/*/src/index.ts` 导出面未动）；`.fallowrc.jsonc`
    按 codec/element 先例补充新 barrel 的 ignoreFindings（目录公共面 re-export）

  `pnpm check` / 59 测试 / 全量构建 / fallow（dead files 0%、dead exports 0%）全绿。

- b9f06ca: DDD 目录重组（纯移动 + barrel，行为零变化，2026-08-08）：

  - **kernel**：`wrapper/` 拆出 `wrapper/probe/`（运行时反射探测子系统 5 文件 + barrel）；`index.ts` 改指 probe barrel
  - **adapter**：`satori/helper/` 拆出 `helper/element/`（消息元素域 7 文件 + barrel：解析/渲染/双向转换/资源）；`onebot11/helper/` 拆出 `helper/codec/`（CQ 编解码域 3 文件 + barrel）
  - **loader**：`host/` 拆出 `host/core/`（自建宿主引导编排 7 文件）；tsdown 入口与 `.fallowrc` manual entry 同步改 `host/core/self-host.ts`（产物 `dist/host/self-host.cjs` 路径不变，launcher 默认值无需改）

  全部为 git mv 文件移动 + import 路径调整（组内相对引用保持，跨目录走 barrel），`pnpm check` / 59 测试 / 全量构建 / fallow 全绿，无 API 变化。

- 8e64508: 按 fallow 建议重构 4 个 untested-risk 目标（先建 vitest 测试设施写基线，重构后回归）：

  - **测试设施**：根 `vitest.config.ts` + `pnpm test`（59 用例覆盖 4 个重构模块）
  - **kernel/result.ts**：unwrapResult 错误码映射链 → `RESULT_CODE_RULES` 查找表 + `mapResultCode` 纯函数（cyclomatic 10 → 4）
  - **kernel/probe-serialize.ts**：serialize 分支拆 `serializeContainer`/`serializeArray`/`serializeMap`/`serializeSet`/`serializeObject`（cyclomatic 16 → 6）
  - **adapter/segment.ts**：canonicalToSegment/segmentToCanonical if 链 → 判别式转换器映射表（cyclomatic 12/11 → 1/2）
  - **adapter/element-convert.ts**：elementToCanonical switch → 元素转换器映射表；媒体元素转换器（img/audio/video/file）拆分到 `media-convert.ts`

  全部为行为等价重构（59 测试回归通过，无 API 变化）。

- Updated dependencies [564e383]
- Updated dependencies [b9f06ca]
- Updated dependencies [8e64508]
- Updated dependencies [9005c43]
  - @napuketto/kernel@0.0.2

## 0.0.2

### Patch Changes

- 007e1ac: fallow 静态分析优化（克隆清零）：提取 `createWsServerSchema` 传输工厂（OB11/Satori 共用骨架，消除 config schema 克隆）；清理 4 处纯透传无用构造器（delete/set-essence-msg、satori guild.approve/member.approve）；loader smoke.ts 收敛重复文本提取逻辑为 `extractTexts` helper。
