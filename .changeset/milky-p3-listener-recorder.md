---
"@napuketto/kernel": minor
"@napuketto/loader": patch
---

feat(kernel,loader): listener 录制器——Milky 批次三前置探测（milky.md §0.8）

批次三（5 个无源事件 + get_private_file_download_url）没有可盲装的方法名，
缺的是回调证据：现有 bridge 只注册已知回调名（Msg 7 / Group 9），原生 listener
回调面之外的派发行为从未被观测。本批交付录制器工具，不接任何协议行为。

kernel 新增 `startListenerRecording` / `createRecordingListener`
（wrapper/probe/probe-listener.ts）：Proxy get 陷阱构造万能监听器——任意字符串
属性访问返回记录函数（同时记录原生查过的名字），has / ownKeys 陷阱一并记录
（判定原生按名 Get 还是枚举发现回调），记录函数绝不反向调用原生。

- 仪器面：Msg / Group / RecentContact / BdhUpload / OnlineStatus / Lock /
  FileAssistant / Buddy / ProfileLike / NodeMisc 十服务 + LoginService 单例；
  add/remove 方法按 `/^add(Kernel)?\w*Listener$/` 自动选取（裸 addListener 同规则）。
- 产物 `NAPUTO_CFG_DIR/napuketto-listener-record.jsonl`：每回调一行
  `{ts, service, event, args}`（截断序列化），注册过程逐行落盘，原生崩溃保留断点。
- ⚠️ 时序硬约束：loader 在 runProbePhase 之前挂起——probe 的 getMainSession
  写回副作用会把空壳主 session 毒化进 ctx.session（late probe 61/63 getter
  null 的根因），录制器必须先取服务。
- 与业务 bridge 共存（addKernelXListener 多监听独立 id），单测 7 例。

用法：`NAPUTO_LISTENER_RECORD=1` 启动后按 milky.md §0.8.2 实机操作单
（发消息 / 表情回应 / 置顶 / 精华 / 收发文件）产生录制窗口，jsonl 交回分析，
据此接批次三 kernel 出口。
