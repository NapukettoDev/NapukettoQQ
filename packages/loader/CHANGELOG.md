# @napuketto/loader

## 0.7.5

### Patch Changes

- 3807d6f: feat(loader): 装配 kernel `FlashTransferApi` 并透传到 OB11 / milky / IPC 桥
  
  文件投递动作（`upload_group_file` / `upload_private_file`）需要闪传通道，loader 在
  `createKernelServices` 构造 `flashTransferApi`，`assemble-protocols` 与 `ipc-ob11`
  透传进 `OneBotApiOptions` / `MilkyApiOptions`（richMediaApi 同款）。

## 0.7.4

### Patch Changes

- 7fac4ad: fix(loader): 协议事件隔离——一协议一 EventBroadcaster，Satori 段存在才装配
  
  此前 OB11 / Satori / Milky 三个适配器共用同一个 `EventBroadcaster`，各协议把传输
  注册到同一实例，任一协议 emit 的事件会推给所有协议的客户端：只配
  `[accounts.onebot11]` 的账号也能在 OB11 WS 端口收到 Satori 形态事件
  （`{"op":0,"body":{...}}` 夹在合法 `post_type: meta_event` 心跳之间），多协议同时
  启用时事件流不可判型。
  
  - 每协议独立广播器（`ob11Broadcaster` / `satoriBroadcaster` / `milkyBroadcaster`），
    只传给对应 adapter；Kurobot 是纯客户端出向协议，无广播器（不变）。
  - Satori 改为「账号段非空才装配」，与 Kurobot / Milky 同范式；未配置 satori 的账号
    不再订阅 kernel 事件、不再向空传输广播。teardown 判空后 stop。
  - IPC 桥（`ipc-ob11.ts`）的广播器不动——独立进程边界。
  - 单测补充：只有 `[accounts.onebot11]` 时 satori 构造器零调用；OB11 + Satori 同时
    启用时两者收到的 broadcaster 不是同一实例。

## 0.7.3

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

## 0.7.2

### Patch Changes

- e1957db: fix(loader)：Linux 非 x64 架构不再使用内置 x64 `7zz`（arm64 解 deb 不再 `cannot execute`）
  
  内置 `assets/7zip/7zz` 是 x86-64 ELF，在 arm64 上执行会直接 `cannot execute`（arm64
  容器实测），导致 `ensureQqFiles` 的 deb 解包在 arm64 上必然失败。现在按架构分流：
  
  - 新增 `bundledSevenZipSupported(platform, arch)`（Linux 仅 x64 用内置）与
    `findSystemSevenZip(path)`（PATH 扫 `7zz` → `7z`）
  - `findSevenZip()`：`NAPUTO_7Z_PATH` > 内置（适用架构）> 系统 PATH
  - `ensureLinuxSevenZip({ arch })`：非 x64 跳过内置/缓存/官网下载（三者都是 x64 产物），
    直接用系统 7-Zip；没有时抛可读错误（提示装 `7zip` / `p7zip-full` 或设 `NAPUTO_7Z_PATH`）
  
  x64 Linux 行为不变（继续用内置 7zz，零网络依赖）。arm64 交付前其余缺口见
  `docs/architecture/linux-native-host.md` 附录 E.2。

## 0.7.1

### Patch Changes

- d513251: fix(loader): 发布包补上 Linux stub（`native/build/linux-x64`），`NAPUTO_LINUX_NATIVE=1` 不再报 stub 未找到
  
  `files` 此前只列 `native/build/stub-test-env`（Windows `QQNT.dll`），已发布的 0.6.0
  tarball 里没有 `libnapuketto_stub.so`——Linux 用户开原生分支会直接命中
  「Linux stub 未找到」。现在把 `native/build/linux-x64` 加进白名单，并在发布链与
  `tooling/package-exports.test.ts` 各加一道守卫（`npm pack --dry-run` 断言 Linux `.so`
  入包 / 断言 `files` 含该目录），防止后续回归。

## 0.7.0

### Minor Changes

- 3574077: feat(loader): Linux 原生分支识别本地 deb 安装（`/opt/QQ` 扁平布局）
  
  deb 装出来的 QQ 是扁平结构（`/opt/QQ/qq` + `/opt/QQ/resources/app/wrapper.node`），
  没有 Windows 的 `versions/<版本>/resources/app/`，此前 loader 只认 `versions/`，
  Linux 用户本机装了 QQ 也会被当成未安装、白下 190MB deb。新增 L1b 探测（仅 Linux
  原生分支，`NAPUTO_QQ_DIR` 可覆盖）：校验 wrapper 为 ELF、版本取自
  `resources/app/package.json`（缺失即跳过，不猜版本），命中即用本机安装，优先于
  数据根缓存。实测 `/proc/<pid>/maps` 确认加载本机 wrapper、数据根未生成 `qq-files/`、
  快速登录成功、优雅退出 `code=0`。Wine 分支行为不变。

## 0.6.1

### Patch Changes

- 61d9aa6: fix(loader): Linux 原生宿主收敛 `HOME`/`XDG_*`，Bugly 崩溃目录不再写入用户目录
  
  `libbugly` 的 `NativeCrashHandler` 无视 `desktopGlobalPath`，固定向
  `$HOME/.config/QQ/crash_files/` 写崩溃记录（Stage 0b 发现）。原生分支现在把子进程
  `HOME` 收敛到 `<数据根>/home`（`NAPUTO_LINUX_HOME` 可显式覆盖，无数据根时退到
  `<账号目录>/home`），并把 `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
  `XDG_STATE_HOME` 派到该目录下；实测崩溃目录落在受管目录、用户 `$HOME` 零写入，
  快速登录与优雅退出不受影响。wine / win32 分支行为不变。

## 0.6.0

### Minor Changes

- fa5ee20: feat(loader): Linux QQ 原生文件 deb 管线（Stage 2）——清单 schema 2 增加平台/架构/核心版本，Linux 自动下载官方 deb 并用内置 7zz 三层解包，提取 `wrapper.node` / `major.node` / `*.so*` / `sharp-lib/` 到与 Windows 同构的缓存布局；Linux 原生模式定位阶段校验 ELF，拒绝误用 Windows 安装文件。
- 94d6d3c: feat: Linux 原生宿主 Stage 1（平台参数 + `NAPUTO_LINUX_NATIVE` 开关分支）
  
  - kernel：按 `process.platform` 生成 KLINUX/KMAC/KWINDOWS 平台参数；qua 优先从
    `major.node` 扫描，`buildEngineConfig` / `buildSessionConfig` 支持显式平台覆盖。
  - loader：新增 Linux 原生分支（标准 node + 最小 stub `.so` + `libgnutls` 预加载），
    缺省关闭，Wine 仍是现行实现。
  - native：新增 Linux stub 源码、构建脚本与 x64 预编译产物。

### Patch Changes

- dd2e4ad: fix(kernel): Linux 原生宿主的 QQ 数据根改用 Napuketto 数据根（`<数据根>/nt_qq`），不再读写 `$HOME/Documents/Tencent Files`；`resolveQqUserDataRoot` 新增平台分流与 `dataRoot` 选项，loader 经 `NAPUTO_DATA_ROOT` 注入。

## 0.5.1

### Patch Changes

- c246bcc: 原生噪音表补 Chromium 原生日志行：QQNT 原生层把内部进度也标 ERROR 级写 stderr（QUIC 建链/关链、session stats 报告等），每次 spawn 稳定刷屏 70+ 行。CLI 转发与 koishi IPC 两条路径经共享判定同步过滤；FATAL 行不过滤（崩溃现场保留），wine/node 启动报错非此格式不受影响。

## 0.5.0

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

## 0.4.3

### Patch Changes

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

## 0.4.2

### Patch Changes

- a668d31: feat(kernel,loader): listener 录制器——Milky 批次三前置探测（milky.md §0.8）
  
  批次三（5 个无源事件 + get_private_file_download_url）没有可盲装的方法名，
  缺的是回调证据：现有 bridge 只注册已知回调名（Msg 7 / Group 9），原生 listener
  回调面之外的派发行为从未被观测。本批交付录制器工具，不接任何协议行为。
  
  kernel 新增 `startListenerRecording` / `createRecordingListener`
  （wrapper/probe/probe-listener.ts）：Proxy get 陷阱构造万能监听器——任意字符串
  属性访问返回记录函数（同时记录原生查过的名字），has / ownKeys 陷阱一并记录
  （判定原生按名 Get 还是枚举发现回调），记录函数绝不反向调用原生。
  
  - 仪器面：Msg / Group / RecentContact / BdhUpload / OnlineStatus / Lock /
    FileAssistant / Buddy / ProfileLike / NodeMisc 十服务 + LoginService 单例；
    add/remove 方法按 `/^add(Kernel)?\w*Listener$/` 自动选取（裸 addListener 同规则）。
  - 产物 `NAPUTO_CFG_DIR/napuketto-listener-record.jsonl`：每回调一行
    `{ts, service, event, args}`（截断序列化），注册过程逐行落盘，原生崩溃保留断点。
  - ⚠️ 时序硬约束：loader 在 runProbePhase 之前挂起——probe 的 getMainSession
    写回副作用会把空壳主 session 毒化进 ctx.session（late probe 61/63 getter
    null 的根因），录制器必须先取服务。
  - 与业务 bridge 共存（addKernelXListener 多监听独立 id），单测 7 例。
  
  用法：`NAPUTO_LISTENER_RECORD=1` 启动后按 milky.md §0.8.2 实机操作单
  （发消息 / 表情回应 / 置顶 / 精华 / 收发文件）产生录制窗口，jsonl 交回分析，
  据此接批次三 kernel 出口。

## 0.4.1

### Patch Changes

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

## 0.4.0

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

## 0.3.0

### Minor Changes

- 51a0ce8: feat(milky): Milky 协议适配器 P0（第四协议，目标 Milky 1.3.0）——
  
  - adapter：`@napuketto/adapter/milky` 子路径导出 `NapukettoMilkyAdapter` + `milkyConfigSchema`。单端口 HTTP（`POST /api/:api` 规范信封 + 401/404/415 语义；`GET /event` SSE/WS 事件推送）+ WebHook；P0 动作 9 个（get_login_info / get_impl_info / send_private_message / send_group_message / get_message / recall_*_message / get_friend_list / get_group_list），事件 2 个（message_receive 三场景 / message_recall）；类型层为官方 JSON Schema 的自研描述（P0 子集）；seq↔msgId 走 adapter 侧 MessageSeqIndex 双向映射（接收登记 + 历史扫描兜底）；发送核心含媒体 URI 解析（file:// / base64:// / http(s):// 落盘）
  - network：SSE 事件流原语（`createSseResponse`）+ `HttpServer` 流式响应注入点（`onRawRequest`）与同端口 WS 升级注入点（`onUpgrade`）+ 空 body 响应支持（respond undefined）——均协议无关
  - loader：`[accounts.milky]` 账号段读取与装配分支（段存在才装配，enabled=true 生效）
  - cli / create：账号配置 schema 增 `milky` 段，配置模板与脚手架模板同步

## 0.2.0

### Minor Changes

- a120cdd: feat(loader): 支持 NAPKETTO_CONFIG_JSON 内联配置（嵌入式宿主契约）。主配置来源优先级全链统一为 NAPKETTO_CONFIG_JSON > NAPKETTO_CONFIG > NAPUTO_CFG_DIR 兜底：内联生效时零 toml 文件读取，协议段（按登录 uin）与 [log] 段均取自内联 JSON，cfgFile 返回哨兵 "<inline>"。协议段 seed 的 zod 校验失败包装为 ConfigError 并沿 startProtocols/bootstrap 重抛，self-host 以 78（EX_CONFIG）退出，宿主据此区分配置未就绪与运行时崩溃、免重启。

## 0.1.0

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

## 0.0.39

### Patch Changes

- 2378209: fix(loader): 发布产物恢复 native/build/stub-test-env（stub QQNT.dll）——0.0.36 起发布流水线 checkout 未检出私有 submodule，`files` 条目匹配不到文件被 npm 静默忽略，零配置自建宿主报「stub QQNT.dll 未找到」。发布流水线把 NapukettoBot App 安装到私有仓 Napuketto-Native 并于 checkout 检出 submodule，新增 `npm pack --dry-run` 打包守卫断言关键资产入包；包内补 NOTICE 澄清该 DLL 为自研符号转发 stub、非腾讯原始二进制

## 0.0.38

### Patch Changes

- 677f0ed: fix(kernel/loader): 修复视频消息经 IPC 传输后 thumbPath 丢 Map 形态导致接收链路崩溃与缩略图路径丢失
  
  - kernel：`toCanonicalElements` 读 `videoElement.thumbPath` 改为防御式（`readVideoThumbPath`）——进程内为 `Map<0, path>`，经 JSON/IPC 序列化后退化为平面对象 `{"0": path}`（未规整链路为空对象 `{}`），原实现直接 `.get(0)` 抛 TypeError，整条视频消息事件分派失败（koishi IPC 模式 2026-10-24 线上报错）；类型契约同步放宽为 Map / 平面对象 / 字符串联合
  - loader：IPC 编码（`encodeIpcMessage`，`sendIpc` 统一改走该出口）出站前经 `toJsonSafe` 深规整——`JSON.stringify` 会把 Map 内容全丢（Map → `{}`、Set → `[]`），此前事件 args 里的视频缩略图路径与动作结果（如 `uinToUid` 返回的 `Map`）跨进程后全部丢失；规整后 Map → 平面对象、Set → 数组，配合 kernel 侧防御读取，缩略图路径跨进程完整保留

## 0.0.37

### Patch Changes

- 0e8a808: fix(packaging): `exports["."]` 顶层补 `types` 条件，修复 NodeNext 类型解析
  
  双格式包（`dist` 同时产出 `.mjs` / `.cjs`）此前只在 `import` / `require` 分支内声明
  `types`，只读取顶层 `types` 条件的解析器拿不到声明文件。现于 `exports["."]` 顶层补
  `"types": "./dist/index.d.mts"`，并保留分支内各自的 `types`——顶层这行必须排在
  `import` / `require` 之后，否则 CJS 消费者会被条件匹配劫持到 ESM 声明文件
  （attw: Masquerading as ESM）。
  
  新增 `tooling/package-exports.test.ts` 锁定该形状；attw（node10 / node16 CJS /
  node16 ESM / bundler）与 TS 5.9 / 7.0 消费者矩阵验证通过。

## 0.0.36

### Patch Changes

- cb4bd37: chore(release): 接入 npm OIDC 可信发布与 PR-only 门禁（无功能变更，一次性 patch 用于实证发布链）
  
  - 新增 `.github/workflows/release.yml`：合并带 changeset 的 PR 后，prepare 消费 changeset、构建、测试并推送版本提交；publish 在 `release` environment 审批后逐包 `npm publish`（OIDC 短时 token，无长期凭证，自动 provenance）。
  - 发布前逐包预检 npm 信任配置（`tooling/release/release-trust.ts`），缺配置整批不发，杜绝半批发上 npm。
  - 发布链拆成 `release:version` / `release:build` / `release:test` / `release:publish`，本地 `pnpm release` 复用同口径，仅作演练与应急。
  - CI 增加 `merge_group` 触发，配合主分支 merge queue 与必需状态检查；一切改动走 PR（发布链的版本提交是唯一既定例外）。

## 0.0.35

### Patch Changes

- b7651ae: fix(loader): 修复 QQ 官方安装包下载 403（追踪 issue #6 连续 18 天日报的真因）
  
  根因不是「腾讯 CDN 封数据中心 IP」，而是 CDN 边缘 WAF 有一条**区分大小写**的规则匹配
  字面量 `/QQNTV2/` 路径段：命中后边缘直接返回 `403`（`Content-Length: 0`）且**不回源**，
  而源站对路径大小写不敏感——同一请求只把路径段写成小写 `/qqntv2/` 即正常返回。修复：
  新增 `normalizeDownloadUrl()`，在唯一出站口 `downloadFile()` 统一归一化（同时覆盖清单 URL
  与 `NAPUTO_QQ_URL`），清单内仍保存官方原样 URL 以便追溯，腾讯日后修掉该规则也无需回改。
  CI 更新脚本（`scripts/qq-releases/update-qq-releases.ts`）同步归一化，qq-releases.json
  随之补齐到 9.9.36。另修掉内置 `7zz` 缺失的 git 可执行位（原 `100644`，Linux/CI 上
  `execFile` 直接 EACCES，7-Zip 解析实为死代码、一直静默回退字节扫描）。

## 0.0.34

### Patch Changes

- d3ebd4d: fix(loader): 跨平台路径归一化——反斜杠 Windows 路径在 Linux（WSL/CI ubuntu）下 `basename`/`dirname` 不认 `\` 分隔符导致误判：`isNodeExecutable` 对反斜杠路径恒判非 node、`resolveQqInstall` 切错安装目录（报「QQ 版本目录不存在」）。非 win32 平台先归一化分隔符再取基名/父目录，win32 行为保持不变。

## 0.0.33

### Patch Changes

- d5c21ca: fix(loader): 引导装配补在线状态注册（真机终验发现 I：半在线导致服务端不推送消息）
  
  `createKernelServices` 在 session 就绪后调用 `MsgApi.setOnlineStatus`（status=10，
  与 OB11 set_online_status 动作缺省一致）。此前自建宿主引导链无人调 setStatus——
  真 QQNT 客户端启动即上报在线，缺这一步 = NT 会话半在线：msf 连接可用、消息可发，
  但腾讯侧设备不在线，服务端不推送实时消息（群消息收不到、他端显示「电脑未登录」；
  2026-09-15 KuroAdapter 真机终验出站方向全通、入站零到达，实证定位）。注册失败仅
  告警不阻断 boot。IPC 与协议（cli）模式共用此装配面，软重登重装配时自动重报。

## 0.0.32

### Patch Changes

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

## 0.0.31

### Patch Changes

- 30eeeed: fix(loader): cli（非 IPC）模式 loader logger 同步落盘 logs/loader.log——此前仅 IPC 模式落盘，cli 模式 poke/Buddy 校准等诊断数据全部丢失；console 输出保持不变，IPC 模式关 console 行为（stdout JSON 行协议保护）不变
- c36bac0: fix(loader,cli): instance-lock pid 复用根治——pid 探活通过后新增 cmdline 二次校验（新模块 pid-cmdline：Windows 走 PowerShell Get-CimInstance 跨进程查询、Linux 走 /proc，查不到或与锁内摘要不一致视为持有者已死自动接管，根治 2026-09-08「pid 被无关进程复用导致永久拒绝启动」事故）；写锁时自动填本进程命令行摘要（调用方无需显式传）；cli 启动预检走同一判定自动生效，误报提示文案更新

## 0.0.30

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

- 68d34de: fix(loader): 登录控制相位机——引导失败后迟到的 control login 成功不再误发 logged_in（防 failed→logged_in 误导序列）；ready 态 control login 原地软重登（清理旧装配面后用新登录结果重跑装配链，免整进程重启）；cli 模式 OB11/Satori 装配失败不再被内部 catch 吞错（回归「判引导失败退出」的既有意图）

## 0.0.29

### Patch Changes

- f13c291: feat(loader): control login 登录期抢占——初始 doLogin 与 control login 竞速（快速登录风控挂起时强制扫码/重登的结果接管装配链）；新增 NAPUTO_QR_ONLY 强制扫码环境变量（launcher qrOnly 选项透传）；修正 ipc-types「预留」过时注释
- 43a42e1: feat(media/adapter/loader): get_image/get_record 接主动下载——media 包新增 downloadUrl/inferExtension（fetch + 大小上限 + 超时）；get_image 本地 NT 相对路径按 mediaBaseDir（QQ NT global 目录，装配链经 resolveQqUserDataRoot 解析注入）解析，未命中且有 picUrl 时下载到 cacheDir/media 返回 file；get_record 本地解析命中返回绝对路径（语音主动下载缺口：downloadRichMedia 原生签名未探测，待实测后接入）
- 968ed50: feat(kernel/adapter/loader): OB11 request 事件链接线——FriendBridge 好友事件桥（onBuddyReqChange 等回调，方法名来自 wrapper.node 字符串证据）+ OB11 适配器订阅群通知/好友申请推送翻译 request 事件（friend/group_add/group_invite，flag 与应答动作匹配路径一致），loader 装配 Buddy 通道并 IPC 转发

## 0.0.28

### Patch Changes

- 207d556: fix: koishi IPC 通道移植原生噪音过滤——wrapper 原生输出整行不再混入协议流

  cli 的 NATIVE_NOISE 过滤移植为 loader 共享助手 `isNativeNoiseLine`（`host/ipc/native-noise.ts` 单一来源，cli 与 koishi IPC 路径同源；IPC 协议行按 `{"v":1` 前缀构造性豁免，防载荷含噪音样文本的消息事件被误滤）。koishi 插件 `ChildProcessIpcTransport` 的 stdout/stderr 行回调接入过滤：整条原生噪音行（MMKV 刷屏 / 符号查找警告等）静默丢弃、不进 onJunkLine 撕裂诊断通道——噪音 ≠ 撕裂，协议行被插断的撕裂仍由 status 重播与脏行诊断兜底。

- ea754ff: 修复 IPC 模式文件日志 ANSI 污染：消息日志 logger 落 plain（IPC 为纯文件 JSON 日志），cli 终端保持彩色；顺带简化 createLoginControlHandler 内仅 IPC 注册路径可达的 ipcMode 死分支

## 0.0.27

### Patch Changes

- 0c51759: 修复自建宿主「登录失败仍上报 ready」：bootstrap() 全链返回 boolean 结果信号，各失败路径（登录失败、协议服务装配失败、kernel 导入/导出异常等）不再被静默吞掉后误报 ready。引导未完成时 IPC 模式补发通用 status failed（已发过带具体错误码的 failed 如 NOT_LOGIN 时不覆盖）并以 exit code 1 退出，交由 koishi driver 既有重启循环接管；cli 模式失败同样退出，不再留驻。附带修复非 IPC 模式 OB11/Satori 装配失败不再 fail-soft 常驻。

## 0.0.26

### Patch Changes

- 02c5b13: fix: IPC 模式「能收不能发」根治——子进程 stdout 承载 JSON 行协议，却被两处 pino console 流（kernel NapukettoCore.create 与 loader kernel-services 的 createLogger）并发写入，协议行撕裂后 koishi 侧解码失败静默丢弃，恰逢 bootstrap 尾部日志密集窗口丢失 status ready，事件照常派发但发送全抛「子进程未就绪（等待驱动连接）」。四层修复：① IPC 模式（NAPUTO_IPC=1）两处 logger 关 console、改文件落盘（kernel logs/napuketto.log 原有，loader 新增 logs/loader.log），cli 输出不变；② 新增 control status 查询指令——子进程快照最近 status 并重播，防原生 printf 直写 fd 等 JS 层拦不住的残留污染；③ driver 自愈：收到 event 但状态未 ready（5s 节流）或 booting 超时（20s 定期）主动查询，ready 分支加幂等守卫防重复 onReady；④ IPC 脏行不再静默丢弃——双侧（koishi client onJunkLine debug 日志 + 子进程 boot 日志）留痕。

## 0.0.25

### Patch Changes

- d611f72: fix(loader): win32 非 node 宿主（Bun 运行时的 koishi 等）自动解析真 node.exe 作自建宿主——此前盲用 process.execPath，Bun 下宿主为 bun.exe，stub QQNT.dll 绑定 node.exe 符号致 wrapper.node dlopen 报 1114「DLL 初始化例程失败」。解析顺序：显式（winNodePath 参数 / NAPUTO_WIN_NODE_PATH）> 系统 PATH node > ensureWinNode 下载（缓存幂等）。

## 0.0.24

### Patch Changes

- be5845c: feat: Koishi 插件 IPC 模式整表挂载 OB11 动作容器（79 动作 + ob11 事件透出）——① loader 新增 ipc-ob11 桥：检测 NAPUTO_ADAPTER_ENTRY/NAPUTO_NETWORK_ENTRY 注入时动态 import adapter/network，实例化 NapukettoOneBot11Adapter 仅 subscribeOnly()（接收链路，零网络传输/零配置文件 IO），全部动作名平铺合并进共享 IPC 动作表，OB11 事件经 broadcaster → sendEvent("ob11") 透出，装配失败 fail-soft 降级；② adapter 新增 subscribeOnly()/unsubscribeOnly() 公共方法与公开 registry（IPC 桥枚举挂载用）；③ adapter/network 根导出补 require 条件（koishi 插件 CJS 产物 createRequire.resolve 定位入口用，实际消费仍走 ESM 动态 import）；④ koishi 插件新增 @napuketto/adapter/@napuketto/network 依赖与 ob11Actions 配置（默认开），launcher 透传入口，bot.onOb11 暴露原始 OB11 事件订阅口，bot.internal.\_request("send_like", ...) 直达全部 OB11 动作（返回 OB11 标准信封）

## 0.0.23

### Patch Changes

- 784036b: fix(loader): WSL 生产事故修复——① Linux spawn 前预检 wine（缺失抛可读错误 + apt 指引），并挂 child 'error' 监听兜底，此前 spawn ENOENT 异步 'error' 无监听者直接 uncaughtException 崩掉整个 koishi；② ensureQqFiles/launchSelfHost 新增 onStage 阶段回调（下载/校验/解包/提取/win-node/spawn 全程日志），首次下载 313MB 安装包不再静默；③ 下载 tmp 文件唯一化（pid+时间戳）并解包前校验存在性，修复「下载成功但 7z 解包报 No such file or directory」并发竞态；④ downloadFile 完成态 stat 校验（缺失/空文件立即报错）

## 0.0.22

### Patch Changes

- 7e35821: fix(kernel): recallMessage 防御脏参数（null/空字符串不再裸抛 TypeError 或透传到 wrapper 层报「无错误详情」，统一抛 INVALID_PARAM；混合脏值只撤回有效 msgId）

## 0.0.21

### Patch Changes

- 47bb6d2: fix(loader): IPC msg.sendMessage 发送前 at 目标归一化——uin（QQ 号）转 uid 并补群成员昵称 display，修复 koishi 插件 at 指定群成员时「@号后面为空」问题（issue #1）

## 0.0.20

### Patch Changes

- 19baba2: fix(kernel): 修复 sendMsg 失败导致子进程崩溃（unhandledRejection）

  `MsgApi.sendMessage` 中若 `service.sendMsg` 抛错（wrapper 内部异常），已注册的
  `confirmSend` 确认 Promise 无人消费，随后 `onMsgInfoListUpdate` 确认事件
  （sendStatus=0）触发 `reject` 时变成 unhandledRejection，Node 默认抛错退出，
  直接拖垮整个子进程并连带 IPC 通道关闭。现预消费 confirm 的 rejection 兜底，
  失败语义不变。loader self-host 同步加 unhandledRejection 日志兜底（不退出），
  防止同类漏网 rejection 再拖垮进程。

## 0.0.19

### Patch Changes

- fix(loader): 修复私聊/临时会话发消息必失败——`attachIpcServices` 把 kernel 的**类方法** `GroupApi.uinToUid` 摘成裸函数注入 IPC 动作表，丢了 `this`，方法内 `this.service.getUidByUins()` 抛 `Cannot read properties of undefined (reading 'service')`（读的是 undefined 的 `service`，即 `this` 为 undefined，与原生服务是否就绪无关）。群聊 peerUid 直通群号不走这条路径，因此只有私聊/临时会话中招。改为 `bind` 注入（与 kernel-services 里 `uidToUin` 的箭头包装写法对齐），并补 `attachIpcServices` 回归单测：用「方法内读 `this.service`」的假 GroupApi，未 bind 时复现同一条报错。同时更正 2026-08-09 对该报错的误判归因（当时归因为「传群号给 getUidByUins」，群聊改直通只是恰好绕开了缺陷路径，私聊一直是坏的）。

## 0.0.18

### Patch Changes

- cd8a030: fix(loader): 清理开发机路径与 UA/版本号硬编码——删除 locate-qq 常见路径探测中的开发机目录候选；下载 User-Agent 改为运行时读自身 package.json 版本（失败兜底 0.0.0）；DEFAULT_WIN_NODE_VERSION 与 SEVEN_ZIP_LINUX_VERSION 补注释说明升级需手动同步。

## 0.0.17

### Patch Changes

- abbde2f: fix(kernel/loader): wrapper 配置硬编码治理——major.node 解析 appid 失败时显式抛 KernelError（删除 537237765 静默兜底，该 appid 属已下线登录服务的 9.9.31），系统信息改为运行时探测（os.release/version/platform，不再写死 Windows 构建号），engine/session 配置裸魔数抽为具名常量并补契约注释。

## 0.0.16

### Patch Changes

- 555e284: fix(kernel/loader): device guid 填空——LoginService 实测为 getMachineGuid（无 getMachineId 方法），kernel 新增 readMachineGuid 原生反射读取，buildSessionConfig 接入 machineGuid，loader 引导时传入设备指纹 guid（反风控）。
- ebc59b5: feat(kernel/loader): IPC control login 指令实现——kernel 新增 qrOnly 登录选项（强制扫码跳过快速登录），loader ipc-server handleControl 接入 login 分支（uin 指定账号 / qr 强制扫码），koishi 插件可经 control login 触发重新登录而不重启子进程。

## 0.0.15

### Patch Changes

- 5bb12a5: feat(loader): IPC 协议契约改为 zod 单一来源——loader 导出 IpcMessageSchema 与全部协议类型（替代 koishi 侧 src/ipc/types.ts 手工镜像，消除两侧类型漂移），新增 zod 依赖；ipc-codec 解码改用 IpcMessageSchema.safeParse（顺带校验 payload 形状，非法 payload 在边界即拦截）。koishi 适配器同步改为消费该契约。

## 0.0.14

### Patch Changes

- fa86aef: fix(loader): Linux 7zz 内置资产优先（治本）+ 版本 2409→2501（止血）

  生产环境 7z 下载 404 根因：7-Zip 官网只保留最新版 tar.xz，硬编码 2409 已被删档
  （实测 404，2501 为当前版）。治本：7zz 静态二进制（2.8MB，LGPL 合规）打进发布包
  `assets/7zip/`（与 Windows 7z.exe 同模式，含 License-linux.txt），`ensureLinuxSevenZip`
  优先级改为 内置资产 > 数据根缓存 > 官网下载兜底（NAPUTO_7Z_URL 可覆盖）——Linux
  引导链不再依赖运行时外网下载 7z。`findSevenZip` 同步支持 Linux 内置资产。
  QQ 安装包保持动态下载（qq-releases.json 清单 + NAPUTO_QQ_URL 覆盖，不变）。

## 0.0.13

### Patch Changes

- f42a50c: 修复 WSL/Linux 生产环境两个问题：① wine 场景 PATH 混入 Unix 路径（冒号分隔）导致 stub QQNT.dll 目录被拆散、wrapper.node 依赖的 QQNT.dll 找不到——PATH 逐条转 Z:\\ 纯 Windows 风格；② Linux 缺少 7z（内置资产是 Windows PE，系统未装 p7zip-full）导致 QQ 安装包解包失败——自动下载 7-Zip 官方 Linux 版 7zz 到数据根 runtime/7zip。

## 0.0.12

### Patch Changes

- 98c27a3: feat(loader): IPC 服务端登录前提前启动 + login.refreshQr 动作

  - 登录前即启动 stdin 服务端（动作表先只含 `login.refreshQr`）——原实现在登录成功
    - 协议装配后才启动，登录中（waiting_scan）前端刷新/control 指令堆积在 pipe
      缓冲区不可达；心跳 ping（15s）同步提前，防扫码耗时超过 45s 被 driver 误判失联强杀
  - 登录后 `attachIpcServices` 把 kernel 服务动作并入同一张共享动作表 + 事件转发
    （`startIpcMode` 拆分为 `createIpcActionsForCore` + `attachIpcServices`）
  - `IpcLoginPayload` / `sendLogin` 新增可选 `message`（失败原因透出）

## 0.0.11

### Patch Changes

- 5d4524f: fix(loader): WSL 下 QQ 安装定位——常见路径探测支持 `/mnt/<盘符>/` 挂载映射，installDir 推导改用 `dirname`（原反斜杠切分在 Linux 路径下切错字符）

## 0.0.10

### Patch Changes

- c60c34c: 修复：对外 API 新增 CJS 双格式产物（`dist/index.cjs`），`exports.require` 指向 `.cjs`——此前仅发布 ESM（`.mjs`），koishi 适配器（发布形态为 CJS，koishi loader 用 `require()` 加载插件）require kernel/loader 时抛 `ERR_REQUIRE_ESM`，导致适配器无法加载。ESM 消费方（apps/cli 自建宿主）不受影响，仍走 `import` → `.mjs`。

## 0.0.9

### Patch Changes

- affab05: feat(loader): QQ 官方安装包自动下载解包缓存（P1，本机无 QQ 场景可用）

  - `qq-releases.json` 版本清单（含 9.9.33-51802 实测 sha256）
  - `qq-download.ts`：https 下载 + sha256 校验（零第三方依赖，NAPUTO_QQ_URL 可覆盖）
  - `qq-extract.ts`：完整版 7z 解 NSIS 安装包 + 提取 resources/app 顶层 `*.node`/`*.dll`（内置 assets/7zip，LGPL 合规；真实 QQNT.dll 由 stub 替代无需提取）
  - `ensureQqFiles()`：下载 → 校验 → 解包 → 提取 → 缓存，幂等（缓存命中直接返回）
  - `resolveQqFiles()` 改 async，L0/L1/L2 全部缺失时自动进入下载流程

- fa2fb7c: feat(loader): QQ 原生文件多级来源定位（P0 跨平台前置）

  新增 `resolveQqFiles()`：L0 `NAPUTO_QQ_FILES` 显式文件根 → L1 本机 QQ 安装（既有逻辑保留）→ L2 数据根缓存 `<数据根>/qq-files/<版本>/` 依次探测，为「本机无 QQ / Linux / Docker」场景铺路；`QqInstallInfo` 新增 `source: "local" | "cached"` 字段。`resolveQqInstall` 旧签名保留兼容。

- 3507cdd: feat(loader): Linux/wine 完整链路登录冒烟脚本（P2 Step 2）

  - `scripts/wine-login-smoke.mjs`：WSL2 一键完整链路冒烟——确保 QQ 文件 → 确保 Windows 版 node.exe → wine 跑 win-node 执行 self-host.cjs（dlopen wrapper.node → O3MiscService 激活 → 登录 → session READY → 协议装配），`--uin` 指定快速登录账号，90s 观察窗口
  - 环境变量装配与 launcher.buildLaunchEnv 同构，路径全部过 toWinePath（Z:\ 视角）

- 52c1519: feat(loader): Linux/wine 平台分支（P2 纯逻辑层）——toWinePath 路径映射 + win-node 下载

  - `wine.ts`：`toWinePath()` Linux 路径 → wine `Z:\` 路径（幂等，含盘符保护）+ `buildSpawnCommand()` 平台分支（win32 本机 node / linux wine）
  - `win-node.ts`：`ensureWinNode()` 下载 Windows 版 node.exe（nodejs.org 官方 zip → 7z 解压 → 缓存，幂等；NAPUTO_WIN_NODE_PATH/NAPUTO_WIN_NODE_VERSION 可覆盖）
  - `launcher.ts`：`launchSelfHost` 变 async，linux 场景自动走 wine + win-node，传给子进程的所有路径过 toWinePath；win32 行为不变
  - cli `boot.ts` 适配 async 调用
  - 新增 `wine.test.ts`（9 单测：toWinePath 5 + buildSpawnCommand 3 + wineBinary 1）

- de622f5: feat(loader): Linux/wine 冒烟脚本 + 实测验证记录（P2 Step 1 固化）

  - `scripts/wine-smoke.mjs`：WSL2 一键冒烟——确保 QQ 文件（P1 自动下载解包）→ 确保 Windows 版 node.exe（P2）→ wine 跑 win-node → dlopen wrapper.node → 断言 98 exports
  - 实测验证通过（2026-08-12 WSL2）：wine 跑 Windows node.exe ✅ / stub QQNT.dll PE 转发在 wine 下生效 ✅ / dlopen wrapper.node 98 exports ✅
  - 设计文档 §3.3 记录实测坑：**wine 读 DrvFS（/mnt/c）会 "File not found"，QQ 文件必须放 ext4**（Docker 无此问题）；dlopen 参数形态 `const m={exports:{}}; process.dlopen(m, ...)`

## 0.0.8

### Patch Changes

- f744cf7: fix(kernel): 修复图片发送失败（PIC 元素按 QQ 原生契约预处理：elementType=2 + getRichMediaFilePathForGuild + copyFile + 完整 picElement）
- 769d457: fix(kernel): 修复消息发送失败（sendMsg 返回 result=5 被误判失败）

  问题根因：旧实现以 `sendMsg(msgId, peer, ...)` 调用并直接看返回值 `result===0` 判成败，
  但 wrapper 对正确调用返回 `result=5`（文本/图片均失败）。按 QQ 原生调用契约修复：

  - sendMsg 第一参固定传 `'0'`，msgId 塞 `peer.guildId`
  - 先注册 `onMsgInfoListUpdate` 事件监听再调 sendMsg，以事件 `sendStatus===2` 确认发送成功
    （sendMsg 返回值 result 非 0 不立即判失败——富媒体异步上传时 result=5 常见）
  - `MsgBridge` 补注册 `onMsgInfoListUpdate` 回调（此前缺失，发送状态事件不透传）
  - `MsgApi` 构造支持注入消息事件通道；无通道时退化为旧行为

  实测：文本消息成功发送到群（boot 日志确认）；图片发送错误从模糊的
  `rich media transfer failed` 变为清晰的 `sendStatus=0`（图片仍失败，根因另查）。

## 0.0.7

### Patch Changes

- fix: 包 exports 增加 require/default 条件——`@napuketto/*` 被 koishi 插件（CJS 产物）作 dependencies 消费时，`require('@napuketto/kernel')` 此前因 exports 仅声明 `import` 条件而报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。补 `require`/`default` 条件指向同一 `.mjs`（无顶层 await，Node 22.12+ require(esm) 原生同步加载）；插件发布链自动追踪新版本

## 0.0.6

### Patch Changes

- 3265791: feat(cli): 终端渲染登录二维码——loader 在自建宿主（非 IPC）模式经 `NAPUTO_QR` 标记行向 stdout 透出二维码数据，cli `forwardFiltered` 解析后用 qrcode 包渲染终端二维码（png 落盘与 URL 提示保留）；顺带移除未使用的 picocolors 依赖

## 0.0.5

### Patch Changes

- ba49012: fix(loader): IPC 动作表群聊 peer 解析——peerUin 直通为 peerUid，不再经 uinToUid 转换（getUidByUins 是用户转换 API，传群号属非法调用，QQ 原生内部抛 `Cannot read properties of undefined (reading 'service')`）；错误响应同时落 boot 日志（含完整堆栈）便于诊断

## 0.0.4

### Patch Changes

- fix(kernel): 群列表数据源校准（2026-08-08，e27fb55）——原生 getGroupList 返回值无数据（仅 `{ result, errMsg }`），列表实际经 onGroupListUpdate 事件推送；GroupCache 新增 listGroups / listGroupsRefreshed；IPC 动作表与 OB11 / Satori 群列表动作改从缓存读，force / no_cache 触发原生刷新

## 0.0.3

### Patch Changes

- b9f06ca: DDD 目录重组（纯移动 + barrel，行为零变化，2026-08-08）：

  - **kernel**：`wrapper/` 拆出 `wrapper/probe/`（运行时反射探测子系统 5 文件 + barrel）；`index.ts` 改指 probe barrel
  - **adapter**：`satori/helper/` 拆出 `helper/element/`（消息元素域 7 文件 + barrel：解析/渲染/双向转换/资源）；`onebot11/helper/` 拆出 `helper/codec/`（CQ 编解码域 3 文件 + barrel）
  - **loader**：`host/` 拆出 `host/core/`（自建宿主引导编排 7 文件）；tsdown 入口与 `.fallowrc` manual entry 同步改 `host/core/self-host.ts`（产物 `dist/host/self-host.cjs` 路径不变，launcher 默认值无需改）

  全部为 git mv 文件移动 + import 路径调整（组内相对引用保持，跨目录走 barrel），`pnpm check` / 59 测试 / 全量构建 / fallow 全绿，无 API 变化。

- 9005c43: koishi 适配器 IPC 子进程模式前置（§7 loader 去脚本化，2026-08-08）：

  - **kernel**：`NTEventChannel` 新增 `onAny`（全事件订阅，IPC 整通道转发用）；
    `CoreLoginOptions` 新增 `onLoginProgress` 回调（QR 阶段二维码/状态机转发）；
    `LoginProgress` 类型导出
  - **loader**：新增 `src/host/ipc/`（NAPUTO_IPC=1 开启）——协议类型/编解码/发送封装/
    动作表（msg/group/friend 核心动作，peerUin 自动转 uid）/stdin 服务端（action/control/
    心跳）；`self-host.ts` IPC 分支发 status（booting→dlopening→logging→sessioning→ready/
    failed）；`protocols.ts` 重构拆出 `kernel-services.ts`（服务创建，IPC/协议共用）+
    `assemble-protocols.ts`（OB11/Satori 装配，非 IPC 零回归）；`launcher.ts` 新增
    `LaunchOptions.ipc`（注入 NAPUTO_IPC=1）

  非 IPC 路径（cli pnpm start）行为零变化；`pnpm check` / 198 测试全绿。

## 0.0.2

### Patch Changes

- 007e1ac: fallow 静态分析优化（克隆清零）：提取 `createWsServerSchema` 传输工厂（OB11/Satori 共用骨架，消除 config schema 克隆）；清理 4 处纯透传无用构造器（delete/set-essence-msg、satori guild.approve/member.approve）；loader smoke.ts 收敛重复文本提取逻辑为 `extractTexts` helper。
- 69a53e5: 启动单实例检测（根治多实例抢数据目录锁挂起）：同一账号数据目录（`~/.napuketto/<uin>`）只允许一个实例运行——QQ 原生层（MMKV/登录单例）有锁，第二个实例抢不到会卡在登录初始化后无响应。新增 `instance.lock` 数据目录锁（loader 包）：cli 启动前预检（占用则快速失败并提示占用 PID），self-host 子进程入口兜底获取/释放锁；崩溃残留（PID 已死）自动接管。
