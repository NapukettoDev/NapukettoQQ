# NapukettoQQ 运维与实验规程（OPERATIONS）

> **定位与选型理由**：本文件固化**实测沉淀的操作规程**，内容长期稳定、不随版本
> 轮次重写。单独建文件而非塞进 `STATUS.md`，因为 STATUS 是时点快照（决策点
> 每轮被归档/重写），规程需要一个不动的地方被稳定引用；STATUS 顶部开场指引
> 已加指向。涉及**登录 / 停启实例 / instance-lock / 子进程 stderr 噪音排查**
> 的会话，动手前先读本文件。
> 来源：2026-09-08 ~ 09-10 实测轮（B 轮探测 / instance-lock pid 复用根治
> c36bac0 / 双 koishi 树竞态处置），每条规程出处逐条标注。

---

## 1. 同账号双实例互斥（停树 → 实验 → 恢复）

**背景（实测）**：QQ 快速登录 / MMKV 以账号数据为锁——同账号两个宿主进程
（如常开 koishi 树 + 临时 probe/E2E 宿主）互斥，后登录方登录失败或互踢。

**常开树**：`C:\Dev\Bot-Dev\koishi-dev`（用户 koishi dev 实例，bot 账号
3567141148，`bun dev` 启动，loader 发布版，cfgDir 在 `koishi-dev/.napuketto`）。

**规程**：

1. 任何要登录某账号的新宿主 / probe 脚本 / E2E 冒烟，**必须先停常开 koishi
   树**：`taskkill //F //T` 根进程（Git Bash 双斜杠；PowerShell 单斜杠 `/F /T`）。
2. 测完恢复：`cd C:\Dev\Bot-Dev\koishi-dev && bun dev`（detached 同命令）。
3. **恢复终态核对** = ① 单树 ② boot 日志出现「bootstrap 完成」。koishi dev
   watcher 会自动重启 loader，重启 churn **不是故障**，别误判。
4. **两树并存处置**（并行会话竞态，2026-09-10 实证：停树探测期间另一并行
   会话几分钟后自行 `bun dev` 恢复 → 两棵 koishi 树并存，残缺树无 loader、
   被 instance-lock 拒）：**保留带在线 loader 的健康树，杀残缺树**。

> 出处：2026-09-08 B 轮实测（probe-download-richmedia 需登录同一账号）+
> 2026-09-10 双树竞态处置。此前仅存于会话记忆未进任何仓库文档，本节即其
> 固化处。

## 2. koishi dev 对 koishi.yml 变更 = 进程退出（无 supervisor 不自愈）

`koishi dev` 检测到 `koishi.yml` 变更的反应是**进程退出**——没有 supervisor
拉起，不自愈。含义：

- 改配置实验 = 预期重启（退出后手动再 `bun dev`），退出本身不是 bug。
- **常开场景用生产模式或外部守护**，不要依赖 dev 模式自愈。

> 出处：2026-09-08~09-10 常开树运维实测。

## 3. 旧版残留锁（无 cmdline 字段）保守判占用 → 手动删锁

instance-lock pid 复用根治（2026-09-10，c36bac0）后，锁内带 cmdline 摘要
（execArgv+argv），pid 探活通过后二次比对真实命令行
（`packages/loader/src/pid-cmdline.ts`，Windows 走 PowerShell
Get-CimInstance；查不到或不一致 → 接管）。**旧版锁文件无 cmdline 字段 →
无法校验 → 保守维持占用**（`packages/loader/src/instance-lock.ts:96`，有意
设计，`instance-lock.test.ts` 15 例单测固化）。

**升级过渡期症状**：新代码启动被旧版留下的锁误拒。**处置**：手动删
`<cfgDir>/instance.lock` 即可。随新锁普及自愈，无需改码。

单测级验证脚本：`node packages/loader/scripts/verify-lock.mjs`（先构建
loader，5 场景）。

## 4. 「造残留锁 → 启动自动接管」实机复核 checklist

> ⚠️ **前置约束：需独占环境 + 会登录，禁止并行会话执行**——要登录真实账号
> （先按 §1 停常开树），且造锁实验会与并行会话的启动/恢复互相污染。

单测已完备（`instance-lock.test.ts` 15 例），本 checklist 是**实机 E2E**
补充（截至 2026-09-10：单测完备、实机未跑）。

1. **前置**：独占环境（§1 停树并确认）；loader 已构建（产物含最新
   cmdline 校验逻辑）。
2. **case A：死 pid 残留锁**——往 `<cfgDir>/instance.lock` 写伪造锁
   （pid = 已死进程号 + cmdline 摘要字段）→ 启动新实例 → **断言**：接管
   成功 + 锁被重写（新 pid + 本进程 cmdline 摘要）。
3. **case B：活 pid + 不匹配 cmdline**——锁内 pid 填一个活进程（其真实
   命令行与锁内摘要不一致）→ 启动 → **断言**：接管成功 + 锁重写。
4. **对照组（可选）**：锁内活 pid + cmdline 真实匹配（如另一个真实
   napuketto 实例）→ 启动 → **断言：拒绝**启动（互斥未被误破）。
5. **恢复现场**：正常退出清锁；恢复常开树（§1 步骤 2-3 + 终态核对）。

> 出处：c36bac0（cmdline 二次校验 + 写锁自动摘要）设计验收项；实机执行后
> 在 STATUS.md 勾销此遗留。

## 5. libprotobuf OTel Span 报错 = QQNT 自身噪音（无害已验证）

**现象**：子进程 stderr 打
`[libprotobuf ERROR ..\third_party\protobuf\...\wire_format_lite.cc:577]
String field 'opentelemetry.proto.trace.v1.Span.Event.name' contains invalid
UTF-8 data...`（经 koishi 插件原样转发时带 `[napuketto 子进程]` 前缀，
`koishi-plugin-adapter-napuketto` 仓 `src/ipc/transport.ts:95`）。

**结论（2026-09-09 二进制验证，用户拍板只验证不修复）**：QQNT wrapper.node
内部 OpenTelemetry C++ SDK + OTLP exporter 给自己操作打 trace 的噪音，
**零功能影响**。**排查任何子进程 stderr 报错时先排除此条**，不要当
NapukettoQQ bug 追。

- 来源佐证：本机 wrapper.node（`versions/9.9.33-52230/resources/app/`）内
  `opentelemetry` ×1092、`otlp` ×48、`Span.Event.name`、`invalid UTF-8` 全
  命中；本仓零 otel/protobuf 依赖（唯一相关 = kernel `onOpentelemetryInit`
  ——QQNT 登录后自初始化 OTel 的信号，lifecycle 拿它当登录完成判据；坏字节
  来自收到的消息体，我们经 NAPI 传入的 JS 字符串天然合法 UTF-8）。
- 外部佐证：qq-chat-exporter issue #439 同款报错（QQNT 生态共有）。
- 出现两条重复 = 同一坏内容被序列化两次，无意义。

**静默方法（已定位，未实施）**：把 `[libprotobuf ERROR` 加进
`packages/loader/src/host/ipc/native-noise.ts:18` 的 `NATIVE_NOISE` 正则即可
（现仅覆盖 MMKV/符号加载噪音），cli 转发与 koishi IPC 两条路径同时生效。
