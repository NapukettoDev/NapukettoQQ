---
"@napuketto/adapter": patch
---

refactor: Milky 动作域拆分 + 内部空壳 barrel 清理（结构重构会话 4/5）

- `milky/action/group.ts`（826 行）按子领域拆为 4 文件：group-query（群信息 /
  成员查询 / 公告列表读取）、group-manage（群管 + 头像 / 头衔 / 公告发布删除 /
  群戳一戳）、group-essence（精华 + 表态）、group-notice（通知列表 + 应答）；
  `message.ts`（624 行）拆为 message-send（发送链 + forward 组装链）、
  message-query（get_message / history / forwarded）、message-ops（recall / 已读 /
  资源反查 / upload_private_file）。全部落在 150~300 行，动作类实现原样搬运。
- `milky/action/index.ts` 注册表改为按新域文件导入，P0 → P1 → P2 批次二注册
  顺序与 64 个动作名不变。
- 测试按源码域重组：`milky/action/__tests__/` 10 个批次命名文件（p1-* / p2-* /
  p3-* / message.test）归并为 11 个域对齐文件（group-query / group-manage /
  group-essence / group-notice / group-file / message-send / message-query /
  message-ops / profile / social / registry），180 个用例标题全部保留（仅重复
  用例加"补测"后缀消歧），共享桩上移 `test-support.ts`（groupRegistry /
  messageApi / indexableMsg）。
- 清理 4 个单模块转发壳 `index.ts`：`onebot11/api`、`satori/api`、`satori/event`、
  `satori/helper/element`，改为直接引用目标模块；`package.json` exports 声明的
  6 个子路径入口与有实际聚合面的 barrel（协议根 / core / onebot11/types 等）
  保留。不改 milky 的 HTTP/SSE/WS 传输协议与 API 行为语义。

纯结构调整，无行为变化。
