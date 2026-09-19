# NapukettoQQ 项目现状（2026-09-20 更新）

> **新对话开场指引**：先读本文件（现状 + 遗留清单）→ `AGENTS.md`（工程指南 + 红线）→
> `docs/architecture.md`（架构书）→ 对应包 `docs/design.md`（kernel / adapter / loader /
> koishi-plugin-adapter / create-napukettoqq）。需要理解「为什么走到今天」时读
> `docs/DECISIONS.md`（决策史 V1→V10 + V10 后补录）。涉及**登录 / 停启实例 /
> instance-lock / stderr 噪音排查**等实操时先读 `docs/OPERATIONS.md`。载具层闭源细节
> （私有子仓库）：`packages/loader/native/docs/HANDOVER-V11.md`。
>
> 各文档导航见 `docs/README.md`。历史轮次详情不留在本文件——已收编进决策史与各包
> design.md，本文件只保留「当前快照 + 遗留 + 环境」。

---

## 项目快照（2026-09-20）

| 包 | 版本 | 状态 |
|---|---|---|
| @napuketto/kernel | 0.1.1 | 完整（wrapper / login / apis / 三桥 + 缓存 / 事件通道） |
| @napuketto/adapter | 0.3.1 | 完整（core 框架 + onebot11 + satori + kurobot） |
| @napuketto/network | 0.0.2 | 完整（HttpServer/HttpClient/WsServer/WsClient/EventBroadcaster） |
| @napuketto/media | 0.0.4 | 完整（image/audio(silk)/video(ffmpeg)） |
| @napuketto/loader | 0.0.34 | 完整（自建宿主引导 + 跨平台 wine + IPC 模式 + 登录相位机） |
| @napuketto/cli | 0.1.21 | 完整（启动 / config 子命令 / supervisor / 运维命令） |
| apps/create-napukettoqq | 0.2.45 | 完整（项目脚手架） |
| apps/koishi-plugin-adapter | （独立仓 submodule，npm 包名 koishi-plugin-adapter-napuketto） | 完整（Koishi 适配器，IPC 模式） |

**协议面**：
- **OneBot 11**：79 个动作（含别名变体）+ message/notice/request/meta 事件 + HTTP/WS/反向 WS
  传输；动作 schema 三层来源（OneBot 11 规范 / go-cqhttp 扩展 / NapCat 扩展），以
  `packages/adapter/src/onebot11/action/index.ts` 注册表为准，对齐度 ≈70%。
- **Satori**：HTTP RPC + WS 事件服务 + 元素 XML 编解码 + 20 动作 + 4 类事件（2026-08-08）。
- **kurobot**：第三协议（2026-09-13，KuroBot MVP-3），QQ 群 ↔ MC 双向互通；协议镜像基线
  **0.4.0**（子协议 `kurobridge-ws.v1`，随 KuroAdapter ADR-030 品牌改名对齐，commit `5bc2aea`）。
  任务实录与债务清单：`docs/KUROBOT-NOTES.md`。
- **OneBot 12 已放弃**（规范过于模糊）。

**发布与工程化**：
- 版本管理 = Changesets（AGENTS.md 工作流节）；`.changeset/` 当前**无 pending 条目**（已全部消费发版）。
- 发版链 = `scripts/release/`（release-npm 支持 `--otp=` / `NAPKETTO_NPM_OTP` 透传 2FA 验证码；
  sync-adapter-deps 自动对齐 koishi 插件依赖范围）。
- 2026-09-19 发布首个 GitHub Release（**repo 级 tag 与包版本解耦**，npm 各包独立版本照常）。
- CI = `.github/workflows/ci.yml` 三并行 job：**gate**（ubuntu：build → check → test + Codecov
  覆盖率）、**windows**（跨平台测试补位）、**audit**（fallow 增量门禁 `--base`，整仓模式因
  跨包 dist 消费误报 82+ 不采用）。另有 `update-qq-releases.yml`（Cron 爬官方下载配置更新
  `packages/loader/qq-releases.json`，发现新版本自动 PR）。
- lockfile 一致性 pre-commit 钩子（`scripts/git-hooks`，root prepare 自动启用）。
- `.github/` 下有 CONTRIBUTING / SECURITY / CODE_OF_CONDUCT（2026-09 落库）。

---

## 当前工作面（最近一轮落地，2026-09-13 ~ 09-16）

1. **kurobot 协议适配器（KuroBot MVP-3）全量落地**：镜像 schema + 自建连接层 +
   翻译映射 + 装配接线 4 处（loader / cli / create-napukettoqq 模板 / adapter package.json），
   46+3 用例，全仓 899 用例绿；随后随 KuroAdapter 品牌改名对齐协议镜像
   （`kurobot-ws.v1`/0.3.1 → **`kurobridge-ws.v1`/0.4.0**，帧形状不变）。详见
   adapter design.md §8 与 `docs/KUROBOT-NOTES.md`。
2. **koishi-plugin-media-align 变更记录清理**（`c32c946`）+ koishi 插件发布链打磨
   （media 范围对齐 `~0.0.4`、console 转 peer、`@napuketto/loader ~0.0.34`）。
3. **CI 根治**（`a583b04` / `e131ed7`）：lock 漂移预提交门禁、GitHub Action 升级、
   qq-releases 降噪、fallow audit 强推后孤儿 before 的守卫回退。

---

## 遗留清单（2026-09-20 核对）

| 遗留项 | 现状 | 去处 |
|---|---|---|
| **payload 校准族**（真实事件到达后回填翻译）：poke 翻译字段、offline_file payload、group_essence payload、BuddyReq words、onRecvSysMsg **识别表 KIND_TABLE 为空**（解码器已上线，等 card/title/subType 真实样本登记规则） | 等真实事件 / 样本（raw 校准日志持续积累） | adapter design.md §1/§6/§7、kernel design.md §6 |
| **msg_emoji_like** | 已结案（无推送回调，仅 API 面 getMsgEmojiLikesList）；疑经 onMsgInfoListUpdate 携带或轮询，待观测 | kernel design.md §1 c3 节 |
| **kurobot 债务**：@kurobot/protocol 发版切真依赖、富文本上行、status 命令式查询、wss/TLS 配置、peer-guide 交叉校验、**用户协作终验**（需 QQ 扫码在场） | 过渡方案稳定运行 | `docs/KUROBOT-NOTES.md` 债务清单 |
| **bot 级「造残留锁 → 启动自动接管」实机复核** | 单测完备（15 例）、实机未跑；需独占窗口，**禁并行会话执行** | `docs/OPERATIONS.md` §4 |
| **多账号实测** | 跳过未执行（本机第二账号段曾为注释模板） | 首次多账号配置时顺带验收 |
| **版本兼容**：wrapper-version 探测 + appid 表维护（QQ 升级重跑 major 解析） | 未做（当前硬依赖 9.9.33 实测版本） | loader design.md §2.2 清单机制已就绪 |
| **数据包层（packet 后端）** | 远期（逆向已解禁） | AGENTS.md 第 7 条 |
| **Docker 镜像（loader G3）** | 规划未实现（设计已定稿） | loader design.md §4/§7 P3 |

> 已收尾（历史遗留，勿再追）：软重登挂起已根治（T3 快速登录超时兜底 `d424c67`）、
> checkIdentity 账号一致性单测已补齐（koishi 子模块 `6700830`）、onRecvSysMsg 解码器
> 已落地（`e4bdcb3`）、instance-lock pid 复用误判已根治（cmdline 二次校验）、
> group_upload / friend_add / offline_file 均已接线。

---

## 端到端实测存证（勿重复验证）

- **自建宿主全链路**（2026-08-07 起，唯一路线）：登录 → session READY → 冒烟收发 →
  onebot11 装配 → 群消息真实接收；`NAPUTO_SMOKE=1` 冒烟自检常驻。
- **OneBot 外部链路**（2026-09-08 T10）：OB11 WS + token 鉴权 + 外部客户端事件/动作往返全通
  （当时修复 WS 查询参数鉴权与缺 params 1400 两个真 bug）。
- **内存实测**（2026-09-08）：self-host 进程 ~186MB + boot 转发进程 ~54MB ≈ 240MB，
  与 NapCat 纯 Node ~237MB 同量级。
- **读类返回形状校准**（2026-09-08）：get_group_member_info / get_group_member_list /
  get_group_system_msg 经 OB11 动作面全 retcode=0（脚本 `scripts/e2e-shape-calibration.mjs`）。
- **Buddy 列表事件 payload 首捕**（2026-09-08）：onBuddyListChange = BuddyCategory[] 全量
  快照；onBuddyListChangedV2 = boolean → friend_add 快照 diff 翻译已按此落地。
- **媒体发送三连修复**（2026-08-11~12，调查档案 `docs/archive/INVESTIGATION-richmedia-upload.md`）：
  文本（NapCat 式 sendMsg '0' + onMsgInfoListUpdate sendStatus 判定）、图片（elementType=2 +
  getRichMediaFilePathForGuild + util.copyFile 完整预处理）、语音（完整 pttElement；非 silk
  输入 wrapper 内部自动转码，无需外部 silk）。

---

## 关键环境事实（务必记住）

- **QQ 9.9.33-52230（2026-09-08 实测本机）**：`C:\Program Files\Tencent\QQNT\`。旧 9.9.31
  登录服务已被腾讯下线，扫码「请下载最新版」。
- **appid 机制**：每版本从 major.node 的 `QQAppId/` 标记提取（9.9.33-51802 = 537376818；
  9.9.31 = 537237765）；qq-releases.json 清单机制见 loader design.md §2.2。
- **session 必须 NapCat 方式**：`getNTWrapperSession("nt_1")` 或 `StartupSessionWrapper.create()`，
  不要 `new NodeIQQNTWrapperSession()`（cpp_impl 断言失败）；**先 `session.init(config)` 后
  `startupSession.start()`**（顺序颠倒不 READY）。
- **initConfig 必须 `externalVersion: false`**（扫码兼容）；commonPath 用
  `getNTUserDataInfoConfig()` 返回路径的 `nt_qq/global`。
- **登录测试账号**：快速登录 <测试QQ号> 会挂起（账号风控），测试用 <测试QQ号2>（已验证成功）。
- **同账号双实例互斥**：任何要登录的 probe / E2E 必须先停常开 koishi 树——规程见
  `docs/OPERATIONS.md` §1。
- **libprotobuf OTel Span 报错 = QQNT 自身噪音**（无害已验证），排查 stderr 先排除此条——
  `docs/OPERATIONS.md` §5。

## 环境坑（复用历史）

- PowerShell PATH 间歇失效 → 用绝对路径（python/g++/taskkill）。
- 崩溃子进程占 DLL 句柄 → 编译 Permission denied → 杀残留 node 进程。
- wrapper.node 加载后进程不退出（后台线程）→ 测试脚本需 `process.exit`。
- `launchSelfHost` 的 `stdio` 必须是 `["pipe","pipe","pipe"]`——stdin `"ignore"` 时
  `child.stdin` 为 null，action 静默丢弃，表现为「超时/挂起」假象。
- QQ 原生日志（MMKV 等）不带 `\n`，与 stdout JSON 行粘连——解析按 `{"v":1` 起点 +
  花括号深度提取，勿裸 `split("\n")`。

## 红线

全部红线以 `AGENTS.md`（硬性约束 1-8）与 `docs/architecture.md` §8 为准：MIT 零引入
NapCat 代码、依赖方向、kernel 唯一原生层、network 协议无关、零磁盘篡改、逆向产物不进
公共仓库、native/ 为私有 submodule（仅分发编译产物）。此处不重复。
