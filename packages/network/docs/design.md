# @napuketto/network 设计书（2026-11-03 首版）

> 本包是**协议无关的底层传输原语层**（ADR-002）：通用 HTTP client/server、
> WebSocket client/server、SSE 响应原语、泛型广播总线。它只解决「怎么传」，
> 不解决「传什么」——路由分发、鉴权规则、载荷序列化、心跳与重连策略全部由
> 协议层通过注入点提供。同一套原语要同时供 OneBot 11 / Satori / Milky 复用。

## 1. 包职责与架构边界（ADR-002）

ADR-002 否决了「传输层直接绑定 OB11 类型」：一旦把协议语义写进传输层，Satori
的路径路由、Milky 的同端口 WS 升级、KuroBot 的子协议握手就会各自打补丁。

能力面（全部与协议无关）：

| 原语 | 实现 | 典型承载场景 |
| :--- | :--- | :--- |
| 反向 HTTP server（入站） | `http-server.ts` | OneBot 11 HTTP POST、Satori RPC 路径路由 |
| 正向 HTTP client（出站上报） | `http-client.ts` | 事件 HTTP 上报（fire-and-forget） |
| 反向 WS server（入站） | `ws-server.ts` | OneBot 11 正向 WS、Satori WS |
| 正向 WS client（出站连接） | `ws-client.ts` | OneBot 11 反向 WS、Satori 反向 WS |
| SSE 事件流原语 | `sse.ts` | Milky `/event` 的 `text/event-stream` 推送 |
| 泛型广播总线 | `broadcaster.ts` | 把一条事件广播给全部已注册传输适配器 |

红线约束（与 `docs/architecture/overview.md` 一致）：

- **严禁 import 任何上层协议包**：本包不得出现 `@napuketto/adapter`、
  `@napuketto/kernel`、`@napuketto/media` 的导入；也不得出现任何协议
  （onebot11 / satori / milky / kurobot）的目录或类型。运行时依赖只有
  `hono`、`@hono/node-server`、`ws`。
- **事件类型全部泛型化**：`TransportAdapter.send<T>(payload: T)`、
  `EventBroadcaster.emit<T>`；入站载荷类型是 `unknown`，收窄由协议层完成。
- **协议差异用注入点表达，不用 `if (protocol)`**：
  - `onRequest`：整机入口（OneBot 11 单入口）
  - `onPathRequest`：按 `path` / `method` 分发（Satori RPC）
  - `onRawRequest`：返回 `Response` 即短路，跳过 JSON 解析（SSE 等无 body 端点）
  - `onUpgrade`：同端口 WS 升级交接（Milky `/event`）
  - `authorize`：鉴权钩子，规则（token 来源等）由协议层决定
- **依赖方向**：`kernel` / `media` / `network` 三个底层包互不依赖；本包被
  `packages/adapter`（协议层容器）与 `apps/cli`（宿主装配）以 `workspace:*`
  消费；kernel 不依赖 network。
- **WS 连接类型归本包所有**（2026-11-03 依赖收敛）：`types.ts` 导出 `WsSocket`
  （ws 的连接类型）与 `isWsOpen()`（`readyState === OPEN` 的唯一判定入口）。协议层
  （adapter 的 Milky `/event` 枢纽）只经这两个符号接触连接，因此**不需要**在自己的
  `dependencies` 里声明 `ws`——ws 的版本与实例由 network 单点持有。
- **入帧 UTF-8 强校验**：`WsServer` 与 `HttpServer` 的同端口升级都显式设置
  `skipUTF8Validation: false`（ws 默认值，写死防止后人为「微秒级性能」关掉）。文本帧
  在进入 `JSON.parse` / 日志前必须已校验 UTF-8，否则畸形字节流会变成下游乱码或异常，
  而不是可诊断的协议错误。
- **不装原生加速插件**：`bufferutil` / `utf-8-validate` 是 ws 的可选 peer，本仓刻意不装
  （Node 22/24 内置的 UTF-8 校验与 V8 掩码异或已足够快，跨 C++ 边界反而更慢；也符合
  「只有 kernel 允许原生层」的硬约束）。
- **ADR-021 补充边界**：KuroBot 的子协议握手、应用层心跳、close-code 感知
  退避属于协议语义，在 adapter 内自建连接层，**不下沉本包**——否则等于把
  协议语义塞回传输层。
- **无全局状态**：不读配置文件、不持有进程生命周期、不自行决定端口；
  `host` / `port` / `timeoutMs` 等全部由调用方传入，每个实例独立。

## 2. 核心抽象与实现清单

| 文件 | 导出 | 职责 |
| :--- | :--- | :--- |
| `src/types.ts` | `TransportAdapter`、`RequestContext`、`AuthorizeHook`、`Respond`、`HttpRouteContext`、`RawRequestHook`、`WsUpgradeHook`、`WsSocket`、`isWsOpen`、`ServerOptions`、`HttpServerOptions`、`HttpClientOptions`、`WsServerOptions`、`WsClientOptions` | 核心契约。`TransportAdapter` 是四类传输的统一面（`send` / `open` / `close` / 可选 `onRequest`），`EventBroadcaster` 只依赖它；`Respond(res, status?)` 的 `status` 仅 HTTP 侧使用（WS 忽略）；`WsSocket` + `isWsOpen` 是协议层接触 WS 连接的唯一入口（协议层不直接依赖 ws） |
| `src/http-server.ts` | `HttpServer` | 基于 `hono` + `@hono/node-server` 的反向 server。处理链：`authorize` → `onRawRequest`（命中即短路返回 `Response`）→ JSON 解析 → `onPathRequest`（优先）/ `onRequest` → `respond`；`onUpgrade` 在 `open()` 时挂到原生 `upgrade` 事件，实现 SSE 与 WS 同端口共存 |
| `src/http-client.ts` | `HttpClient` | 正向 HTTP 上报：`send` 即触发一次 POST（fire-and-forget），失败（网络 / 非 2xx / 超时）经 `onError` 交回协议层；`open` / `close` 为无连接管理语义 |
| `src/ws-server.ts` | `WsServer` | 反向 WS server：消息经 `onRequest` 分发、`respond` 回同一客户端；鉴权失败以 close code `4401` 关闭；`heartbeat` 按间隔 ping 全部连接 |
| `src/ws-client.ts` | `WsClient` | 正向 WS client：`open()` 成功 resolve / 失败 reject（不自动重试），断线后按 `reconnect` 策略重连（`maxAttempts` 计数），支持 `heartbeat` 与 `rejectUnauthorized: false`（自签证书） |
| `src/sse.ts` | `createSseResponse`、`SseClient`、`SseHandler` | 纯 HTTP 语义的 SSE 帧原语（`event:` 行 + `data:` 行 + 空行）；把「接入 → 推送 → 断开清理」抽象为 `SseClient`，退订函数在流取消或服务端 `close` 时回调。**不持有端口**，传输装配由 `HttpServer.onRawRequest` 承接 |
| `src/broadcaster.ts` | `EventBroadcaster` | 泛型广播总线：`register` / `unregister` / `emit`，对 `Set` 内全部 `TransportAdapter` 广播同一事件；重复注册幂等 |
| `src/index.ts` | 上述全部 | 包门面（唯一构建入口）：只做 re-export，不含逻辑 |

## 3. 构建与导出形态

- **零配置 tsdown**：包内没有 `tsdown.config.ts`，直接 `tsdown` 默认行为——入口
  `src/index.ts`、默认 ESM 格式，产出 `dist/index.mjs` 与类型声明
  `dist/index.d.mts`。`hono` / `@hono/node-server` / `ws` 是 `dependencies`，
  按 tsdown 默认 externals 处理，不打入产物。
- **ESM-only 现状（历史契约观察项，本次不动）**：`package.json` 的 `exports`
  三个条件（`types` / `import` / `require`）都指向 `.mjs` / `.d.mts`——即
  `exports["."].require` 也指向 `./dist/index.mjs`。因此 CJS 消费方 `require()`
  本包时，实际依赖 **Node ≥ 22.12 的 `require(esm)`** 能力；在更早的 Node 20
  上会抛 `ERR_REQUIRE_ESM`。
  - 这是历史契约，不是本包刻意的设计选择。本次结构重构**不改动它**：改
    `exports` 属于运行时契约变更，需单独评估（若要支持旧 Node 的 CJS 消费方，
    应参照 `@napuketto/media` 的双格式 + `require` 条件方案另开 PR）。
  - 记录为观察项，供后续依赖方（Koishi 插件的加载形态）核对。

## 4. 测试布局

单元测试统一放 `src/__tests__/`（与 kernel / media / adapter 一致，避免与源码
同层平铺），由根 `vitest.config.ts` 的 `packages/*/src/**/*.test.ts` 发现，
相对导入下沉一层后保留 NodeNext 的 `.js` 后缀（`../sse.js`）。

| 测试 | 覆盖 |
| :--- | :--- |
| `src/__tests__/sse.test.ts` | SSE 帧格式（`event:` / `data:` / 空行）、事件名缺省、断开退订、`close` 后 `send` 静默——纯逻辑，无端口 |
| `src/__tests__/http-server-stream.test.ts` | 真实端口（`127.0.0.1`）集成：`onRawRequest` 短路返回 SSE 流、`onUpgrade` 同端口完成 WS 握手、常规 JSON 路由不受影响、鉴权仍先于 `onRawRequest` |
