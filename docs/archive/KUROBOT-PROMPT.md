# NapukettoQQ kurobot 协议适配器任务书（无人值守）——KuroBot MVP-3 napukettoqq 侧

> **归档说明（2026-09-20）**：本任务书已执行完毕（KuroBot MVP-3 napukettoqq 侧 2026-09-13~14 落地，09-16 随 KuroAdapter 改名对齐 0.4.0）；决策实录见 `docs/KUROBOT-NOTES.md`。

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何
> 对话历史无关。完成后本文件保留存档；决策与实录记 `docs/KUROBOT-NOTES.md`（随本册新建）。
>
> **背景**：姊妹项目 KuroBot（`C:\Dev\MC-Ecosystem\KuroAdapter`，MC 服务器 ↔ 社交平台群服
> 互通插件，自研 WS 协议 `kurobot-ws`，KuroBot 恒为 WS **服务端**）已定稿 MVP-3：napukettoqq
> **原生**成为 kurobot-ws 对端——在 `packages/adapter` 新增协议目录（复刻 satori 模式），
> 主动连入 KuroBot。KuroAdapter 侧任务书（`docs/MVP3-PROMPT.md`，external 端口配置 +
> 对端指南）与本册**并行执行**，两侧契约锚点在下方 §2 写死，互不等待。
>
> **范围由用户拍板（2026-09-13）**：napukettoqq 原生新增 kurobot 协议适配器；不绕道
> OB11/Satori；不引入对 KuroAdapter 仓库的构建期依赖。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\Bot-Dev\NapukettoQQ`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\MC-Ecosystem\KuroAdapter\` 下任何文件（跨仓**只读**允许——本册大量
  契约要从那边读）。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板并记入 `docs/KUROBOT-NOTES.md`
  （新建，决策编号 KB-01 起：做了什么、为什么、放弃了哪些替代方案）。只有不停止就无法
  继续的硬阻塞才允许结束任务，结束时在 NOTES 写清阻塞点。
- **Git**：`master` 上小步提交（简体中文说明，每阶段至少一个提交），不 push（当前
  ahead origin 1 个提交，保持不动）、不改写历史。
- **GPG 注意**：本仓开了 commit 签名（`commit.gpgsign=true`）。若 `git commit` 超过约
  2 分钟无输出，疑似 gpg-agent 口令缓存过期挂起——**禁止 `--no-gpg-sign`**；结束任务并在
  NOTES 写明已暂存变更清单，交由用户交互提交。
- **Changesets（AGENTS.md 强制）**：本册属用户可见功能新增——`.changeset/` 必须随改动写
  （adapter 为 minor，loader/cli 按实际改动 patch，简体中文说明）。**不执行 `pnpm release`**
  （npm 发版由用户决定），只写 changeset 不消费。
- 遵守本仓 `AGENTS.md` 全部红线（依赖方向 / kernel 唯一原生层 / network 协议无关 / 配置
  单一 TOML）；不动 onebot11 / satori 既有行为。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标与范围

现状：全仓无任何 kurobot 痕迹。目标：新增 `@napuketto/adapter` 的 **kurobot 协议适配器**——
账号 TOML 配了 `[accounts.kurobot]` 段即启用，作为 kurobot-ws **客户端**连入 KuroBot 服务端，
实现 QQ 群 ↔ MC 双向互通：

- QQ 群文字消息 → kurobot-ws `chat` 帧（进游戏广播）；
- 服务端 `chat`/`join`/`leave`/`death` 事件 → 渲染为文本发到对应群；
- 群消息带命令前缀 → `command` 帧（`command_result` 渲染回群）；
- 按需 `query`（status/bindings）；`bindings_updated`/`hello_ack.channelBindings` 驱动出站过滤。

### 1.1 必须守住的红线（违反即任务失败）

1. **零引入 NapCat 代码**（GPL-2.0-only，含类型定义）；kurobot 协议类型自研，SSOT 在
   KuroAdapter 的 `bridge/protocol`（只读参照），本仓镜像实现（见 §1.2 决策一）。
2. **依赖方向**：adapter 只依赖 kernel + network + media；不得让 network/kernel 反向认识
   kurobot。
3. **不改 network、不改 kernel**：kurobot 的连接层（子协议/握手/心跳）在 adapter 包内自建
   （§1.2 决策二），不给 `WsClient` 加参数、不改其行为。
4. 配置只进单一 TOML（`[accounts.kurobot]` 段，段存在即启用、不写不启用）；不引入独立
   配置文件。
5. 无理由的 `any` 禁止；类型安全对齐本仓 tsconfig（TS 7 原生编译器 + NodeNext）。

### 1.2 已拍板的关键决策（按此实现，若有更优方案须在 NOTES 论证后仍自行拍板）

- **决策一：协议 schema 本仓镜像**。在 `packages/adapter/src/kurobot/` 内自写 zod schema
  （帧格式 `{header:{type,id?}, body}` + 消息集），**逐字段对照**
  `C:\Dev\MC-Ecosystem\KuroAdapter\bridge\protocol\src\`（meta.ts / ws.ts / frame.ts）抄录，
  文件头注释注明「SSOT: KuroBot bridge/protocol，镜像基线 0.3.x（含 MVP-3 的 hello 可选
  `client` 字段）」。理由：`@kurobot/protocol` 未发 npm，跨仓构建期依赖不可行；onebot11
  先例即自研类型。** golden 帧对表测试锁漂移**（§3 阶段 2）——将来 `@kurobot/protocol`
  发版后可切换依赖（NOTES 记债务）。
- **决策二：连接层自建，不复用 `network.WsClient`**。`packages/adapter/src/kurobot/` 内实现
  连接器（直接用 `ws` 库，版本声明对齐 network 的 `ws` 依赖），理由（已核实现状）：
  ① `WsClient` 不支持 `Sec-WebSocket-Protocol` 子协议——kurobot-ws 服务端 `handleProtocols`
  不带子协议直接拒连，**必须带 `kurobot-ws.v1`**；
  ② `WsClient` 心跳是 WS 层 `ws.ping()`——kurobot-ws 服务端空闲检测只认**应用层入帧**，
  WS 层 ping 不会重置其 30s 计时器，必须发应用层 `ping` 帧；
  ③ 每次连接（含重连）成功后必须**立即重发 `hello`**——`WsClient` 无 onOpen 回调；
  ④ 退避需感知 close code（见下条）——`WsClient` 是固定延迟重连。
  这四项都是协议语义，塞进协议无关的 network 违反其定位；自建约百行，遵守「不改 network」。
- **心跳**：握手成功后每 15s 发应用层 `ping` 帧（服务端空闲阈值 30s、任何入帧重置，半窗
  安全）；收到 `pong` 不需要处理（收不到就等服务端 1001 关闭走重连）。
- **重连**：指数退避 1s/2s/4s/…上限 60s；close code 1002（版本不兼容）或 1008（token 错）
  → **停止重连**并 error 日志（等版本升级/配置修正），其余关闭码持续退避。
- **协议版本**：hello 发 `protocolVersion: "0.3.1"` + 可选 `client`（自报身份，缺省
  `napukettoqq`，能取到 adapter 包版本则 `napukettoqq/<版本>`）；`token` 取配置（非空才带）。
  服务端 0.3.0/0.3.1 均兼容（主版本相同即兼容）。
- **QQ → MC 映射**：仅处理群聊（`chatType === GROUP`）；`sender` = `sendMemberName ??
  sendNickName`；`channel` = `peerUid`（QQ 群号字符串）；`userId`（command source）=
  `senderUin`；**过滤自己发的消息**（`senderUin` === 本账号 uin）防回环；富文本降级——
  text 原文、@ → `@{display ?? uid}`（@全体 → `@全体成员`）、图片 → `[图片]`、表情 →
  `[表情]`、reply → `[回复]`、其余类型 → 忽略（对齐 OB11 收向「无法表达静默跳过」惯例）。
- **出站过滤**：以 `hello_ack.channelBindings` 快照 + `bindings_updated` 事件维护绑定集，
  非绑定群的消息**不发** chat 帧（debug 日志）；快照为空 = 全部不发（对齐服务端「空绑定
  丢弃」语义，省流量的同时语义一致）。
- **命令**：配置 `commandPrefix`（缺省 `"/"`）；群消息以prefix开头 → 去前缀作 `command` 帧
  （`source: {channel, userId}`），**不再**作为 chat 帧发送；空命令（只有前缀）忽略。
  `command_result`：ok → output 各行合并一条群消息（`\n` 连接），error → `命令失败：{error}`；
  总长上限 1500 字符截断加 `…(截断)`。管理员判定在服务端（SSOT 是 KuroBot config 的
  `admins`），本侧不做权限逻辑。
- **MC → QQ 渲染模板**（可配置，占位符 `{player}`/`{content}`/`{message}`，MVP 纯文本）：
  `chat` 缺省 `[{player}] {content}`；`join` 缺省 `{player} 加入了服务器`；`leave` 缺省
  `{player} 离开了服务器`；`death` 缺省 `{player} {message}`（`message` 为空串时
  `{player} 死亡了`）。`status` 事件仅缓存不发群（防刷屏；M-04 决策同构）。
- **发送**：经 kernel 群消息 API（peer = `{chatType: GROUP, peerUid: channel}`，纯文本
  CanonicalElement）；目标群不存在/发送失败 → error 日志不抛出（不影响连接）。
- **config 字段集**（zod schema，缺省值写明；seed 注入对齐其它协议段的 ConfigBase 模式）：
  `url`（必填，完整 ws:// URL）、`token`（缺省空）、`client`（缺省见上）、`commandPrefix`
  （缺省 `"/"`）、`pingIntervalMs`（缺省 15000）、四个渲染模板（缺省见上）。
- **装配接线**（对齐 satori 先例，共 4 处）：loader `assemble-protocols.ts` 装配分支；
  cli `config-parse.ts` 的 `ProtocolKey` 增 `"kurobot"`；cli `config-template.ts` 与
  create-napukettoqq 的 TOML 模板补注释段；`packages/adapter/package.json` 显式声明 `ws`
  依赖（对齐 network 版本）。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- 不改 `@napuketto/network` / `@napuketto/kernel`；不动 onebot11 / satori 行为与配置。
- 不做图片/语音/文件等富文本上行（MC → QQ 也只发纯文本）；不做 @ Mention 结构化。
- 不做 KuroBot 侧任何事（external 端口配置、对端指南、协议变更都属 KuroAdapter 册）。
- 不做 token 轮换、wss/TLS 客户端特殊配置（`rejectUnauthorized` 透传缺省即可）。
- 不补 OB11 的 role 判定 TODO（P2-3，与 kurobot 无关——管理员判定在 KuroBot 侧）。
- 不发 npm（不跑 `pnpm release`）；不做 koishi 相关任何事。

## 2. 动手前必读（顺序执行）

1. 本仓 `AGENTS.md` + `docs/STATUS.md` + `docs/architecture.md`
2. **契约 SSOT（跨仓只读）**：`C:\Dev\MC-Ecosystem\KuroAdapter\docs\MVP3-PROMPT.md` §1.2
   （范围与拍板）+ `bridge/protocol/src/meta.ts|ws.ts|ipc.ts|frame.ts` + `bridge/protocol/docs/design.md`
   的 MVP-1/DEBT-1 小节（帧语义与 id 规则；注意 death 字段是 `player`/`message` 而非
   playerName——照抄不「修正」）
3. `packages/adapter/docs/design.md` + `packages/adapter/src/core/`（base-protocol-adapter /
   config 的容器契约）
4. `packages/adapter/src/satori/` 全文（新协议适配器的模式参照：目录结构 / 生命周期 /
   事件翻译 / 动作注册 / 测试写法 `adapter-reload.test.ts`）
5. `packages/adapter/src/onebot11/transport.ts`（wsReverseUrls 对照——本册不这么做，理由见
   §1.2 决策二）+ `packages/kernel/src/types/`（RawMessage / CanonicalElement / 群 API）
6. `packages/loader/src/host/core/assemble-protocols.ts` + `apps/cli/src/config-parse.ts` +
   `apps/cli/src/config-template.ts`（3 处装配点现状）
7. `packages/network/src/ws-client.ts`（已核实不支持子协议——决策二依据，勿重查）
8. KuroAdapter 侧沙盒运行方式（联调用，只读）：其 `scripts/paper-start.sh` / `paper-stop.sh`

然后：环境基线验证——若 loader 的 native submodule 缺失先
`git submodule update --init --recursive`；`pnpm install`；`pnpm check` / `pnpm test` /
`pnpm -r build` 全绿。

按「设计先行」：动代码前先在 `packages/adapter/docs/design.md` 增「kurobot 协议适配器
（KuroBot MVP-3）」小节（连接层状态机 / 帧映射 / 配置段 / 装配点）。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  设计先行 + 基线验证（可并入阶段 1 提交）；连接层 spike 结论记 NOTES
阶段 1  packages/adapter/src/kurobot/：镜像 schema（0.3.x + client 可选）+
        KurobotConnection（子协议 / hello / 应用层 ping / 指数退避 + close code 感知）+
        KurobotProtocolAdapter（kernel 事件 → 帧、帧 → kernel API）+ kurobot 配置 schema
阶段 2  vitest：假 kurobot-ws 服务端（ws 库起真端口）驱动连接层全链路（握手 / token /
        心跳 / 重连 / 1002、1008 停止重连）；消息映射（合成 RawMessage：文本/@/图片/
        自消息过滤）；golden 帧对表（wire 格式逐字段锁 KuroAdapter schema）；渲染模板
阶段 3  装配接线 4 处（§1.2 末条）+ changeset（adapter minor）+ pnpm check/test/build 全绿
阶段 4  本地端到端冒烟（无 QQ）：阶段 2 的假服务端脚本化 + 真适配器装配链跑通
        （[accounts.kurobot] 配置生效 → 连入 → 双向帧）；KUROBOT-NOTES 收尾 +
        docs/STATUS.md 追加小结（只追加）
```

## 4. 验收清单（全部打勾 = 任务完成）

1. **门禁全绿**：`pnpm check` / `pnpm test`（用例数只增不减）/ `pnpm -r build`。
2. **连接层**：假服务端实测——带子协议握手成功；不带 → 被拒（真实复现服务端行为）；
   hello 0.3.1 + client + token 到位；15s 应用层 ping；断线后指数退避重连且重发 hello；
   1002/1008 → 停止重连 + error 日志。
3. **golden 帧对表**：双向各取 ≥3 种帧，与 KuroAdapter `bridge/protocol` 的 zod schema
   互相校验通过（测试内注释注明对表来源 commit）。
4. **QQ → MC**：合成群消息 → chat 帧（channel=群号、sender=群名片、降级占位正确、
   自消息过滤、非绑定群不发）。
5. **命令链**：`/whitelist list` 形态消息 → command 帧（source 正确）→ 假服务端回
   command_result → 渲染回群内容正确（含 error 分支与 1500 截断）。
6. **MC → QQ**：chat/join/leave/death（message 空串）→ 模板渲染 → 群发送 API 收到预期
   文本；status 不发群。
7. **装配链**：TOML 写 `[accounts.kurobot]` → 适配器实例化并尝试连入（日志可见）；删段 →
   不装配；cli `config list` 不炸；create-napukettoqq 模板含注释段。
8. **changeset** 存在且类型正确；**未执行** `pnpm release`。
9. **NOTES 收尾**：`docs/KUROBOT-NOTES.md`（KB-xx 决策 + 债务清单：@kurobot/protocol 发版
   后切依赖、富文本上行、status 面板等）+ `docs/STATUS.md` 追加小结。

## 5. subagent 使用策略

本册单包为主、模式参照明确（satori），预计**全部主做**。若确需派发，prompt 必须自包含
（含边界：只写本仓、biome 风格、镜像 schema 逐字段对表、完成后自跑 `pnpm check`、
**不要 git commit**）；返回后主智能体必须亲自复核（读文件、跑门禁），不采信口头完成。

## 6. 环境 / Windows 注意事项

- pnpm 12.4.1 由 `devEngines` 自动接管（onFail: download）；TypeScript 7 原生编译器，勿用
  旧 tsc 习惯（`pnpm check` 即 tsc --noEmit）。
- loader 的 `native/` 是私有 submodule——缺失时先 `git submodule update --init --recursive`；
  构建失败先确认 `pnpm -r build`（prepare 已挂）。
- 与 KuroAdapter 册并行时：**两仓各自一个会话**，不交叉写；联调（§7）前 KuroAdapter 侧
  只读使用（跑其沙盒脚本不算改仓）。
- GPG 条款见 §0；提交均不 push。

## 7. 与 KuroAdapter 侧的并行协议 + 用户协作联调清单

- **并行期**：KuroAdapter 侧 MVP-3（固定端口 + 指南）与本册互不等待。本册联调用
  KuroAdapter **当前 master** 沙盒即可：其 bootstrap 未设 `KUROBOT_STUB_PEER` 时就是
  纯 external 服务端（动态端口，端口从其 `[KuroBot][node]` 日志的 ready 行读取），
  协议 0.3.0 对本侧 0.3.1 hello 兼容（主版本规则）。此联调列为**手动步骤**，
  不阻塞无人值守验收（§4）。
- **用户协作终验（两侧都完成后，需 QQ 扫码在场）**：
  1. KuroAdapter 沙盒配置 `ws.port`（固定端口）+ token（其册产物）→ `paper-start.sh`；
  2. napuketto.toml 写 `[accounts.kurobot]`（url 指向固定端口 + 同 token）→ 扫码登录；
  3. 冒烟：QQ 群文字进游戏 / 游戏聊天进群 / join-leave-death 通知 / 群管理员
     `/whitelist list` 回显 / 非管理员被拒（forbidden）/ 错 token 拒连日志。

---

**一句话总结**：napukettoqq 以「新增协议适配器」的方式原生说 kurobot-ws（自建连接层、
镜像 schema、单 TOML 配置段），与 KuroAdapter 侧 MVP-3 并行开发，最终 QQ 扫码完成
真实群服互通闭环。
