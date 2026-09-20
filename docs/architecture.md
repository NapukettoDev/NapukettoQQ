# NapukettoQQ 架构书（2026-08-06 合并定稿；2026-09-20 增补修订）

> **状态**：本文件是唯一架构书，合并自旧 `architecture.md`（总体架构）+ `architecture-investigation.md`
> （9.9.31 排查）+ `architecture-v2-native-bypass.md`（V2 决策书），并按 2026-08-06 路线修正
> （自建宿主唯一路线 + 路线 B 已淘汰）。2026-09-20 增补：kurobot 第三协议、create-napukettoqq
> 脚手架、ADR 019~022 补录、发版与 CI 工具链。
> **配套**：`docs/STATUS.md`（现状 + 遗留）、`docs/DECISIONS.md`（决策史）、各包 `docs/design.md`。
> 新对话先读 STATUS → AGENTS.md → 本文件 → 对应包 design.md。

---

## 1. 项目定位

NapukettoQQ 是基于 **QQ NT 架构客户端**的机器人框架：

- 通过 QQ 原生模块 `wrapper.node` 把 QQ 内部 C++ 服务包装成语义化 API。
- 对外提供多协议接口：**OneBot 11**（HTTP / WS / 反向 WS）、**Satori**（2026-08-08）、
  **kurobot**（2026-09-13，QQ 群 ↔ Minecraft 双向互通的 kurobridge-ws 客户端）。
  **OneBot 12 已放弃**（2026-08-05 用户拍板：规范过于模糊，commit ac5ebba 删除占位）。
- **永远不做 WebUI**；**不做 framework 模式**（QQNT 插件形式），只做独立进程/宿主模式。
- **全局配置 = 单一 TOML**：`<项目根>/napuketto.toml`（全局段 + `[[accounts]]` 账号段，
  协议与通信配置嵌在账号内——`[accounts.onebot11]` / `[accounts.satori]` /
  `[accounts.kurobot]`，账号必填、无协议段 = 不启用，2026-08-08 拍板；cli 读写 + zod 校验，
  boot 按登录账号 uin 取段作 seed 注入 kernel ConfigBase）。**数据根默认 `<项目根>/.napuketto`**
  （2026-08-08 拍板：部署原因不放用户目录），只承载账号目录/日志/缓存/QQ 数据，路径解析见
  kernel `resolveDataRoot` / `resolveConfigPath`。

## 2. 包结构与依赖方向（只允许向下依赖）

```
apps/cli               启动编排（commander + 登录渲染 + 配置命令 + supervisor 多账号）
  └─ @napuketto/adapter   协议适配器容器（core 框架 + onebot11/satori/kurobot）
       ├─ @napuketto/kernel   唯一原生交互层（wrapper / apis / 事件通道 / 缓存）
       ├─ @napuketto/network  协议无关传输层（HTTP / WS / 泛型广播）
       └─ @napuketto/media    媒体转码（silk / ffmpeg / 文件识别）
       （loader 仅被 cli 依赖，kernel 不依赖 loader；loader 依赖 kernel）
apps/create-napukettoqq   项目脚手架（交互式生成 napuketto.toml + 目录布局，依赖 @napuketto/cli）
apps/koishi-plugin-adapter（git submodule，独立仓）  Koishi 适配器插件
```

依赖方向硬约束（AGENTS.md 第 2 条）：
```
@napuketto/kernel    无内部依赖（仅 pino + smol-toml）
@napuketto/media     无内部依赖
@napuketto/network   无内部依赖（协议无关传输原语）
@napuketto/adapter   kernel + network + media（协议适配器容器）
@napuketto/loader    kernel（boot 引导）+ 无其他（自建宿主引导；C++ 载具已归档，native/ 为闭源 submodule 仅存编译产物）
apps/cli             kernel + adapter + loader
apps/koishi-plugin-adapter（git submodule）kernel + loader + media + adapter + network
```

> **koishi 插件 IPC 模式**（2026-08-27）：koishi 插件经 loader 拉起自建宿主子进程
> （`NAPUTO_IPC=1`），共享 IPC 动作表 = kernel 点分动作 + **可选整表挂载的 OB11 动作
> 容器**（app 层注入 `NAPUTO_ADAPTER_ENTRY`/`NAPUTO_NETWORK_ENTRY` 时，loader IPC 分支
> 动态 import adapter/network 装配——仅注册表 + 接收链路，零网络传输；详见 loader
> design.md §9）。loader 运行时动态 import 不构成编译期依赖，依赖方向约束不变。

## 3. 分层原则

| 层 | 职责 | 红线 |
|---|---|---|
| **kernel** | 唯一原生交互层 + 唯一共享状态层 | 其他包禁止直接触碰 `wrapper.node` / session / 原生 listener；kernel 无全局单例（ADR-015 推论，CoreContext 实例化持有） |
| **network** | 协议无关的传输原语（HTTP/WS + 泛型广播） | 禁止 import 任何协议包；事件类型泛型化 |
| **adapter**（协议容器） | 协议语义：事件模型、action 注册表、数据翻译、ID 映射 | 只认识 kernel 的 API/事件/缓存，不认识原生 |
| **media** | 媒体编解码与识别 | 只被协议层依赖；kernel 不背媒体依赖 |
| **loader** | 自建宿主引导（launchSelfHost）+ 跨平台（wine）+ IPC 模式 + instance-lock + 登录相位机 | 逆向手段（如启用）仅限此层；载具闭源（native submodule） |
| **cli** | 启动编排、登录渲染、配置命令 | 不写业务逻辑，只装配 |

## 4. 技术路线（V2 定稿：Native Bypass 混合模式 + 自建宿主修正）

### 4.0 当前定稿（2026-08-06）

> **⚠️ 关键决策点**：自建宿主（标准 Node 纯 Node 模式）为**唯一路线**（NapCat 纯 Node 模式
> ~237MB 能登录实证），路线 B（注入 300MB）**已淘汰（2026-08-07 用户拍板）**。路线演进背景见
> `docs/DECISIONS.md`（V4 存疑 → V9/V10 定案）。

| 路线 | 形态 | 内存 | 状态 |
|---|---|---|---|
| **A. 自建宿主（唯一路线，2026-08-07 用户拍板）** | 标准 Node + stub QQNT.dll 转发（napi_* → node.exe）+ O3MiscService 激活 | ~100MB（待实测） | ✅ 登录 + session READY + 冒烟收发 + onebot11 装配，cli 默认（pnpm start） |
| **B. 注入 utilityProcess Worker**（NapCat 同款） | 注入 QQ 主进程 → worker dlopen | 300MB+ | ❌ **已淘汰（2026-08-07 用户拍板）**，launchQqWithLoader 仅历史回退 |
| C. V1/V2 主进程注入 | — | 1.01GB | ❌ 已排除 |

> **2026-08-07 用户拍板**：只保留自建宿主实现方式（NapCat 同款纯 Node 模式），路线 B
>（拉起 QQ + 注入）淘汰。cli `pnpm start` 默认走自建宿主（`launchSelfHost` → self-host.cjs）。

### 4.1 混合模式总览（两路线共用）

```
┌─────────────────────────────────────────────────────────────┐
│  业务层（开源，JS/NAPI）                                        │
│  pnpm monorepo：kernel / adapter / network / media / cli       │
│  通过纯 NAPI 调用 wrapper.node 业务 API（getMsgService 等）      │
├─────────────────────────────────────────────────────────────┤
│  载具层（私有，C++ Native，@napuketto/loader）                  │
│  ① NOP wrapper.node 环境自检与 self-register 校验               │
│  ② 激活 session 的 cpp_impl（伪造 C++ 层初始化信号，路线 B 用不上）│
│  ③ 阻断 Chromium UI / GPU / Renderer（无头 + 低内存）            │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 路线 B 链路（❌ 已淘汰，2026-08-07 用户拍板；仅历史回退）

```
pnpm start（apps/cli）——2026-08-07 起 cli 默认走自建宿主（4.3），不再走本链路
  └─ NapukettoBootMain.exe 拉起 QQ.exe + 注入 NapukettoWinBootHook.dll（自研 V1 资产）
  └─ hookdll IAT hook → 引导 boot.cjs（NAPUTO_ROUTE_B=1 分支）
  └─ boot.cjs fork utilityProcess Worker（继承 QQ env）→ route-b-worker.cjs
       └─ worker 内 process.dlopen(wrapper.node) → exports 98 个（QQ env 原生，无需 IAT 改写）
       └─ boot-bootstrap.js 复用 → kernel 装配 → 登录（快速/QR）→ session → 协议装配
  └─ 无头：阻断 UI/GPU/Renderer（vehicle.cpp）；主进程保留但无窗口
```

### 4.3 自建宿主链路（✅ 唯一实现方式，2026-08-07 实测全通）

```
pnpm start（apps/cli）→ launchSelfHost → 标准 Node 自建宿主进程（无 QQ 进程，~100MB 目标）
  ├── stub QQNT.dll 转发（napi_* → node.exe；自研 llvm-mingw 69KB PE 转发 stub，native 闭源）
  ├── process.dlopen(wrapper.node) → exports 98 个（标准 node 可完整加载，无需 IAT 改写）
  ├── NodeIO3MiscService.get() + addO3MiscListener 激活事件分发（否则 getLoginList 永不 resolve）
  ├── commonPath/desktopGlobalPath = 数据根/nt_qq/global（三要素之三）
  ├── 登录（快速 <测试QQ号> / QR）→ session.init(config) → startupSession.start()（先 init 后 start！）
  ├── 等 onOpentelemetryInit(is_init=true) → 业务 service 全 READY（getMsgService 298 方法）
  └── boot-bootstrap 复用 → kernel 装配 → onebot11 协议装配 → 收发/事件监听
```

**登录链路三要素（勿重复探索）**：① 加载 = stub QQNT.dll 转发（无需 IAT 改写；host-helper IAT
方案事件分发不工作已弃用）② `O3MiscService` 激活事件分发 ③ commonPath = 数据根/nt_qq/global。
**session READY 四步**：登录成功 → `session.init(config)` → `startupSession.start()`（**先 init 后
start！**）→ 等 `onOpentelemetryInit(is_init=true)`。`Base_PowerMessageWindow` 窗口类已验证**非必要**
（保留无害）。

**napi2native 真实职责（实证，非 env 兼容层）**：进程名伪装 QQ.exe、隐藏注入模块
（K32EnumProcessModules/GetModuleHandleW hook）、内存 RWX→RX 伪装、创建 `Base_PowerMessageWindow`
窗口类、数据包层 hook（Frida Gum，可选）。自研等价物需覆盖前 4 项。

### 4.4 关键实现认知（勿重复探索）

- **wrapper.node 无标准 NAPI 注册函数**（导出表仅 33 个 MSVC mangled 符号）：
  `qq_magic_napi_register` 是对 QQNT.dll 的**常规导入**（非 delay-load）；delay-load 表只有
  avif_convert/QBar/opencv/LightQuic/ncnn。`Module did not self-register` 来自标准 Node 的
  DLOpen 检查 `napi_register_module_v1`——QQ 定制 Electron 不查，走 `qq_magic_napi_register`。
- **QQNT.dll = 可独立加载的宿主桥接层**：导出全套 `napi_*` + v8 `Isolate` + node `AsyncResource` +
  `qq_magic_*`；导入仅系统 DLL + ffmpeg.dll。
- **session 创建（NapCat 方式，路线 B 实测）**：`StartupSessionWrapper.create()` →
  `getNTWrapperSession("nt_1")`（带 cpp_impl）→ `startupSession.start()`；
  **不要 `new NodeIQQNTWrapperSession()`**（cpp_impl 断言失败）。
- **initConfig 必须 `externalVersion: false`**（扫码兼容）；appid 每版本从 major.node
  `QQAppId/` 标记提取（9.9.33-51802 = 537376818）。
- **init 完成信号**：`onOpentelemetryInit(is_init===true)` 为主，`onSessionInitComplete(0)` 为辅。

## 5. 核心数据流

### 5.1 调用链（第三方 → QQ）

```
第三方框架 --POST/WS--> network 传输层
  --> adapter 协议适配器（zod 校验）
  --> adapter api 聚合（读 kernel 缓存，缺则调 API）
  --> kernel apis（统一错误语义：成功返业务值 / 失败抛类型化 KernelError）
  --> wrapper.node 原生服务
```

### 5.2 事件链（QQ → 第三方）

```
wrapper.node 原生回调
  --> kernel event-channel（每个 Service 只注册一次原生监听）
      ├── kernel 内部订阅：缓存主动维护（GroupCache / BuddyCache 等）
      └── 协议适配器订阅（onebot11 / satori / kurobot）：翻译为协议事件（只读缓存，纯函数）
          --> network EventBroadcaster 广播给所有 HTTP/WS 适配器
```

## 6. 关键设计决策（ADR 摘要，已按 2026-08-06 修正）

完整背景见各包 `docs/design.md`。

| # | 决策 | 否决了什么 | 理由 |
|---|---|---|---|
| ADR-001 | **许可证 MIT，零引入 NapCat 代码** | 移植 NapCat 类型/实现（GPL-2.0-only 与 MIT 不兼容） | 法律干净；接口签名是外部系统事实，可自研描述 |
| ADR-002 | **network 协议无关，adapter 依赖 network** | NapCat 的传输层绑定 OB11 类型 | 为 Satori 复用传输层 |
| ADR-003 | **类型化事件通道**（EventEmitter + 从 Listener 接口推导签名） | NapCat 的 Proxy + any 老事件系统 | 编译期类型安全；每个 Service 只注册一次原生监听 |
| ADR-004 | **不做 framework 模式** | QQNT 插件运行方式 | 已被证明低效，只做独立进程/宿主模式 |
| ADR-005 | **不做 webui；配置走 CLI + 单一 TOML** | 管理面板；独立 JSON 配置 | 错误决策；JSON 门槛高，TOML 统一配置 |
| ADR-006 | **类型层来自运行时探测** | 拍脑袋或抄别家类型 | 加载 wrapper.node 后反射摸清 API 面（探测脚本放 kernel/scripts/probe） |
| ADR-007 | **文件日志用 pino** | log4js（NapCat 方案） | 结构化、性能好、内置 redact |
| ADR-008 | **缓存主动同步 + 只读消费** | NapCat 散落缓存 + 翻译时实时查 API | 翻译层纯函数、无副作用、可并行 |
| ADR-009 | **apis 统一错误语义** | 原生 `{result, errMsg}` 透传 | 协议层错误码映射各写各的，共享同一套错误语义 |
| ADR-010 | **登录状态机在 kernel，渲染在 cli** | 登录逻辑混在启动脚本 | 可单测、可复用；cli 只渲染二维码 |
| ADR-011 | **media 严格解耦** | NapCat 把媒体工具放 common/utils | kernel 不背 ffmpeg/silk 依赖 |
| ADR-012 | **ConfigBase 在 kernel（TOML），协议 schema 在协议包** | 协议配置 schema 进 kernel | 协议语义属于各协议包 |
| ADR-013 | **协议适配器统一进 adapter 包（core 框架 + onebot11/satori）** | 每个协议一个平级包、翻译各写各的 | 适配器骨架只写一次，协议只需薄映射层 |
| ADR-014 | **adapter 子路径导出（subpath exports）** | 单入口聚合全部协议 | cli 只依赖用到的协议；tree-shaking 友好 |
| ADR-015 | **多进程多账号，cli 编排** | 单进程多账号 | wrapper 多 session 共存未验证；进程天然隔离；kernel 无全局单例 |
| ADR-016 | **数据目录按账号隔离，放用户目录；配置文件独立放项目根** | 数据放程序目录 | 程序目录可能只读；多账号天然分离；配置文件靠近项目便于管理（2026-08-07 修订） |
| ADR-017 | **KernelError 类型化错误 + 协议层映射表** | 原生 `{result, errMsg}` 透传（细化 ADR-009） | 错误分类在 kernel 只做一次 |
| ADR-018 | **wrapper 版本探测独立模块（wrapper-version）** | 硬编码版本路径 | appid/qua 与版本强相关（每版本从 major.node 解析） |
| ADR-019 | **loader 跨平台 v2：wine 跑 Windows node.exe（方案 a）** | 方案 b（wine 跑完整 QQ）；在 npm 包/Docker 镜像内置任何腾讯二进制 | 只暴露无状态标准协议端口，云原生部署；2026-08-12 用户拍板（loader design.md） |
| ADR-020 | **koishi 插件经 loader IPC 共享动作表**（`NAPUTO_IPC=1`，loader 运行时动态 import adapter/network） | 插件进程内直连原生（崩溃连带）/ 独立网络端口双开 | 零网络传输零配置 IO；动态 import 不构成编译期依赖，依赖方向不变（2026-08-27，loader design.md §9） |
| ADR-021 | **kurobot 连接层在 adapter 包内自建**（不复用 network.WsClient） | 给 network.WsClient 加子协议/onOpen/退避参数 | 子协议握手、应用层心跳、close-code 感知退避全是 kurobot 协议语义，下沉 network 违反协议无关（2026-09-13，adapter design.md §8.2） |
| ADR-022 | **版本管理 Changesets；GitHub Release repo 级 tag 与包版本解耦** | 手工改版本号；repo tag 锚定包版本 | 多包联动 bump 自动化；首个 GitHub Release v0.1.0（2026-09-19）即 repo 级 |

> **编号说明**：文档与代码中出现的 **ADR-026 / ADR-030 是姊妹项目 KuroAdapter 的 ADR**
> （`bridge/protocol`：026 = 未知帧容忍策略，030 = kurobot→kurobridge 品牌改名），非本仓
> 编号；本仓编号 001~022 连续，无缺号。

## 7. 路线图（现状修正，2026-08-06）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 地基** | 类型层 + paths/config/logger/event-channel + errors/wrapper-version | ✅ 完成 |
| **P1 登录** | wrapper-version → engine init → QR/快速登录 → CoreContext + selfInfo | ✅ 完成（含网络重试 + 快速登录超时兜底 T3） |
| **P2 消息链路** | apis/msg 收发 + adapter 订阅 + OB11 翻译 + network 广播 + send_msg | ✅ 完成（含富媒体发送三连修复） |
| **P3 OB11 补全** | 群管/好友/文件/资料/系统 动作 + notice/request/meta 事件 + HTTP 上报 | ✅ 完成（79 动作（含别名变体），对齐度 ≈70%） |
| **P4 扩展** | 合并转发、翻译、在线状态、media 接入、api 聚合、GroupCache | ✅ 完成 |
| **P5 多协议** | satori 协议适配器（adapter 包内新目录，复用 core 框架） | ✅ 完成（2026-08-08：HTTP RPC + WS 事件服务 + 元素 XML 编解码 + 20 动作 + 4 类事件） |
| **P6 多账号** | cli 子进程编排（supervisor）+ 运维命令 status/stop/restart | ✅ 完成（2026-09-08 运维命令实测） |
| **P7 第三协议 kurobot** | adapter 包内 kurobot/ 目录（kurobridge-ws 客户端，QQ 群 ↔ MC） | ✅ 完成（2026-09-13 MVP-3；协议镜像 0.4.0） |
| **P8 工程化** | Changesets 发版链 / CI 三 job / Codecov / fallow audit 门禁 / 贡献文档 | ✅ 完成（2026-09；首个 GitHub Release v0.1.0） |
| **P9 loader 跨平台** | 无本机 QQ 运行（多级来源 + 自动下载）+ wine/Linux | ✅ 代码完成（wine 冒烟全绿；完整登录待测）；Docker ❌ 未实现 |

> P 系列之后 webui 永远不在路线图上；数据包层（packet 后端）为远期项。

## 8. 红线与合规（AGENTS.md 第 7 条，两路线都适用）

1. **允许必要逆向（2026-08-06 用户拍板：非 0 逆向）**：环境模拟/反风控（进程名伪装、模块隐藏
   K32EnumProcessModules/GetModuleHandleW、内存 RWX→RX、窗口类）、数据包层 hook（Frida Gum 等价物）、
   无头阻断均可逆向。技术手段不设限（koffi / vtable 槽位 / 内存偏移 / thiscall 裸调）但**仅限
   loader 载具层**。
2. **业务层优先 NAPI（优先级而非禁令）**：收发消息/事件监听/数据解析优先走官方 NAPI 导出接口
   （稳定、简单、可维护）；仅当 NAPI 无法覆盖的能力（数据包层、环境模拟）才用 C++ 逆向补足。
3. **零磁盘篡改**：内存 Patch 仅在运行期 RAM 生效，严禁修改/覆盖 QQ 安装目录任何二进制。
4. **逆向产物管理**：Ghidra 分析（RVA 表/Offset）不提交公共仓库，仅存私有；`native/` 只分发
   编译+混淆二进制。
5. **零引入 NapCat 代码**（GPL-2.0 / Limited Redistribution License 与 MIT 不兼容；napi2native 闭源）。

## 9. 工具链

### 9.1 逆向分析（仅在需要时，路线 B 已无需）

- Ghidra 12.1.2（`<逆向工具目录>\ghidra_12.1.2_PUBLIC\`）+ GhidraMCP 1.4（`<逆向工具目录>\GhidraMCP-1-4\`）
- 项目：`<逆向工具目录>\ghidra-project\NapukettoWrapper.gpr`（wrapper.node 已全量分析）
- 用法见子仓库 `packages/loader/native/docs/ghidra-mcp-guide.md`（2026-08-07 移入闭源子仓库）
- **⚠️ 2026-08-07 更新**：自建宿主（唯一路线）已全链路实测通过，**不需要**激活 session cpp_impl；
  窗口类（Base_PowerMessageWindow）已验证非必要。Ghidra 现仅用于远期数据包层（packet 后端）与
  「仅限 loader 载具层」的逆向手段研究。

### 9.2 C++ 构建（历史资产）

- V1 注入框架（bootmain/hookdll）与 V2 载具（vehicle.cpp）**已归档 archive/，loader 不再
  编译 C++ 组件**（AGENTS.md 第 7 条）；stub QQNT.dll 用 LLVM-MinGW 编译（构建流程记录在
  native 闭源子仓库 docs/）。
- `packages/loader/native/` 现为**私有 submodule**（NapukettoDev/NapukettoQQ-Native），仅保留
  闭源 stub 编译产物；clone 后需 `git submodule update --init --recursive`。

### 9.3 环境事实

- QQ 9.9.33-52230（2026-09-08 实测）：`C:\Program Files\Tencent\QQNT\`（wrapper.node 114MB，
  exports 98 个；9.9.27/9.9.31 登录服务已下线勿用）
- QQ 登录数据：`<用户目录>\Documents\Tencent Files\`（多账号；测试账号注意事项见 STATUS.md）
- 自建宿主 stub：`packages/loader/native/build/stub-test-env/`（默认 stub 目录，llvm-mingw 编译）
- NapCat 参考部署包：仅历史参考，已不依赖

### 9.4 发版与 CI（2026-09 落地）

- **版本管理**：Changesets——每批用户可见改动随改动写 `.changeset/<名字>.md`（勿攒），
  发版 `pnpm release` 消费（升版本 + CHANGELOG + 构建 + 拓扑序发布）；工作流细则见 AGENTS.md。
- **发版脚本**：`scripts/release/`（release-npm 支持 `--otp=` / `NAPKETTO_NPM_OTP` 透传 npm
  2FA 验证码；sync-adapter-deps 发版链自动对齐 koishi 插件依赖范围）。
- **GitHub Release**：repo 级 tag 与包版本解耦（2026-09-19 首 Release v0.1.0）。
- **CI**（`.github/workflows/ci.yml`）：gate（ubuntu：build → check → test + Codecov）/
  windows（跨平台测试补位）/ audit（fallow 增量门禁 `--base`）三并行 job；
  `update-qq-releases.yml` Cron 维护 QQ 版本清单。
- **pre-commit**：`scripts/git-hooks`（root prepare 启用）lockfile 一致性门禁——暂存
  package.json / pnpm-workspace.yaml / 子模块指针必须同刷 pnpm-lock.yaml。
- **贡献文档**：`.github/CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md`。
