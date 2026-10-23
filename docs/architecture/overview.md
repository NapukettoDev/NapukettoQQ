# 架构总览

## 1. 项目定位

NapukettoQQ 是基于 QQ NT 客户端原生模块（`wrapper.node`）的机器人框架：

- **自建宿主**：标准 Node 进程通过 stub `QQNT.dll` 直接 `dlopen` `wrapper.node`，
  不拉起 QQ 客户端、不注入 QQ 进程、无 UI。Linux 下用 wine 运行 Windows 版 `node.exe`。
- **多协议对外**：OneBot 11（主协议）、Satori，另含 KuroBot 群服互通客户端。
- **全自研**：pnpm monorepo + TypeScript + tsdown + biome + vitest；MIT 许可。
- **单一配置**：项目根一份 `napuketto.toml`，账号内嵌协议段；账号必填。

**明确不做**：WebUI、插件系统、framework 模式（把本框架做成 QQNT 插件）、OneBot 12
（规范过于模糊，已放弃）。功能范围 = 完整协议 + API 能力 − WebUI − 插件系统，且只做
原创实现。

## 2. 仓库结构

| 路径 | 包名 | 职责 |
|---|---|---|
| `packages/kernel` | `@napuketto/kernel` | 唯一原生交互层：wrapper 加载、登录/session、业务 API、事件通道、缓存、配置/路径/日志/错误 |
| `packages/network` | `@napuketto/network` | 协议无关传输原语：HTTP server/client、WS server/client、泛型广播 |
| `packages/media` | `@napuketto/media` | 媒体识别与转码：图片尺寸/类型、silk、ffmpeg 视频 |
| `packages/adapter` | `@napuketto/adapter` | 协议适配器容器：core 框架 + onebot11 / satori / kurobot |
| `packages/loader` | `@napuketto/loader` | QQ 原生文件定位/下载、stub 校验、自建宿主启动、实例锁、IPC、wine |
| `apps/cli` | `@napuketto/cli` | 命令行入口：单账号/多账号 supervisor、config、status/stop/restart |
| `apps/napuketto-create` | `create-napukettoqq` | 项目脚手架：生成 `napuketto.toml` 与目录骨架 |
| 仓外 | `koishi-plugin-adapter-napuketto` | Koishi 适配器，独立仓库，只依赖 npm 上已发布的 `@napuketto/*` |

## 3. 依赖方向

只允许向下依赖。编译期依赖如下：

```
create-napukettoqq
  └─ @napuketto/cli
       ├─ @napuketto/adapter
       │    ├─ @napuketto/kernel
       │    ├─ @napuketto/network
       │    └─ @napuketto/media
       ├─ @napuketto/loader
       ├─ @napuketto/kernel
       └─ @napuketto/network

@napuketto/kernel   无内部依赖（pino / pino-pretty / smol-toml）
@napuketto/network  无内部依赖（hono / @hono/node-server / ws）
@napuketto/media    无内部依赖（silk-wasm / file-type / image-size / execa）
```

`@napuketto/loader` 对 kernel 是**运行期契约**而非编译期依赖：`package.json` 只依赖 `zod`，
引导时通过 `NAPUTO_KERNEL_ENTRY` 动态 `import()` kernel。这样自建宿主入口可以打成单文件
CJS bundle，同时依赖方向仍保持 loader → kernel 语义。

Koishi 适配器在独立仓库，不参与本仓 workspace / CI / 发布链；跨仓联调走 `pnpm pack`
tarball 或 prerelease，不要恢复 workspace link（否则测的不是 npm 安装形态）。

## 4. 分层原则

| 层 | 职责 | 边界 |
|---|---|---|
| **kernel** | 原生模块加载、登录与 session 生命周期、业务 API、类型化事件通道、缓存、基础设施 | 全仓唯一允许 `process.dlopen`、访问 `wrapper.node`、注册原生 listener 的包；无全局单例，运行时对象由 `CoreContext` / 装配层持有 |
| **network** | HTTP/WS 传输与泛型广播 | 禁止 import 任何协议包；事件类型必须泛型化；路由/鉴权由协议层注入 |
| **media** | 图片/音频/视频/文件识别与转码 | 只被协议层依赖；kernel 不背 ffmpeg/silk 依赖 |
| **adapter** | 协议语义：事件翻译、动作注册表、动作错误码、传输装配 | 只认识 kernel 的 API/事件/缓存，不认识原生；协议实现走子路径导出 |
| **loader** | 定位/下载 QQ 原生文件、校验 stub、spawn 自建宿主、实例锁、IPC、wine | 不写业务逻辑；逆向手段（如启用）仅限本层与私有 native 组件 |
| **cli** | 启动编排、账号监督、配置命令、运维命令、登录渲染 | 不做协议翻译；只装配与转发 |
| **create** | 脚手架 | 不包含运行时逻辑 |

## 5. 运行形态

```
CLI（单账号或 supervisor）
  └─ boot 进程
       └─ 自建宿主进程（标准 Node；Linux 为 wine + Windows node.exe）
            ├─ stub QQNT.dll（PATH 前置，转发宿主符号）
            ├─ wrapper.node（dlopen）
            └─ kernel → 登录/session → 事件通道/缓存/API
                 ├─ adapter（onebot11 / satori）→ network 传输
                 └─ adapter（kurobot）→ 自带 WS 客户端
```

自建宿主没有 QQ 进程和 UI，因此“无头阻断”天然满足；载具层历史职责（激活 `cpp_impl`、
阻断 Chromium 子进程）在当前路线不再需要。详细启动链、登录顺序与数据流见
[runtime.md](runtime.md)。

## 6. 硬性红线

1. **许可证 MIT，零引入 GPL-2.0-only 实现代码**：任何文件（含类型定义）不得复制或移植自
   GPL-2.0-only 项目（该许可证与 MIT 不兼容）。接口签名是外部系统（腾讯 `wrapper.node`）的
   事实，可以自研描述，但架构与实现必须原创。
2. **kernel 是唯一原生交互层**：其他包不得直接 `dlopen`、访问 `wrapper.node`、注册原生
   listener；只能调 kernel 的语义化 API、订阅事件通道、读缓存。
3. **network 协议无关**：不得 import 协议包；事件与传输适配器保持泛型。
4. **media 严格解耦**：只被协议层依赖，kernel 不背媒体依赖。
5. **零磁盘篡改**：运行期只在内存中操作，严禁修改/覆盖 QQ 安装目录中的任何二进制
   （`QQNT.dll` / `wrapper.node` / `package.json` / asar）；升级、卸载零残留。
6. **逆向边界**：允许为环境模拟、数据包层、无头阻断做必要逆向，但技术手段仅限 loader
   载具层；业务层优先走官方 NAPI。逆向产物（RVA / Offset 表）不进公共仓库。
7. **native 私有**：`packages/loader/native` 是私有 Git submodule，只分发编译后的 stub；
   公共仓库与 npm 包不包含逆向产物或腾讯二进制。
8. **配置单一来源**：所有配置在 `<项目根>/napuketto.toml`，不再使用独立 JSON 协议配置；
   账号必填，账号内没写某协议段 = 不启用该协议。

红线与当前决策的理由见 [decisions.md](decisions.md)。
