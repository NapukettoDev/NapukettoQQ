# 专项审计复核

> 面向维护者，复核协议文件与出站边界、内核缓存、原生宿主和发布来源。正文链接到对应实现。

代码基线为 [`2156c35`](https://github.com/NapukettoDev/Napuketto/commit/2156c3553a0fddd8411d8cf68b7ea40b45fde8cc)。
复核了已合入的相关 PR 与远端待合入 PR。以下将静态判断与产物实测分别标明。
优先级反映触发条件和后续工作顺序。此次未对部署执行越权请求，未做内存压测、QQ 原生联调或原生全面审计。

## A. 协议文件与内网访问边界

### 本地读取与上传

任务 07 的实现和验收见[本地媒体隔离与资源引用](../packages/adapter/docs/evidence.md#任务-07-本地媒体隔离与资源引用)。
下文记录本页基线上的复核与提案。

**状态与优先级** · 静态确认缺少文件隔离，P1。协议凭据当前授予该账号传输上的动作调用能力，
文件读取范围随服务进程权限，未见按调用方或动作限制目录。可信同机集成读取共享媒体、上传文件是兼容能力。
若客户端只获准访问共享媒体，宿主其他可读文件仍会进入读取或上传链，这就是该部署下的越权。
触发前提是请求可达且获准分发、路径对进程可读，以及相应动作满足媒体格式、登录或发送目标条件。
静态证据可确认路径进入 I/O，实际发送、读取内容回传和影响范围仍需验证。

- **OneBot 11** · 消息 CQ/segment 的媒体字段原样进入 canonical 路径，再交给发送和媒体处理。
  `upload_group_file`、`upload_private_file` 明确接受裸路径及 `file://`，展开后交闪传。
  `set_qq_avatar` 将 HTTP(S) 下载到缓存，其余值经存在性检查后传给头像原生接口。
  消息段和头像动作均未专门展开 `file://`。`get_image`、`get_record` 的 `file` 参数用来定位消息，
  本地路径由原生消息或下载结果提供。
  [消息段](../packages/adapter/src/onebot11/helper/codec/segment.ts#L196) ·
  [发送](../packages/adapter/src/onebot11/action/message/send.ts#L53) ·
  [文件动作](../packages/adapter/src/onebot11/action/system/file.ts#L58) ·
  [头像](../packages/adapter/src/onebot11/action/system/account.ts#L141) ·
  [媒体查询](../packages/adapter/src/onebot11/action/message/media.ts#L200)
- **Milky** · 发送段解析时展开 `file://`，保留裸路径，并在发送时处理远端 URI。
  群／私聊文件及群头像、群公告图片使用 `resolveUriToPath`。文件动作将结果交闪传。
  `set_avatar` 直接走 `resolveMediaUri`，支持 HTTP(S) 和 base64，裸路径和 `file://` 会被下载器拒绝。
  [消息段](../packages/adapter/src/milky/helper/message/segments.ts#L447) ·
  [URI](../packages/adapter/src/milky/helper/message/media-uri.ts#L20) ·
  [群文件](../packages/adapter/src/milky/action/group-file.ts#L156) ·
  [私聊文件](../packages/adapter/src/milky/action/message-ops.ts#L84) ·
  [群管理](../packages/adapter/src/milky/action/group-manage.ts#L131) ·
  [账号头像](../packages/adapter/src/milky/action/profile.ts#L65)
- **Satori** · `message.create` 解析 `img/audio/video/file` 的 `src`。裸路径原样传递，`file://` 无专用展开分支。
  `internal:` 剥前两段，有 `_tmp/` 子串时再截其后部分，段不足时回退到剩余字符串。
  未校验平台、账号、段边界或根目录，也未将结果拼到 `cacheDir`。
  [动作](../packages/adapter/src/satori/action/message.ts#L34) ·
  [媒体转换](../packages/adapter/src/satori/helper/element/media-convert.ts#L28) ·
  [资源解析](../packages/adapter/src/satori/helper/element/asset.ts#L12)

共享 `fileUriToPath` 在解析失败时会剥前缀兜底。`protectMediaPath` 是受管缓存租约，普通路径直接返回。
下游 `MsgApi` 会对部分媒体做 `stat` 和文件哈希，闪传会把路径交原生上传。两处都需要在调用前完成策略检查。
[文件 URI](../packages/adapter/src/internal/qq/media.ts#L27) ·
[租约](../packages/adapter/src/internal/infra/media-cache.ts#L498) ·
[媒体读取](../packages/kernel/src/apis/msg.ts#L119) ·
[原生上传](../packages/kernel/src/apis/flash-transfer.ts#L68) · [缓存生命周期 PR](https://github.com/NapukettoDev/Napuketto/pull/162)

**未认证可达性** · 静态确认空 token 不挂鉴权。OneBot 11 和 Satori 的 HTTP/WS 服务默认列表为空，
显式启用服务时默认监听回环，Milky 段启用后默认回环且 token 为空。OneBot 11 反向 WS 的对端可下发动作，
连接时发送的 token 用于对端验客户端。配置非空 token 时，HTTP 和 OneBot 11 入站 WS 在动作前校验。
Satori WS 的 `IDENTIFY` 管事件接收，文件动作走 HTTP。可达的空 token 部署（本机不可信进程、代理或端口暴露等）
优先 P1 处置。当前证据未显示配置了 token 后存在匿名绕过，也未证明默认安装存在匿名远程利用，暂不定 P0。
[鉴权](../packages/adapter/src/framework/auth.ts#L84) ·
[监听默认](../packages/adapter/src/framework/transport-schema.ts#L14) ·
[OneBot 11](../packages/adapter/src/onebot11/transport.ts#L119) ·
[Milky 配置](../packages/adapter/src/milky/config.ts#L10) ·
[Milky HTTP](../packages/adapter/src/milky/transport.ts#L135) ·
[Satori 传输](../packages/adapter/src/satori/transport.ts#L184) ·
[鉴权 PR](https://github.com/NapukettoDev/Napuketto/pull/159) · [事件鉴权 PR](https://github.com/NapukettoDev/Napuketto/pull/152)

**设计与验收** · 在根 `napuketto.toml` 的 `[accounts.<协议>.media]` 按账号和协议配置 `localFilePolicy`、
`localMediaRoots`。存量缺省先映射为 `legacy`，保持当前路径兼容并告警，告警只含协议、动作与拒绝类别。
新模板用 `allowlist`，`localMediaRoots = []` 默认拒绝用户路径，显式列出媒体目录才能使用。
迁移期后把未配置值切到 `allowlist`，旧部署可显式暂留 `legacy`。策略也适用于反向 WS 入口。
新配置要求非回环动作监听器设非空 token，存量先告警。通过反代发布时，同样要求验证端到端鉴权。

- `allowlist` 以配置数据根解析相对根目录，用户相对路径只在已配置根内解析，多处命中须明确拒绝。
  严格解析 `file://`，拒绝网络路径、设备、ADS 和非普通文件。用真实路径及目录段比较判定归属，
  拒绝越根链接和 Windows junction。原生接收路径且稍后会重开文件时，把经安全句柄打开的内容复制到进程专用目录，
  在消费完成后清理。文件打开须约束目录链或使用部署方控制且调用方不可改写的根，以处理校验与打开之间的替换竞态。
- Satori 增设 `internalAssetPolicy = "strict" | "legacy"`，沿用同一迁移节奏。严格模式验证平台和当前账号，
  `_tmp` 只接受完整前缀段，排除空段、`.`、`..`、绝对路径、盘符及编码分隔符。仅解析到本账号的受管资源根，
  禁止回退裸路径。优先使用账号绑定的资源 ID。跨进程共享时使用显式配置的专用媒体目录。
- 在转码、`stat`、哈希或 NAPI 前完成校验。用受控文件和原生桩测试正常发送、默认拒绝、兄弟目录、
  符号链接／junction、竞态替换、跨账号、旧 URI 迁移以及 `internal:` 解析失败。分别测试无凭据、错误凭据、
  正确凭据和反向 WS 对端。已认证客户端也必须受媒体策略约束。覆盖头像、公告图、发送和闪传各入口。

### 下载出站

任务 06 的当前覆盖、迁移和验证记录见 [协议媒体出站验收](../packages/adapter/docs/evidence.md#任务-06-协议媒体出站)。
下文记录的是本页基线上的复核与设计提案。

**状态、前提与优先级** · 静态确认 P1 纵深隔离。可调用媒体下载动作的客户端可让宿主访问其网络可达目标。
PR #153 引入流式落盘、超时、大小限制和逐跳字面地址校验，明确保留私网和环回以支持 LAN 媒体及本机渲染服务。
PR #157 补齐 IPv4-mapped IPv6 的字面地址分类。
当前连接仍走普通 `fetch`，域名解析结果没有地址限制，也没有把校验结果绑定到实际连接。
[下载加固](https://github.com/NapukettoDev/Napuketto/pull/153) ·
[映射地址修复](https://github.com/NapukettoDev/Napuketto/pull/157) ·
[下载器](../packages/media/src/downloader.ts#L120) ·
[OneBot 11 下载](../packages/adapter/src/onebot11/action/system/file.ts#L81) ·
[Milky 下载](../packages/adapter/src/milky/helper/message/media-uri.ts#L20) ·
[Satori 下载](../packages/adapter/src/satori/helper/element/asset.ts#L42)

**设计与验收** · 同一 `media` 段新增 `outboundPolicy`，默认为 `compat`，保留 LAN 和环回。
隔离部署选 `public-only`，需要内部服务时由 `outboundAllow` 显式列出例外的主机、端口和 CIDR，默认空。
例外不得放开链路本地、未指定、多播和保留段。由 adapter 传策略给 media 下载器，每跳解析并检查全部候选地址，
规范化 IPv4-mapped IPv6，任一候选不合规即拒绝。连接绑定到本跳批准的地址并检查实际 peer。
TLS 继续校验原域名，跨源跳转不转发敏感头。合规后仍须保持当下的超时、大小和跳数限制。
严格模式的代理路径必须执行同等目标策略，否则拒绝。用受控 DNS、连接桩和本地测试服务覆盖混合 A/AAAA、
地址切换、重定向、例外匹配、TLS 和超时。确认兼容模式仍可用，严格模式拒绝时无出站连接或残留文件。

## B. 内核缓存生命周期

以下为静态结论。群列表、好友和活动群精华基线随账号实际数据量增长。
应先观察键数量、请求延迟与淘汰后的事件差异，再依据数据设容量边界。

| 缓存 | 状态、触发前提与优先级 | 设计选择与验收标准 |
| --- | --- | --- |
| GroupCache | 群列表在全量或空初始化事件清理。详情和成员表未随退群清理，成员事件只 upsert。退群、成员离开或只收到局部帧时可留下陈旧条目或返回不完整列表。P2 正确性。 | 保留完整群列表。先校准全量／增量／删除语义，按权威退群或删除事件清理。成员表显式区分完整、部分、失效。冷群按整群淘汰并在查询前完整回填。详情可按 TTL 或失效信号回填。验证退群、部分帧、空群、成员离开、并发刷新及消息富化。 |
| BuddyCache | 首帧建基线，后续全量快照做新增与删除 diff，旧条目被替换。正常占用随好友规模增长。不支持的载荷会保留旧基线。P3 校准。 | 保留全量 UID 和删除事件所需字段，优先评估能否缩小每条记录。验证真机回调是否全量，覆盖空列表、未知载荷、增删和重登首帧不误报。逐条 LRU 会把被逐出的好友误报为新增并漏报删除。 |
| EssenceListSync | OB11 和 Milky 各自实例化。按触发群串行拉全量、替换基线，空表仍保留群键。无逐群删除或显式 dispose。长期触达不同群会保留旧基线。慢拉取或回调可在同一链积压。P2。 | 先按权威退群信号删群，并在停用时清理状态、使在途结果失效。冷群淘汰会让下一帧只建基线，期间增删可能漏报，暂保留活动群基线。验证首帧、空基线后新增、删除字段回填、失败后恢复、退群和关停。合并重复触发前证明不会吞中间事件。 |

`GroupCache.unregister` 与 `BuddyCache.unregister` 由 `runtime.dispose` 调用，均退订并清表。
Group 的异步回填在 `await` 后仍写表，关停或跨代复用时旧结果可能回写。建议加代次和在途身份校验。
有 live 实例时，陈旧键及停用后回写构成可确认的保留路径。实例失去引用后的持续泄漏和量级尚未测得。
Essence 的 stop 路径退订入口，已入队任务仍可运行。正常进程退出会释放这些 JS 对象，
软重登、同进程停启与长时间运行需用可控 Promise 和堆快照独立验证。
[GroupCache](../packages/kernel/src/cache/group-cache.ts#L66) ·
[成员查询](../packages/kernel/src/cache/group-cache.ts#L206) ·
[BuddyCache](../packages/kernel/src/cache/buddy-cache.ts#L182) ·
[EssenceListSync](../packages/kernel/src/cache/essence-cache.ts#L165) ·
[运行时释放](../packages/kernel/src/runtime.ts#L165) · [OB11 停用](../packages/adapter/src/onebot11/adapter.ts#L225) ·
[Milky 停用](../packages/adapter/src/milky/adapter.ts#L150)

## C. 架构与运行时声明

### 自建宿主引导

**状态、前提与优先级** · 静态确认 P2 架构冲突。Windows/Linux 自建宿主子进程先由 loader 的 CJS 入口直接
`process.dlopen`，再注册 O3 原生 listener，最后 `bootstrap` 动态导入 kernel。两处调用都越过 `AGENTS.md`
规定的唯一原生层。kernel 已有加载和 O3 激活原语，且 O3 的幂等记录只覆盖经过该原语的调用。
loader 后续还有直接读取 session exports 的探测。CJS 可动态 `import()`，启动早期的真实时序约束需实机确认。
[工程指南](../AGENTS.md#L21) · [self-host](../packages/loader/src/host/core/self-host.ts#L132) ·
[导入 kernel](../packages/loader/src/host/core/bootstrap.ts#L162) ·
[session 探测](../packages/loader/src/host/core/session.ts#L75) ·
[kernel 原语](../packages/kernel/src/wrapper/wrapper-loader.ts#L521)

**设计与验收** · 优先由现有 CJS 壳获取锁并初始化日志和 IPC，再动态导入 kernel 的轻量宿主入口。
通过单一语义 API 完成加载、原生导出校验、O3 激活及 attach，返回语义句柄，探测也经 kernel API。
若提前导入完整 index 有可证实的副作用，新增 kernel 子路径入口，避免 loader 编译期依赖 kernel。
备选是直接 spawn kernel 拥有的宿主入口，loader 仅准备环境和启动。此方案边界更强，代价是迁移 IPC、
退出语义和外部 launcher 参数，须用运行时回调避免 kernel 反向依赖 loader。
保持规则原文。用边界扫描和 Windows/Linux x64 真实 stub 验证单次加载与激活、登录、事件、软重登、关停，
以及缺入口、导出不匹配、IPC 状态和配置失败退出码 `78`。桩测试只验证调用顺序与错误出口。

### Node 支持口径

**状态、前提与优先级** · 确认 P2 声明漂移。根与七个发布包 `engines.node` 都是 `>=22.12.0`，
发布元数据测试锁定此值。`tsconfig` 为 `ES2025`，用于 TS 检查。构建调用 tsdown，未显式覆盖 target，
本地构建日志确认 tsdown 从 engines 取最低版本 `node22.12.0`。README 的运行环境写 24+，CI/发布用 Node 24，Docker
从固定摘要的 Node 24 builder 复制 Node 到 Debian 运行镜像。构建目标、安装声明和 CI 通过各自覆盖不同范围，
Node 22 上的发行包及原生宿主兼容性未实测。触发是使用安装元数据允许、当前支持矩阵缺少覆盖的 Node 版本。
[根清单](../package.json#L30) · [元数据测试](../tooling/package-exports.test.ts#L141) · [TS 配置](../tsconfig.json#L2) ·
[构建配置](../packages/loader/tsdown.config.ts#L18) · [README](../README.md#L35) ·
[CI](../.github/workflows/ci.yml#L87) · [发布](../.github/workflows/release.yml#L194) · [Docker](../docker/Dockerfile#L36)

**设计与验收** · 若继续声明 22.12 为完整运行下限，增加 22.12/24 发行包安装和入口检查，并在 Windows/Linux x64
验证 stub 导入、登录、一次发送和事件收取，Docker 检查镜像内真实 Node 版本及同样的宿主冒烟。
若仅支持 Node 24 宿主，优先将 CLI、loader 和创建器的宿主声明与文档、测试同步。其余库若保留 Node 22，
为其单独声明和验证 JS 支持范围。变更稳定下限时按破坏性变更迁移并更新元数据测试。

### kickMemberV2 参数

**状态、前提与优先级** · P2 待 probe。调用群踢人动作才会到该 NAPI。`kickFlag`、`kickList` 和 `optFlag`
的语义仍有校准 TODO。当前测试使用 mock，只证明请求组装和错误处理。
[调用](../packages/kernel/src/apis/group.ts#L156) · [类型](../packages/kernel/src/types/services/group-service.ts#L20) ·
[测试](../packages/kernel/src/apis/__tests__/group-api.test.ts#L270)

**设计与验收** · 先通过 `kernel/src/wrapper/probe/` 获取真实 wrapper 的可观测接口，再用授权测试群记录已知正确
调用的脱敏形状、QQ／平台版本、返回码、成员状态和重新申请结果，覆盖普通踢出、拒绝再入群及无权限。
签名反射无法确认字段含义时保留待验证状态，等行为证据齐备再更改类型与测试。

## D. 私有 native 源码、构建与发布

**状态、前提与优先级** · P2 供应链透明度与来源证明。对能检出私库的审计者，gitlink 固定在
`2e76158217d7872ff57140dec0a90c5b2a90d9d7`，本地可读 Windows 转发和媒体补丁 C++、`.def`、Linux stub C++、
CMake、Linux 构建脚本及两份预编译文件。CMake 输出到 `build/`，Linux 脚本可同步进 `prebuilt/`。
发布 workflow 递归检出，校验 `npm pack --dry-run` 中两件文件存在，并发布入库的预编译副本。
公开 CI 不检出私有子模块。PR #164 处理的是 7-Zip 完整性、Action 与镜像固定。
两份 stub 在自建宿主启动时以宿主账号权限加载。闭源限制独立审阅，当前证据未指认具体 C++ 缺陷。
[gitlink 配置](../.gitmodules) · [文件清单](../packages/loader/package.json#L35) ·
[发布检出](../.github/workflows/release.yml#L178) · [打包门禁](../.github/workflows/release.yml#L268) ·
[公开 CI](../.github/workflows/ci.yml#L29) · [构建依赖加固](https://github.com/NapukettoDev/Napuketto/pull/164)

**产物实测** · npm `@napuketto/loader@0.10.6` 的 tarball SHA-512 与 registry `dist.integrity` 一致，
包内两个 stub 逐字节等于发布 tag 所指 gitlink 的本地副本。
解码的 npm SLSA statement 的 subject digest 也匹配 tarball，记录主仓的 `release.yml` 和触发提交 `f7fb4fb`。
本次未独立验证 attestation 签名，未重编或加载 stub。上述证据表明包内字节可追到入库副本，
源码如何编成这两个副本仍缺每平台构建证明。
[发布 tag](https://github.com/NapukettoDev/Napuketto/tree/@napuketto%2Floader@0.10.6) ·
[Registry 元数据](https://registry.npmjs.org/@napuketto%2floader/0.10.6) ·
[npm attestation](https://registry.npmjs.org/-/npm/v1/attestations/@napuketto%2floader@0.10.6)

| 包内文件 | SHA-256 |
| --- | --- |
| `native/prebuilt/win32-x64/QQNT.dll` | `b15a9bf5a857b2f88bcbabea96db03235d3edef442803b24f00f118b030a9532` |
| `native/prebuilt/linux-x64/libnapuketto_stub.so` | `675eb9449aefb796d6a73f616b5913520340cb66bda10498446fd8cf686b70ca` |

**设计与验收** · 专项审计覆盖 PE 导入／导出和符号转发、ELF 预加载及库搜索路径、ABI/初始化/清理、
补丁版本门禁与失败退出、内存边界、并发、依赖和磁盘写入。用匹配及不匹配 QQ 版本确认兼容、降级和无安装目录改写。
私有 CI 用固定工具链从 gitlink 构建两平台，签发绑定源码提交、构建配方、工具链摘要与逐件 SHA-256 的证明，
发布门禁验证签名及 subject，比较构建产物、入库副本和待发布 tarball。公开提供摘要、构建身份、验证步骤及
导入／导出清单。验收包括两平台干净重建与字节对比、篡改或错配时阻断，以及发布后下载校验。
若构建尚不可复现，记录二进制差异来源并校验受信构建到 npm 的传递链。
