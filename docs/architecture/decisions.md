# 决策记录（ADR）

> 这里只保留**仍然约束当前代码**的决策与已废止路线的结论。历史推演、实验记录与旧交接
> 文档已删除，需要追溯时查 git 历史。新决策追加编号，不重排、不复用。

## 现行决策

| # | 决策 | 否决/替代方案 | 理由 |
|---|---|---|---|
| ADR-001 | 许可证 MIT，零引入 NapCat 代码 | 复制/移植 NapCat 类型或实现 | NapCat 为 GPL-2.0-only，与 MIT 不兼容；接口签名是外部系统事实，可自研描述 |
| ADR-002 | `@napuketto/network` 协议无关，adapter 依赖 network | 传输层直接绑定 OB11 类型 | 同一套传输原语要供 OneBot 11 / Satori 复用 |
| ADR-003 | 类型化事件通道（`NTEventChannel`，事件名 `Service/method`） | Proxy + `any` 的旧事件系统 | 编译期签名检查；每个 Service 只注册一次原生 listener；单订阅者异常不打断派发 |
| ADR-004 | 不做 framework 模式（QQNT 插件） | 以 QQ 插件形式运行 | 只做独立宿主/进程模式，便于部署与隔离 |
| ADR-005 | 不做 WebUI；配置走 CLI + 单一 TOML | 管理面板；独立 JSON 配置 | JSON 门槛高；单文件 TOML 便于手改、审查与版本控制 |
| ADR-006 | 类型层来自运行时探测 | 拍脑袋或抄第三方类型 | 加载 `wrapper.node` 后反射 + 实体日志观察，避免类型与真实 API 脱节 |
| ADR-007 | 日志统一 pino | log4js 等 | 结构化、性能好、内置 redact |
| ADR-008 | 缓存主动同步 + 只读消费；协议翻译为纯函数 | 翻译时实时查 API、缓存散落各处 | 翻译可单测/并行，事件链路无隐式副作用 |
| ADR-009 | kernel 业务 API 统一错误语义（成功返值，失败抛 `KernelError`） | 原生 `{result, errMsg}` 直接透传 | 错误分类只做一次，协议层只维护映射 |
| ADR-010 | 登录状态机在 kernel，终端渲染在 cli | 登录逻辑混在启动脚本 | 可单测、可复用；cli 只负责展示二维码/状态 |
| ADR-011 | `@napuketto/media` 严格解耦 | 媒体工具放进 kernel 或 common utils | kernel 不背 ffmpeg/silk 依赖，只被协议层消费 |
| ADR-012 | `ConfigBase` 在 kernel；协议配置 schema 归各协议包 | 所有协议 schema 塞进 kernel | 协议语义属于协议包；kernel 只提供 TOML/JSON 读写与校验基类 |
| ADR-013 | 协议适配器统一进 `@napuketto/adapter`（core + 各协议目录） | 每个协议一个平级包 | 生命周期/动作注册/配置框架只写一次，协议只做薄映射 |
| ADR-014 | adapter 子路径导出（`.` / `./core` / `./onebot11` / `./satori` / `./kurobot`） | 单入口聚合全部协议 | 消费方只加载用到的协议；tree-shaking 友好；根入口保持轻量 |
| ADR-015 | 多账号 = 多进程，cli 编排；kernel 无全局单例 | 单进程多账号 | wrapper 多 session 共存未验证；进程天然隔离；每进程一份运行时对象 |
| ADR-016 | 数据目录按账号隔离；全局配置放项目根 | 数据/配置放程序目录或用户目录 | 程序目录可能只读；多账号目录天然分离；配置靠近项目便于管理。2026-08-08 修订为账号内嵌协议段 |
| ADR-017 | `KernelError` 类型化错误 + 协议错误码映射表 | 各协议各写一套错误判断 | 错误分类集中在 kernel，协议层只做映射 |
| ADR-018 | wrapper 版本探测独立模块 | 硬编码版本路径/appid | appid、qua 与版本强相关；从 `major.node` 运行时解析 |
| ADR-019 | loader 跨平台：Linux 用 wine 跑 Windows `node.exe`；不内置腾讯二进制 | wine 跑完整 QQ；在发布产物中内置腾讯二进制 | 只暴露标准协议端口；运行时下载官方安装包，仓库保持干净 |
| ADR-020 | Koishi 插件经 loader IPC 共享动作表（`NAPUTO_IPC=1`） | 插件进程内直连原生；独立端口双开 | 零网络传输、零配置 IO；loader 运行时动态 import，不构成编译期依赖 |
| ADR-021 | kurobot 连接层在 adapter 内自建（不复用 `network.WsClient`） | 给 `WsClient` 加子协议/onOpen/close-code 退避 | 子协议握手、应用层心跳、close-code 感知退避都是协议语义，下沉 network 违反协议无关 |
| ADR-022 | 版本管理用 Changesets；GitHub Release 的 repo tag 与包版本解耦 | 手工改版本；repo tag 锚定包版本 | 多包联动 bump 自动化；各包独立版本、独立发布 |
| ADR-023 | Koishi 适配器独立成仓 | 继续 submodule + 主仓 workspace 双身份 | submodule 只适合源码保密边界；独立发布单元需要自己的 lockfile/CI/版本节奏 |
| ADR-024 | 自建宿主为唯一运行路线（标准 Node + stub `QQNT.dll`） | 注入 QQ 主进程 / utilityProcess worker / 载具激活 `cpp_impl` | 无 QQ 进程与 UI、内存可控、部署简单；登录→READY→收发→协议装配已全链路验证 |

编号说明：文档或代码中出现的 **ADR-026 / ADR-030 属于姊妹项目 KuroAdapter / KuroBridge**，
不是本仓编号。本仓编号 001~024 连续。

## 已废止路线（只留结论）

| 路线/方案 | 结论 |
|---|---|
| V1：注入 QQ 主进程 + IAT hook 引导 boot JS | 可用但内存约 1GB，不可接受；已删除 |
| V2：Native Bypass 载具激活 session `cpp_impl` | 自建宿主不需要；载具不再编译，历史实现查 git |
| 路线 B：拉起 QQ → 注入 → utilityProcess worker | 已淘汰（2026-08-07 用户拍板），CLI 不再实现或调用 |
| OneBot 12 | 规范过于模糊，已删除占位 |
| 独立 JSON 协议配置 / 顶层 `[onebot11]` 配置 | 改为项目根单一 TOML + 账号内嵌协议段 |
| framework 模式 / WebUI / 插件系统 | 永远不做；功能范围 = NapCat 能力 − WebUI − 插件系统 |

## 记录规则

- 影响跨包契约、运行路线、许可证边界、发布方式的决定才记 ADR；单包实现细节写包内
  `docs/design.md`。
- 新增条目只追加编号；被替代的条目保留并注明替代者，不删除历史编号。
- 代码与 ADR 冲突时，先确认代码是否为有意变更：是则更新 ADR，否则修代码。
