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
收进包内 `src/internal/qq/sysmsg.ts` 不再对外导出，复现时改从仓库源码路径引入）：

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

Milky 服务方法面探测：`NAPUKETTO_PROBE=1` 拉起 CLI 后读 probe JSON（names-only）确认运行时
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

## H-04：媒体缓存生命周期回归证据

- 起始工作区干净，从 `origin/main` 的 `893bbdd` 建独立分支；复核近期 #153 / #157 / #160，
  下载器和转码产物修复没有覆盖本问题。交卷前复核 main 的 `3d8158d` 只增加版本发布记录，
  相关生产源码没有新的修复，未发现重复的 H-04 PR。
- 将 Milky `media-uri`、Satori `asset` 和内部 `qq/media` 三个生产 helper 临时恢复为 main
  实现，新增行为回归得到 5 个失败：PNG 后缀缺点号、Milky 成功/失败发送后遗留文件、
  Satori 相同 basename 覆盖、语音转换覆盖同名用户 SILK；恢复修复后通过。
- `internal/infra/__tests__/media-cache.test.ts` 使用真实文件系统、可控时钟及目录 junction：
  覆盖引用缓存到期、完成时间持久化及重启、受保护引用占满容量时拒绝新增、过期空间复用、
  下载和发送跨 TTL、并发引用计数、活进程磁盘租约、部分下载/转换与后续失败清理、重启
  遗留 `.part` 和受控视频输出、UUID 碰撞、未知文件/标记保留、目录链接和非法扩展名边界、
  启停并发及关闭释放定时器。
- 协议回归覆盖 Milky base64 PNG / `.bin` 降级、成功及失败发送后的清理；Satori 同名 URL
  隔离、下载/发送失败清理、URL 文件标题与显式 title；OB11 头像在消费期间可读而发送后
  删除，`download_file` / `get_image` 返回路径在动作后保留。真实 SILK 编码验证用户同名
  文件不被覆盖；大于 32MiB 的本地输入在复制之前拒绝。三协议关闭入口观察真实 Node
  interval，确认 `unref` 及 `clearInterval`（含 OB11 IPC 退订）。
- 本机 Windows：adapter 单包 build、`pnpm fix`、最终 `pnpm check` 和
  `pnpm test:quiet` 通过：234 files / 3494 passed / 13 skipped。初次全量测试暴露的旧
  Satori API 桩缺少缓存实例、Milky 下载桩不写文件已同步更新；生产校验未为桩放宽。
- 边界：未运行 QQ 原生发送端到端、多进程竞争压力或同权限恶意进程替换目录的竞态测试。
  512MiB 是每个受控根的媒体文件容量，写入/转换瞬时占用及元数据开销不属于磁盘硬配额。
  旧平铺文件与未知/损坏所有权内容保守保留；显式 `clean_cache` 的既有 kernel 管理回调、
  用户删文件和系统临时目录清理可使缓存路径提前失效。自动回收只管理可证明所有权的文件。

## 任务 06 协议媒体出站

### 审计项与代码证据

出站地址控制属于 P1 纵深隔离，前提是调用方已经能分发相应的下载动作。
该判定沿用审计基线中的可达性条件，以现有连接和动作实现复核。

| 编号 | 当前代码与验收 |
| --- | --- |
| F-02 | 逐跳校验、映射 IPv6 归一化及实际连接 DNS 绑定分别由 [#153](https://github.com/NapukettoDev/Napuketto/pull/153)（`691fea6`）、[#157](https://github.com/NapukettoDev/Napuketto/pull/157)（`5ff7ae3`、media 0.2.1）、[#171](https://github.com/NapukettoDev/Napuketto/pull/171)（`4340a0f`、media 0.2.3）引入。本次让协议下载实际采用公网入口。替身 DNS 验证逐跳候选，回环监听验证策略拒绝时端点未收到请求。 |
| F-10 | [共享下载循环](../../media/src/downloader.ts) 按 URL 源应用逐跳请求头策略。首跳和同源保留允许的头，跨源丢弃调用者全部头，返回初始源时也不恢复。HTTP 和 HTTPS 桩覆盖跨端口、Cookie、Authorization、Origin、Referer、自定义 API 头、Host 和 identity 编码。 |
| F-11 | [MIME 白名单和扩展名回退](../../media/src/downloader.ts)、[公网响应头适配](../../media/src/public-download.ts) 覆盖带参数、大小写、畸形和未知 MIME，及混合大小写的 Location 和 Content-Length 读取。 |
| H-02 远程侧 | [公网和兼容下载器](../../media/src/downloader.ts) 共享 15 秒缺省全程超时、30 MiB 缺省最终响应上限和 5 次跳转上限。定向测试覆盖 DNS/传输超时、声明与实际大小、非 2xx、跳转上限、响应关闭和临时产物回收。Satori 转码收到本地下载文件。媒体子进程限制沿用 [#160](https://github.com/NapukettoDev/Napuketto/pull/160)（`37087d5`、media 0.2.2）。 |
| I-01 A | [IPC 动作桥](../../loader/src/host/ipc/ipc-ob11.ts) 使用实际登录账号的 `onebot11.media`，由动态加载的 adapter schema 校验。真实 adapter 注入和回环 HTTP 桩验证缺省拒绝、显式 `compat` 成功。测试同时覆盖旧 adapter 降级和非法模式报配置错误。 |

### 生产动作验收

| 入口 | 适用范围及剩余业务边界 |
| --- | --- |
| OB11 HTTP、入站 WS、反向 WS、IPC | 同一动作注册表覆盖 [`download_file`](../src/onebot11/action/system/file.ts)、[`set_qq_avatar` URL](../src/onebot11/action/system/account.ts) 和 [`get_image` 缓存回源](../src/onebot11/action/message/media.ts)。`get_image` 拒绝下载时仍可返回原 URL，由客户端决定如何处理。`get_record` 原生富媒体、消息发送的本地路径及本地文件闪传走各自业务路径。 |
| Satori HTTP RPC | [`message.create` 的 `img/audio/video/file`](../src/satori/helper/element/media-convert.ts) 经统一资源解析执行出站策略。`internal:` 和裸路径由资源授权处理，事件 WS 仅传事件。 |
| Milky HTTP 动作 | [`send_private_message`、`send_group_message` 及合并转发子段](../src/milky/action/message-send.ts) 的图片、语音、视频，[个人头像](../src/milky/action/profile.ts)、[群头像及群公告图](../src/milky/action/group-manage.ts)、[群文件](../src/milky/action/group-file.ts)、[私聊文件](../src/milky/action/message-ops.ts) 所用 HTTP(S) URI 均执行策略。file URI、裸路径、base64 和 QQ 临时资源链接按各动作语义处理。 |
| KuroBot 和其他宿主连接 | [KuroBot 入向消息只向 QQ 发送文本](../src/kurobot/inbound/server-frames.ts)。Webhook、协议连接、QQ 安装包下载和 kernel 原生富媒体由各自的目的地与授权规则处理。 |

### 兼容性、依赖与剩余验证

- 以 `origin/main` 的 `bbcfd61` 为基线。`downloadPublicUrl` 用于公网下载，`downloadUrl`
  用于 LAN 兼容下载。账号协议默认 `public-only`。受信任 LAN 调用方在相应
  `[accounts.onebot11.media]`、`[accounts.satori.media]` 或 `[accounts.milky.media]`
  设置 `outboundPolicy = "compat"`。内联配置层级相同。IPC 注入的 adapter 必须保留该字段。
- 07 的本地媒体配置可扩展 adapter 的 `protocolMediaSchema`，使用同一个账号协议媒体段。
  06 提供两种出站模式，可信 LAN 通过整个协议段显式切换。目标级 `outboundAllow` 是原审计
  提案中的独立访问控制能力。
- 09 更新依赖时，已发布的 `downloadPublicUrl` 最低是 media 0.2.3。本次出站行为和 IPC
  装配需等待 media 0.3.0、adapter 0.20.0、loader 0.12.0。CLI 模板预计随 0.7.0
  发布。版本按本次 changeset 和当前 main 推算，下游以正式 npm 版本及冻结锁文件为准。
- 本次使用合成媒体、临时缓存、回环服务和 QQ API 桩。真实 QQ 上传、发送、播放及私有部署的
  代理与路由策略，需要测试账号和部署授权才能验证。

### 本机验证

- Windows / Node 24.16.0 / pnpm 12.4.1，冻结锁文件安装通过。media、adapter、loader
  及 CLI 各自构建通过。
- `pnpm test:quiet packages/media packages/adapter packages/loader apps/cli` 通过，
  164 个文件，2466 项通过，11 项跳过。内联配置的 `config validate` 对 `compat`
  返回 0，对非法值返回 78。
- `pnpm check && pnpm test:quiet` 通过，239 个文件，3616 项通过，14 项跳过。
  `pnpm exec fallow audit --base origin/main` 退出 0，报告的存量项及复杂度增长为警告。

## 任务 07 本地媒体隔离与资源引用

| 审计项 | 源码与验收证据 |
| --- | --- |
| F-01 | [本地媒体授权](../src/internal/infra/local-media.ts) 在协议动作侧解析配置、真实路径和已打开的普通文件。[授权测试](../src/internal/infra/__tests__/local-media.test.ts) 覆盖缺省拒绝、授权裸路径和文件 URI、相邻目录、歧义、junction／符号链接与硬链接。以已获动作调用权限的调用方为边界，涉及 QQ 接收／实际上传的影响未在真实账号复现。 |
| H-02 本地侧 | [OB11 发送](../src/onebot11/action/message/send.ts)、[Milky URI](../src/milky/helper/message/media-uri.ts) 和 [Satori 资源](../src/satori/helper/element/asset.ts) 先取得私有副本再进入处理链。普通文件夹具在打开时替换源路径，验证拒绝交付；另在交付后替换源路径并模拟原生重新打开，读取的仍是核验过的副本。Linux 用打开句柄对应的 `/proc/self/fd` 路径，Windows 核对前后的实际路径和卷／文件标识，并依赖配置目录的受信任 ACL。FFmpeg 协议与容器限制沿用 [#160](https://github.com/NapukettoDev/Napuketto/pull/160)，合并提交 `37087d5`，media 0.2.2。 |
| M-09 | [缓存所有权和租约](../src/internal/infra/media-cache.ts) 隔离账号及协议，引用校验所有权标记、文件名和 TTL。模拟发送失败与并发消费者，验证只移除该请求产物；[缓存测试](../src/internal/infra/__tests__/media-cache.test.ts) 覆盖到期、回收与消费者互斥和崩溃遗留的副本／输出清理。 |
| L-03 | [OB11 媒体查询](../src/onebot11/action/message/media.ts) 在当前账号的 QQ 媒体根内查找并导出；语音未落盘只返回元数据。[Satori 消息测试](../src/satori/action/__tests__/message.test.ts) 验证 `message.get` 的 QQ 本地引用可由 `message.create` 复用，[解析测试](../src/satori/helper/element/__tests__/asset.test.ts) 覆盖错误账户／平台、目录结构和过期引用。 |
| I-01 A 本地侧 | [IPC 动作桥](../../loader/src/host/ipc/ipc-ob11.ts) 以动态加载的 OB11 schema 校验实际登录账号的媒体配置。[IPC 测试](../../loader/src/host/ipc/__tests__/ipc-ob11.test.ts) 用真实 adapter 与文件消费桩验证缺省拒绝、相对导出目录授权、跨账号拒绝，并拒绝旧版丢弃字段的 schema。 |

任务 06 的先决条件已由 [#178](https://github.com/NapukettoDev/Napuketto/pull/178)
合入（`5966a5e`），其发布提交为 `ad0e2a7`，经 npm registry 验证版本为 adapter 0.20.0、
loader 0.12.0、media 0.3.0。任务 07 需要等待本 PR 合并和发布，随后下游同时升级 adapter 和
loader，再消费公开的 `ProtocolMediaConfig` 与 `media.localMediaRoots`。任务 09 继续等待
06 和 07 的发布版本。配置及迁移见 [配置指南](../../../docs/guides/configuration.md#本地媒体与缓存引用)。

| 环境 | 命令与结果 |
| --- | --- |
| Windows，Node 24.16.0 / pnpm 12.4.1 | adapter、loader、CLI 单包构建通过。定向 `pnpm test:quiet packages/adapter packages/loader/src/host/ipc/__tests__/ipc-ob11.test.ts apps/cli/src/config` 通过 1,529，跳过 2；最终 `pnpm check && pnpm test:quiet` 通过 3,618，跳过 14。 |
| Linux（WSL），Node 24.16.0 / pnpm 12.4.1 | 冻结锁文件安装与受影响包构建通过。同一组定向测试通过 1,531；最终 `pnpm check && pnpm test:quiet` 通过 3,628，跳过 5。 |

以上使用临时目录、普通文件、测试账号标识和原生 API 桩。仍需专用 QQ 测试账号与 Windows／Linux
自建宿主环境，补测原生头像、闪传和消息媒体消费，以及 QQ 实际数据目录与回调时机。未修改 QQ 安装目录。

## 任务 10 群请求、消息身份与事件

以 main `89392c1` 为基线。沿用 [#128](https://github.com/NapukettoDev/Napuketto/pull/128)
的历史好友申请过滤、[#168](https://github.com/NapukettoDev/Napuketto/pull/168) 的 IPC ready
门，以及 [#174](https://github.com/NapukettoDev/Napuketto/pull/174) 的原生消息 ID 业务动作。
编号按任务 10 的实施范围追踪。

| 编号 | 当前验证及改动 |
| --- | --- |
| H-08 | [kernel 群请求](../../kernel/src/apis/group-notify.ts) 将序号、群号、类型和队列作为审批引用。[OB11 动作](../src/onebot11/action/group/notify.ts)、[Milky 动作](../src/milky/action/group-notice.ts) 和 [Satori 动作](../src/satori/action/guild.ts) 以命中的队列实际审批。测试覆盖两队列内的邀请和申请、旧 seq 重名、无匹配及原生报错。 |
| H-09 | [Canonical 转换](../../kernel/src/native/message-codec.ts) 区分引用的 UID、UIN 与原生消息 ID。缺目标的提及保留为文本。Satori 私聊消息将会话对端与发送者分别投影。 |
| H-10 | [Satori 分页](../src/satori/action/message.ts) 排除锚点并独立处理页内顺序与续页方向，确认还有历史才发令牌。相同数据以 asc/desc、包含/排除锚点的原生桩连续翻三页。 |
| M-10 上游 | [IPC 公开接口与邀请样例](../../loader/docs/design.md#ipc-群请求与好友身份) 供任务 11 使用。邀请当前登录账号、管理员待审的邀请和主动申请各有独立类型。审批回传账号及完整引用。 |
| M-11 上游 | [OB11 notice](../src/onebot11/helper/notice.ts) 区分消息作者与撤回操作者，仅在同会话原生 ID 已登记时关联 OB11 ID。灰条 ID 和 seq 以字符串保留。群临时消息保留子类型，临时会话 poke 可保留载荷中现有字段提供的来源群号。 |
| L-03 禁言 | [kernel 群管理](../../kernel/src/apis/group.ts) 采用非负整数秒，0 解除；[OB11](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#set_group_ban-群组单人禁言) 省略时为 1,800 秒，[Milky](https://milky.ntqqrev.org/api/group#set_group_member_mute-设置群成员禁言) 为非负 int32 秒，省略时解除。[Satori](https://satori.chat/zh-CN/resources/member.html) 使用毫秒，正时长转为至少 1 秒。接口数据类型的上限与 QQ 实际执行时长是两项独立约束。 |
| L-04 好友 | [好友列表](../../kernel/src/apis/friend.ts) 优先使用好友明细与其昵称、备注，缺失 UIN 才批量转换。部分转换未命中时保留 UID 和资料，UIN 为 null；整个查询失败时返回错误。[IPC schema](../../loader/src/host/ipc/ipc-types.ts) 和兼容迁移同步公开。 |

### Satori 分页影响

此前默认 asc 页的令牌来自页中最新消息，导致下一页重叠并可能原地重复。带锚点的
`after` 会读取更早消息。现在 `before` 始终使用最早的已交付 ID 续页，末页同时省略
`prev` 和 `next`，两种不支持的方向返回 HTTP 400。短页和重复行可能触发额外原生读取
以确认是否还有一条更早消息。每页上限由适配器设为 100。已持有旧令牌的客户端应从
`next: null` 重新开始遍历。方向和令牌对照 [Satori 消息](https://satori.chat/zh-CN/resources/message.html)
及 [双向分页](https://satori.chat/zh-CN/protocol/api.html)。

### 发布与真机验收

Windows（Node 24.16.0，pnpm 12.4.1）单包构建分别执行
`pnpm --filter @napuketto/kernel build`、`pnpm --filter @napuketto/adapter build` 和
`pnpm --filter @napuketto/loader build`。定向测试使用 `pnpm test:quiet` 分别覆盖
kernel 的 `src/apis` 与 `src/types`（374 通过）、adapter 的
`src/onebot11`、`src/satori`、`src/milky`（1,159 通过）以及 loader 的
`src/host/ipc`（133 通过）。`pnpm check && pnpm test:quiet` 全量验证通过
240 个文件、3,671 个测试，跳过 14 个。

任务 11 需要等待本 PR 合并与发布，再同时使用 kernel 0.18.0、adapter 0.22.0 和 loader
0.15.0 或包含本改动的后续版本。版本来自 `changeset status`。OB11 旧群审批可回传
序号，存在歧义时补齐事件所带队列、群号和类型。IPC 好友消费方先判断 UIN 是否为 null，
并继续用 UID 表达原生身份。撤回的 OB11 ID 为 0 时，调用方只能记录灰条字段。

任务 17 需要 Windows/Linux 支持版本、获准使用的 QQ 测试账号和独立群，对照以下样本：

- 普通／可疑队列分别触发三种未审通知，核对 `user1`、`user2`、查询直返与回调顺序、
  `operateSysNotify` 的返回对象及审批结果。
- 用管理员撤回另一成员的消息、好友撤回和机器人自撤回，配对原消息和灰条，验证 ID、
  seq、作者、操作者及临时会话来源。在拿到样本前，普通临时消息的来源字段按未知处理。
- 用足够历史验证 `getMsgs` 的实际顺序、锚点包含性、容量与方向。用 0、1 秒和 QQ 客户端
  允许的最大时长对照禁言事件与实际截止时间，并测试超出该时长时 QQ 的行为。
