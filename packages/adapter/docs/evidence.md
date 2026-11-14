# @napuketto/adapter 实测与样本

> 本文件存放协议适配器的实测样本、字段表与探针命令，仅供深水区排查，不是 API 契约。
> 样本按采集平台/版本标注；现行机制与边界见 [design.md](./design.md)。
> 只记符号名与字段语义，不记地址、二进制定位信息或任何逆向地址表。

## 探针与复现命令

### sysmsg 原始字节

`Msg/onRecvSysMsg` 参数是带符号字节数组的数组（djinni int8 透传），JSON 形如
`[[10,64,…]]`：外层 = 一次回调可携多条，内层 = 单条 sysmsg 的 protobuf 字节。debug 级校准日志输出
结构化摘要（msgType/subType/群标识对/时间戳/actor/树内字符串/raw hex 前 1024 字符）：

```toml
[log.levels]
ob11 = "debug"   # milky 的校准日志同源，按模块名替换
```

拿到 hex 后直接解码（当时 `@napuketto/adapter/core` 公共导出共享解码器；该解码器现已
收进包内 `src/shared/sysmsg.ts` 不再对外导出，复现时改从仓库源码路径引入）：

```js
// probe-sysmsg.mjs：参数为逐字节十进制，直接贴日志 hex 的字节序列
import { decodeProtoTree, extractSysMsgEnvelope } from "@napuketto/adapter/core";

const blob = Uint8Array.from(process.argv.slice(2).map(Number));
const tree = decodeProtoTree(blob);
if (tree === null) throw new Error("wire-format 解码失败");
console.log(JSON.stringify(extractSysMsgEnvelope(tree), (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2));
```

```bash
# 逐字节十进制贴入解码脚本；符号分类学只读字符串表（不取地址）
node probe-sysmsg.mjs 10 64 18 0 1 ...
strings -a <wrapper.node> | grep -E "OnSysMsg|OnRecvSysMsg|Dispatcher sys msg"
```

### 协议对照与连接

双协议隔离对照：同一账号同时开 OB11 WS 与 Satori WS，各自订阅后比对信封字段
（OB11 有 `post_type`、Satori 有 `op`；互不出现即 crosstalk=0）：

```bash
websocat ws://127.0.0.1:3001             # OB11 反向 WS，端口按配置
websocat ws://127.0.0.1:3002/v1/events   # Satori 事件 WS，端口按配置
```

```bash
pnpm vitest run packages/adapter/src/kurobot/__tests__/schema.test.ts
pnpm vitest run packages/adapter/src/kurobot/__tests__/connection.test.ts
pnpm vitest run packages/adapter/src/milky/__tests__/transport.test.ts
```

KuroBot 连接用例用 `ws` 起真端口假服务端，复刻 `handleProtocols` 子协议校验；重连用例
注入快值（`retryBaseDelayMs=20ms`），生产缺省 1s 起、60s 封顶。

Milky 服务方法面探测：`NAPUTO_PROBE=1` 拉起 CLI 后读 probe JSON（names-only）确认运行时
`get*Service` 的方法名。实测登录后 session 注册表 getter 恒 null，运行中重新取服务拿不到
实例；装配期一次性持有引用的服务不受影响。

## 字段样本与边界表现

### 消息段、CQ 码与富媒体

CQ 转义（纯文本 `&` `[` `]`；参数额外 `,`）：`a&b[c]d` → `a&amp;b&#91;c&#93;d`，
`a,b` → `a&#44;b`；`&amp;` 最后解，避免二次转义。样本：`[CQ:at,qq=u1,name=小明]`、
`[CQ:text,text=a&#44;b]`、`[CQ:image,file=/a.png]`（undefined 参数自动省略）。

解析边界：无闭合 `]` 时剩余整体按文本；嵌套 `[CQ:` 由外层吞到第一个 `]`；未知 CQ 类型
保留原文为 text 段；未知 segment 兜底按 xml 处理。

canonical ↔ OB11 segment 对照（`onebot11/helper/codec/segment.ts`）：

| canonical | OB11 segment data |
|---|---|
| text | `{text}` |
| at | `{qq, name?}` |
| image / voice / video | `{file: path, url?}`；voice → `record` |
| face | `{id}` |
| file | `{file: name ?? path}` |
| reply | `{id: messageId}` |
| forward | `{id: messageIds[0] ?? ""}` |
| json / xml | `{data: raw 字符串或 JSON 序列化}` |

接收方向 ID 转换在协议边界批量完成：at `uid → uin`、reply `NT msgId → OB11 message_id`；
未命中保持原值，不阻塞事件。发送方向反向（uin→uid、OB11 id→NT msgId）。

合并转发：canonical 不承载 MULTI_FORWARD。Milky 从 `multiForwardMsgElement` 取
`resId` 作 `forward_id`，并登记 `resId → {chatType, peerUid, msgId}` 供
`get_forwarded_messages` 反查；OB11 发送段只取 `messageIds[0]`。

小程序：canonical `json` 在 Milky 收向映射为 `light_app`，`app_name` 取 JSON 顶层 `app`
（缺失/非字符串 → 空串），`json_payload` 原样透传：

```json
{ "app": "com.tencent.miniapp_01", "prompt": "[QQ小程序]示例",
  "meta": { "detail_1": { "title": "示例小程序" } } }
```

富媒体入站（Linux 原生宿主，3.2.x 原生对象）：

```json
{ "fileName": "764F...A3A7.png", "fileSize": "438107", "picWidth": 1637,
  "picHeight": 1125, "md5HexStr": "764f...a3a7", "fileUuid": "...", "thumbPath": {},
  "sourcePath": "/tmp/ntqq2/.../nt_data/Pic/.../Ori/764f...a3a7.png",
  "originImageUrl": "/download?appid=1407&fileid=...&spec=0" }
```

没有 `picPath` / `picUrl`；原图已落盘在 `sourcePath`，`originImageUrl` 是无 host 的相对
路径不能当 URL。路径取值顺序 `picPath → picUrl → sourcePath`，空串视同缺失。

### Msg/onRecvSysMsg 字节布局

样本清单：观测窗内该回调实触两条，均 151 字节、同一类型（msgType=528 / subType=382），
都不是 card/title/sign。fixture 入库前脱敏（等长字节替换 uin/uid/群号/base64 尾部；结构
字节与 varint 边界保留）。

符号侧：字符串表有 56 个 `OnSysMsg*` 处理器；card/title 相关为
`OnSysMsgModifyGroupMemberInfo`、`OnSysMsgModifyGroupMemberSpecialTitle`、
`OnSysMsgGroupLevelTitleChange`；**无 sign 处理器**，`group_sign` 疑似不走 sysmsg。
原生分发键 = `(msg_type, sub_type)`，日志形如
`OnRecvSysMsg msg_type=… sub_type=… is_online=…`、`Dispatcher sys msg cmd=… size=…`。

顶层字段（两样本一致，字段号依据 = 样本观察）：

| 路径 | 线型 | 观测内容 | 置信度 |
|---|---|---|---|
| f1 | msg | `{f1 uin, f2 uid, f5 uin, f6 uid}` 行为人对 | 高 |
| f2.f1 | varint | 528（msgType） | 高 |
| f2.f2 / f2.f3 | varint | 382 / 382（subType 双记） | 高 |
| f2.f4 / f2.f5 | varint | 群标识对，观测恒相邻整数 | 低 |
| f2.f6 | varint | 事件秒级时间戳，与采集时刻吻合 | 高 |
| f2.f12 | varint | `2^57 \| f4`，群标识重记 | 低 |
| f2.f32 | varint | 64 位随机值，疑 msgRand | 低 |
| f3 | msg | f1 空 bytes；f2 base64 串 28 字符 | 低 |

原始解码结果（两样本同构，均单元素；`u_` 为 uid 前缀）：

```text
f1: {f1: uin, f2: "u_...", f5: uin, f6: "u_..."}
f2: {f1: 528, f2: 382, f3: 382, f4: <int>, f5: <int+1>, f6: <unix 秒>}
f3: {f1: 空 bytes, f2: 28 字符 base64 串}
```

解码器上限：深度 16、每层 256 字段、单 varint ≤10 字节；wire 0/2 支持，wire 1/5 跳过，wire 3/4、截断、field 0 → 整块失败。

识别路径样本（各协议识别表）：

| 键 | 规则 | 字段路径 |
|---|---|---|
| OB11 732:21 | group_card | strings = [群号, 对象 uid, 新值, 旧值] |
| Milky 732:16 | group_message_reaction | f1.f1 群号；f3.f2.f44.f1.f1 明细 |
| Milky 732:1 | group_essence_message_change | f1.f1 群号；f1.f8.f8.f1 msgSeq |

732:16 明细：`f2.f1` = msgSeq，`f3` = face 块（`f1` faceId 数字字符串，`f5` 1=添加 /
2=撤销，`f3=1` 仅添加时存在）；operator 占位为 bot 自身 uid，故 user_id 省略。
732:21 判别式：strings[0] 全数字 + strings[1] 以 `u_` 开头，不满足即弃。

已观测未命名（不广播）：`528:349`、`528:381`、`528:382`（多端设备同步族）。
校准日志字段：verdict / msgType / subType / groupCodes / time / actor / strings / raw hex。

### Linux 原生宿主入站实测

元素变体 `null` 形状（Windows 省略未命中字段，Linux 3.2.x 全部显式置 `null`）：

```json
{ "elementType": 1, "textElement": { "content": "..." },
  "grayTipElement": null, "fileElement": null, "picElement": null }
```

用 `!== undefined` 嗅探会把普通消息判成 grayTip（Satori 读 `null.subElementType` 抛
`TypeError` 被逐订阅者吞掉，整条事件不广播）；统一 `!= null`。

时间单位：Windows 毫秒（13 位）、Linux 3.2.x 秒（10 位），协议层统一经 `toUnixSeconds`
（`>= 1e12` 为毫秒），否则 Linux 事件时间退化成 1970。

昵称：Linux `sendNickName` 是空串，回退 `sendNickName → sendMemberName → ""`。

OB11 入站事件节选（群 521584745，自然群流量）：

```json
{ "time": 1794307580, "self_id": 1569227406, "post_type": "message",
  "message_id": 1, "message_type": "group", "group_id": 521584745,
  "user_id": 1454273424, "message": [{ "type": "text", "data": { "text": "示例" } }],
  "sender": { "user_id": 1454273424, "role": "member", "card": "..." } }
```

Satori 入站事件节选（同一时刻的 `message-created`；两侧信封字段互不出现，crosstalk=0）：

```json
{ "op": 0, "body": { "sn": 2, "type": "message-created", "timestamp": 1794308396,
  "channel": { "id": "1101729931", "type": 0, "name": "..." },
  "message": { "id": "...", "content": "<text>示例文本</text>" } } }
```

### KuroBot golden 帧样本

线格式 = 单行 JSON `{header:{type,id?},body}`；事件帧无 id，请求/响应帧 id 必填。
以下为 schema golden 对表用例的最小形状（对表基线 `kurobridge-ws.v1` / 协议版本 0.4.0）：

```text
{"header":{"type":"hello","id":"<id>"},"body":{"peerId":"10001","platform":"qq","protocolVersion":"0.4.0"}}
{"header":{"type":"hello_ack","id":"<id>"},"body":{"ok":true,"channelBindings":["808"]}}
{"header":{"type":"hello_ack","id":"<id>"},"body":{"ok":false,"reason":"auth failed"}}
{"header":{"type":"chat"},"body":{"channel":"808","sender":"小明","content":"你好世界"}}
{"header":{"type":"command","id":"<id>"},"body":{"command":"list","source":{"channel":"808","userId":"20002"}}}
{"header":{"type":"death"},"body":{"channel":"808","player":"Alex","message":""}}
{"header":{"type":"command_result","id":"<id>"},"body":{"ok":true,"output":["added","done"]}}
```

| 场景 | 连接实测与容错行为 |
|---|---|
| 握手 | open 即发 hello，10s 内等同 id hello_ack |
| 心跳 | established 后每 15s 发应用层 ping（服务端 30s 空闲阈值） |
| 重连 | 非 1002/1008 关闭 → 指数退避 1s/2s/…/60s |
| 永久停止 | close 1002（版本）/ 1008（token）/ hello_ack ok:false |
| 未知事件帧 | 忽略 |
| 未知请求帧 | 回 `<type>_result` `{ok:false,error:"unknown frame type"}` |
| 未知 `_result` 帧 | 不回执（防乒乓） |
| 未 established 发送 | 直接丢弃 + debug 日志，不排队 |

### Milky 实机校准样本
```json
{ "time": 1794308396, "self_id": 1569227406, "event_type": "message_receive",
  "data": { "message_scene": "group", "peer_id": 808, "message_seq": 12,
  "sender_id": 20002, "segments": [{ "type": "text", "data": { "text": "hi" } }] } }
```

sysmsg 识别表：`732:16` 表情回应、`732:1` 精华设置快路径；取消精华无独立 sysmsg，
走 `Group/onGroupEssenceListChange` 列表 diff。表情回应 `f5=1/2` 双判据，`f3=1` 仅添加。

seq 索引：接收链路双向登记 seq ↔ msgId（FIFO 4096）；反查未命中扫近段历史 60 条；转发索引 `resId → 位置`。

合并转发发送（临时消息法）：逐条 `sendMessage` 取 NT msgId → `sendForwardMessage`
组装 MULTI_FORWARD → `recallMessage` 清理临时消息。已知差异：

- 节点发送者恒为机器人自己（`buildMultiForwardMsg` 基于真实消息，载荷 user_id /
  sender_name / time 仅过 schema）。
- title / preview / summary / prompt 忽略（无对应入参）。
- 临时消息在发送→撤回窗口内对会话可见，撤回顾产生 `message_recall` 噪音。
- forward 段必须单独发、单次一个；空 messages / 段全不可用 / 嵌套 forward → 参数错误。

群文件下载链接只覆盖根目录；`get_resource_temp_url` 的 resource_id 即临时链接；私聊下载链接
延后（rkey/TriSHA1）；私聊文件与精华分别按 msgId / `群:seq:方向` 去重（10 / 5 分钟）。

文件投递实测：`sendMsg` 带 fileElement 被服务端拒（`170019002`，逐维扫参无效），
`fileUuid` 拿不到；闪传通道（上传文件集 + 发卡片）是唯一可用投递方式，卡片指向
`qfile.qq.com`，`file_id` = 文件集 id，与群文件列表无关。
