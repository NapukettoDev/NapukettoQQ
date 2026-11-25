# @napuketto/network 设计书

> 本包是**协议无关的底层传输原语层**（ADR-002）：HTTP client/server、WebSocket
> client/server、SSE 与泛型广播。只解决「怎么传」，不解决「传什么」——路由、鉴权、
> 载荷与传输选项由调用方提供，连接判活、发送上限与断线退避由传输层执行。

## 包职责与架构边界（ADR-002）

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
- `onUpgrade` 同步选择 `accept` 或 `reject`，只采纳第一次选择，钩子返回后执行。无决定回 404，决策异常回 500，关停中的接入回 503。network 负责写完拒绝响应并关闭 TCP。未安装钩子的端口按 Node 默认行为回收 Upgrade socket。接受后由 `ws` 验证握手，交接回调异常则终止 WS。协议层负责路由和鉴权，network 保留 TCP／WS 的关停与超时回收职责。
- 请求构造、路由或鉴权抛错时返回固定错误响应，避免框架默认异常日志输出请求输入。
- **依赖方向**：`kernel` / `media` / `network` 三个底层包互不依赖；本包被
  `packages/adapter`（协议层容器）与 `apps/cli`（宿主装配）以 `workspace:*`
  消费；kernel 不依赖 network。
- **WS 连接类型归本包所有**（依赖收敛）：`types.ts` 导出 `WsSocket`
  （ws 的连接类型）、`isWsOpen()` 和 `sendWsText()`。上层经这些符号管理连接、
  发送已序列化的文本，因此**不需要**在自己的
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

## 核心抽象与实现清单

| 文件 | 导出 | 职责 |
| :--- | :--- | :--- |
| `src/types.ts` | `TransportAdapter`、`RequestContext`、`AuthorizeHook`、`Respond`、`HttpRouteContext`、`RawRequestHook`、`WsUpgradeHook`、`WsSocket`、`isWsOpen`、`ServerOptions`、`HttpServerOptions`、`HttpClientOptions`、`WsServerOptions`、`WsClientOptions` | 核心契约。`TransportAdapter` 是四类传输的统一面（`send` / `open` / `close` / 可选 `onRequest`），`EventBroadcaster` 只依赖它；`Respond(res, status?)` 的 `status` 仅 HTTP 侧使用（WS 忽略） |
| `src/http-server.ts` | `HttpServer` | 基于 `hono` + `@hono/node-server` 的反向 server。处理链：`authorize` → `onRawRequest`（命中即短路返回 `Response`）→ JSON 解析 → `onPathRequest`（优先）/ `onRequest` → `respond`；`onUpgrade` 在 `open()` 时挂到原生 `upgrade` 事件，实现 SSE 与 WS 同端口共存 |
| `src/http-client.ts` | `HttpClient` | 正向 HTTP 上报：`send` 即触发一次 POST（fire-and-forget），失败（网络 / 非 2xx / 超时）经 `onError` 交回协议层；`open` / `close` 为无连接管理语义 |
| `src/ws-server.ts` | `WsServer` | 反向 WS server：消息经 `onRequest` 分发，`respond` 回同一客户端。握手鉴权走 `authorize`，通过后 `onConnection` 把连接与 `RequestContext` 交给调用方，可用于带内鉴权；鉴权失败以 close code `4401` 关闭 |
| `src/ws-client.ts` | `WsClient` | 正向 WS client：`open()` 成功 resolve / 失败 reject（不自动重试），断线后按 `reconnect` 策略重连（`maxAttempts` 计数），支持 `heartbeat` 与 `rejectUnauthorized: false`（自签证书） |
| `src/ws-flow.ts` | `sendWsText` | 对调用方选定的连接发送相同文本，逐连接执行发送上限；内部也提供 ping/pong 判活 |
| `src/sse.ts` | `createSseResponse`、`SseClient`、`SseHandler` | 纯 HTTP 语义的 SSE 帧原语（`event:` 行 + `data:` 行 + 空行）；把「接入 → 推送 → 断开清理」抽象为 `SseClient`，退订函数在流取消或服务端 `close` 时回调。**不持有端口**，传输装配由 `HttpServer.onRawRequest` 承接 |
| `src/broadcaster.ts` | `EventBroadcaster` | 泛型广播总线：`register` / `unregister` / `emit`，对 `Set` 内全部 `TransportAdapter` 广播同一事件；重复注册幂等 |
| `src/index.ts` | 上述全部 | 包门面（唯一构建入口）：只做 re-export，不含逻辑 |

## HTTP 请求与服务生命周期

- `open()` 仅在监听成功后完成；监听错误（如端口占用）reject，回收尚未监听的
  HTTP/WS 资源后允许重试。并发 open/close 去重，close 等待正在进行的启动。
- `close()` 先停止接受连接，等待 respond 的普通请求以 HTTP 503 结束；同端口 WS
  发送 1001 关闭帧。最多等待 250ms 后强断剩余连接（含流式响应、未完成请求体、
  未完成升级、未配合 WS），释放监听器和 WebSocketServer；重复关闭安全，可再次启动。
- `timeoutMs > 0` 从普通 JSON 请求进入分发开始计时，超时回 HTTP 504；缺省或
  非正数不启用。`onRawRequest` 已返回的 Response（含合法 SSE）不适用此超时。
- respond 首次有效响应生效；超时、断开、关停或首次响应之后的迟到/重复调用均忽略，
  不再序列化载荷。同步 handler 异常或响应序列化异常回 HTTP 500；已响应时保持首个结果。
  超时/关停不取消协议层已开始的业务操作。

## WebSocket 连接可靠性

- `WsServer` 和 `WsClient` 可配置 `heartbeat`。连接建立或收到匹配 pong 后等待
  `intervalMs` 再发 ping，每条连接只等一个 pong，接受内容与当前 ping 相同的回应。
  `pongTimeoutMs` 缺省取 `max(intervalMs, 1000)` 毫秒。超时立即断开；连接关闭或主动
  停止时清理定时器。省略 `heartbeat` 时不发起探测。
- `sendWsText()` 只尝试向 OPEN 连接写入文本。逐连接按 `bufferedAmount`、新帧
  UTF-8 字节数及 14 字节的帧头余量检查，缺省上限为 32 MiB，正整数 `maxBufferedBytes`
  可覆盖。超限立即终止该连接，不写入新帧，也不等待关闭握手排队；对端通常观察到
  1006，缓冲中尚未发出的事件可能丢失，且传输层不重放。单帧超过预算也适用。
  健康连接仍按发送顺序接收。该上限约束应用文本帧写入时的发送缓冲。
- 客户端首次自动重连仍等 `delayMs`。后续连续失败的目标等待时间每次翻倍，
  上限 `maxDelayMs` 缺省 30 秒，并至少容纳一次 `delayMs`；从第二次尝试起，
  在目标值的 `1 - jitterRatio` 到 `1` 倍之间均匀取样，缺省抖动比例为 0.2，0 可关闭。
  `maxAttempts` 仍限制连续自动重连次数，成功后重置。显式 `close()` 取消待重连与
  正在连接的 socket；调用方可再次显式 `open()`，并重新开始计数。

## 构建与导出形态

- tsdown 从 `src/index.ts` 构建 `dist/index.mjs`。包级 `tsconfig.json` 开启
  `isolatedDeclarations`，tsdown 使用 Oxc 生成 `dist/index.d.mts`。
- `exports` 的 `types` 和 `default` 分别指向声明和 ESM 入口。CJS 消费方通过
  Node ≥ 22.12 的 `require(esm)` 加载同一个 ESM 入口。
- `hono`、`@hono/node-server` 和 `ws` 通过 `dependencies` 安装，由 tsdown 保持 external。

## 测试布局

单元测试统一放包根 `tests/`（镜像 `src/` 子目录结构，避免与源码同层平铺），
由根 `vitest.config.ts` 的 `packages/*/tests/**/*.test.ts` 发现，相对导入
保留 NodeNext 的 `.js` 后缀（如 `../src/sse.js`）。

| 测试 | 覆盖 |
| :--- | :--- |
| `tests/sse.test.ts` | SSE 帧格式（`event:` / `data:` / 空行）、事件名缺省、断开退订、`close` 后 `send` 静默——纯逻辑，无端口 |
| `tests/http-server-stream.test.ts` | 真实端口（`127.0.0.1`）集成：`onRawRequest` 短路返回 SSE 流、`onUpgrade` 同端口完成 WS 握手、常规 JSON 路由不受影响、鉴权仍先于 `onRawRequest` |
| `tests/http-server-lifecycle.test.ts` | 真实端口：活跃 SSE/WS/普通请求关闭、无响应关闭握手、半截请求体与未承接升级回收、断开后的迟到响应 |
