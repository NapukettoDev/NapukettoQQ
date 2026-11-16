---
"@napuketto/adapter": patch
"@napuketto/cli": patch
"@napuketto/kernel": patch
"@napuketto/loader": patch
---

重构：全仓架构与依赖拓扑解耦（零公共 API / exports 契约破坏）。

- kernel：`LogLevel` 下沉至 `infra/log-config.ts`、`waitFor/sleep` 下沉至
  `infra/wait.ts`（`login/wait.ts` 与 `types/message-element.ts` 保留桥接重导出）；
  消息元素运行时转换迁入新 `codec/message-element.ts`（类型层不再 import `node:fs`）；
  新增自建宿主原生引导原语 `dlopenWrapper` / `activateO3MiscService` 并对外导出。
- adapter：kurobot / onebot11 契约下沉到 `types.ts`、`api/onebot-api.ts` 消除类型环；
  远程下载与 `file://` 解析统一收口到 `shared/media.ts`（异步落盘，移除同步阻塞 I/O）；
  协议内部统一经 `core/index.js` 与各子域 `index.ts` 消费。
- loader：`QqInstallInfo` 一族与 `KernelServices` 下沉到 `qq/qq-types.ts` /
  `host/types.ts`，消除 qq 与 host 的目录环；IPC 契约统一经 `host/ipc/index.js` 出口。
- cli：`config/store.ts` 改为注入式日志回调，解除 `config/ <-> logger.ts` 双向值依赖。
