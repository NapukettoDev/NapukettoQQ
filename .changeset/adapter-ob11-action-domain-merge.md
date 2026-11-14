---
"@napuketto/adapter": patch
---

refactor: OB11 动作微文件按领域合并（结构重构会话 3/5）

- `onebot11/action/` 62 个 20~110 行单动作微文件合并为领域文件（120~300 行）：
  message/ → send / history / ops / media / forward；group/ → manage / query /
  essence（含群荣誉）/ notify；friend/ → query + manage；system/ → info /
  status / account / file（download_file 与闪传 upload 合并入 file）。群系统
  消息与群文件操作/查询三文件已在此粒度，保持不动。
- 动作类与 `create*Actions(api)` 工厂同文件导出，`action/index.ts` 重写为
  遍历工厂注册（345→约 90 行），消除 12 个 `register*Actions` 手工样板；
  公共面 re-export（`ob11ErrorCodeMap` / `resolveUid` / `AtAllRemainInfo` /
  `Ob11ActionDeps` / `createOb11ActionRegistry`）不变。
- 全部 81 个动作的 `action.name`、zod schema、retcode 映射与返回字段不变；
  搬运保持实现原样（仅合并重复 import 与同义常量命名）。
- 域内 16 个测试文件同步导入路径；registry 测试的 81 动作名全集断言全程通过。

纯结构调整，无行为变化。
