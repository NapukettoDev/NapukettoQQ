---
"@napuketto/kernel": patch
---

fix(kernel): 探测改 names-only 并逐服务增量落盘（修复探测模式登录后原生崩溃）

跟进 #34 的实机复验：探测模式在活 session 上服务探测触发 0xC0000005 原生崩溃
（登录成功后宿主立即退出，supervisor 循环重启）。根因是 shape 探测
（shapeKeyGetters/tryShape）对服务实例无参调用 get/query/fetch/load 开头的方法
——活 session 的真实服务上无参调原生方法即访问违例，try/catch 捕不住；
旧世界（空壳主 session，getter 恒 null）下该路径从未真正执行过。

- 服务探测改 names-only：listMethods 枚举方法名，不调用服务实例的任何方法。
- 主探测目标直用 ctx.session 快照（自建就绪 session），缺省回退主 session；
  移除按「非空服务实例数」的候选评分（评分需要对活 session 逐个调 getter，同样
  有崩溃面）。
- 逐服务增量落盘：每个服务枚举完成即重写探测 JSON——个别 getter 若仍触发原生
  崩溃，文件保留最后一个成功项，精确定位肇事 getter。
- 移除 shapeKeyGetters / DATA_GETTER_RE（无使用方）；probe-services 的
  loginService shape 探测保留（历次探测已证安全）。
