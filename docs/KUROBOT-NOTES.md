# KUROBOT-NOTES：kurobot 协议适配器任务实录（KuroBot MVP-3 napukettoqq 侧）

> 任务书：`docs/KUROBOT-PROMPT.md`（无人值守，2026-09-13 执行 / 09-14 收尾）。
> 决策编号 KB-01 起：做了什么、为什么、放弃了哪些替代方案。
> 镜像契约基线：KuroAdapter master commit `b0809ef`（协议 0.3.1）。

## 决策实录

### KB-01 协议 schema 本仓镜像，对表基线锚定 commit b0809ef

按任务书决策一执行：`packages/adapter/src/kurobot/schema.ts` 逐字段镜像
KuroAdapter `bridge/protocol`（meta / frame / messages/ws），文件头注明 SSOT
与基线。**执行中发现**：开题时 KuroAdapter master 停在 0.3.0（4c016ed），并行
会话于执行中途提交了 `b0809ef`（协议 0.3.0 → 0.3.1，hello 增可选 `client`）——
重新对表后按 0.3.1 落镜像（含 client 字段），golden 帧对表（schema.test.ts
14 例）锁的就是这个形状，测试内注明对表来源 commit。IPC 侧消息
（ready/broadcast/execute_command 等）不镜像——那是 KuroAdapter 内部
Java↔Node 通道，WS 对端永不接触。

### KB-02 连接层自建（复刻决策二），四个协议语义全部按约定实现

`connection.ts`（KurobotConnection）：子协议 `kurobot-ws.v1`、每次 open 立即
重发 hello（UUID 每轮独立）、established 后 15s 应用层 ping 帧、close 1002/1008
与 hello_ack ok:false → 永久停止（error 日志 + onEnded 回调）、其余关闭码指数
退避 1s→60s 封顶（established 成功清零 attempt）。退避基数/上限/hello 超时可
注入（单测用 20ms 快值）。**放弃的替代**：给 network.WsClient 加子协议/onOpen
参数——违反「network 协议无关」红线，且 close-code 感知退避本质是协议语义。

### KB-03 未知帧容忍：对端侧同样实现 ADR-026 策略

服务端会向我们发帧（未来新事件）。对齐服务端策略：未知**事件帧**（无 id）→
debug 忽略；未知**请求帧**（带 id）→ 回同 id `<type>_result` `{ok:false,
error:"unknown frame type"}`；type 以 `_result` 结尾 → 不回执（防乒乓循环）。
单测覆盖三分支。

### KB-04 实测发现：ws 库的 handleProtocols 触发条件（服务端行为校准）

任务书验收项 2 要求「不带子协议 → 被拒（真实复现服务端行为）」。实测发现
**ws 库只在客户端携带 `Sec-WebSocket-Protocol` 头时才调用 `handleProtocols`**：
裸连接（无该头）不会被 ws 服务端 abort（KuroAdapter NodeWsServer 的
`handleProtocols` 对裸连接同样不会触发，其「拒连」语义实际只拦「带了错误
子协议」的客户端）；带错误子协议时服务端返回 false → HTTP 401 → 客户端报
`Server sent no subprotocol`。单测按实测行为断言（错误子协议 → 拒绝）。本客户端
恒带正确子协议，不受影响；此事实已反馈给 peer-guide 语义（KuroAdapter 侧文档
由其任务书自行校准）。

### KB-05 出站过滤与命令分流的边界：command 不做绑定过滤

- chat 帧出站：`hello_ack.channelBindings` 快照 + `bindings_updated` 全量替换
  维护 `Set`；空集 = 全部不发（对齐服务端「空绑定丢弃」语义，省流量且语义一致）。
- command 帧**不做**绑定过滤：复核 KuroAdapter `server.ts` dispatchCommand——
  管理员判定按 `source.userId` 查 config.admins，不查绑定表。若本侧加过滤会
  制造服务端不存在的约束（如管理员在未绑定群发命令本应可达）。
- 自消息过滤用 `senderUin === 本账号 uin`（与 OB11 reportSelfMessage 缺省口径
  一致，防 QQ→MC→QQ 回环）。

### KB-06 command_result 回发目标：adapter 侧 UUID → channel 关联表

`command_result` 帧体**无 channel 字段**（协议设计如此），adapter 维护
`pendingCommands: Map<UUID, channel>`：发 command 时登记、收到同 id result 时
取出回发群并删除；连接重建（重新握手）时清表（旧请求作废）。query 同构
（`pendingQueries`，bindings 查询结果顺带刷新绑定集——防御性收窄 string[]）。

### KB-07 渲染细节三则（对齐任务书 §1.2）

- death 空消息：`{player} 死亡了`（模板 `{player} {message}` 中 message 以
  「死亡了」代入）；非空则原样。
- command_result：ok 无 output → 「（命令执行成功，无输出）」占位（协议允许
  ok:true 不带 output；静默无回显会让群员以为命令没执行）。
- 1500 截断按 UTF-16 码元（与 OB11 发送口径同族），追加 `…(截断)`；
  统一套用所有发群文本（任务书只对 command_result 规定，统一化是自拍板：
  渲染模板理论上也可超长）。

### KB-08 装配分支：kurobot 段非空才装配（与 ob11/satori 的差异）

ob11/satori 段可为空对象（schema 全缺省）；kurobot 的 `url` 必填，空段
`parse({})` 会炸。因此 loader 装配分支加了 `Object.keys(kurobotSection).length > 0`
门（「段存在即启用、不写不启用」语义不变：写了段必然有 url，否则 zod 报错
装配失败——引导判失败的既有语义）。另提供 `kurobotConfigDefaults()`
（url 兜底 `ws://127.0.0.1:0`）满足 ConfigBase 必填 defaults 形参；seed 模式下
defaults 不参与生效值。

### KB-09 阶段 4 冒烟形态：vitest 脚本（scripts/kurobot-smoke.test.ts）

真装配链冒烟无法走完整 loader bootstrap（需 wrapper.node 登录），采用最近似
切面：真 TOML 文件 → **loader 真源码** `loadProtocolSections`（env 快照前设
NAPKETTO_CONFIG + `vi.resetModules()` 隔离模块缓存）→ **adapter 构建产物**
（dist/kurobot + dist/core，非 src）装配 → 假 kurobot-ws 服务端 → 双向帧断言
（hello/握手日志「kurobot: 握手成功」/chat/command+回执渲染/MC→QQ 模板）。
附带验证：删段 → 空段（装配分支条件不成立）；cli/脚手架模板含注释段；
`cli config list`（NAPKETTO_CONFIG 指临时 TOML）EXIT=0 不炸。
**放弃的替代**：完整 self-host bootstrap 冒烟——需要 QQ 扫码在场，属任务书
§7「用户协作终验」，不属无人值守验收。

### KB-10 hello 身份字段口径

`peerId` = 本账号 uin（稳定标识，服务端日志按 peerId 记断连）；`platform` =
`"qq"`；`version` = adapter 包版本（createRequire 读自身 package.json，取不到
fallback `unknown`）；`client` 缺省 `napukettoqq/<adapter 版本>`（对齐
KuroAdapter 建议 `名称/版本`）；`token` 非空才带（空串不带字段）。

## 债务清单（后续轮次）

1. **@kurobot/protocol 发版后切真依赖**：镜像 schema 与 golden 对表是过渡方案；
   发版后 import 真包、对表测试改为互验（或删除 golden 锁）。
2. **富文本上行**（MC → QQ 仅纯文本；QQ → MC 降级占位）：图片/语音双向、
   @ Mention 结构化留后续（协议本身也未定义富文本段）。
3. **status 面板**：目前仅缓存不发群（防刷屏）。未来可做命令式查询
   （`/status` 群命令 → adapter.query("status") → 渲染回群），query 能力已就绪
   （adapter.query() 公开方法 + pendingQueries 链路 + 单测）。
4. **wss/TLS 客户端配置**：`rejectUnauthorized` 等未透传（任务书明确不做，
   ws 库默认校验证书，自签 wss 地址暂不可用）。
5. **peer-guide 交叉校验**：KuroAdapter 侧 `docs/protocol/peer-guide.md`
   （其 MVP-3 阶段 4 产物）落地后，应人工对照本镜像 schema 复核一遍（当前以
   bridge/protocol 源码为准，无偏差风险，但双源记录在案）。
6. **用户协作终验**（任务书 §7，需 QQ 扫码在场）：KuroAdapter 沙盒固定端口 +
   token → napuketto.toml 配 [accounts.kurobot] → 真实群服互通闭环
   （群文字进游戏 / 游戏事件进群 / /whitelist list 回显 / 非管理员被拒 /
   错 token 拒连日志）。

## 提交清单

- 阶段 0+1：镜像 schema + 连接层 + 翻译 + 适配器主体 + design.md §8
- 阶段 2：假服务端全链路 + golden 帧对表 + 映射单测（46 用例）
- 阶段 3：装配接线 4 处（loader×2 / cli×2 / 脚手架模板）+ changeset
- 阶段 4：scripts/kurobot-smoke.test.ts（3 用例）+ 本 NOTES + STATUS 追加
