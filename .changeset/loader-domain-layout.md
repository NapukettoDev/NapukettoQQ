---
"@napuketto/loader": patch
---

源码目录按领域重整为 `shared/` / `contract/` / `lifecycle/` / `qq/` / `boot/` / `host/`
（行为零变更、对外 API 零变更）：`internal/` 改名 `shared/` 并合并包根与版本元数据；
跨进程契约（IPC schema、原生噪音判定、协议键）收进 `contract/`；`host/` 拆为
`runtime/` / `bootstrap/` / `auth/` / `protocols/` / `ipc/` 五层且严格单向；
`qq/manifests/` 保持零 TS 源码相对 import 供 tooling 直引；`host/util.ts` 拆为
`runtime/errors.ts` 与 `runtime/state.ts`；构建入口、单测路径与设计文档同步更新。
