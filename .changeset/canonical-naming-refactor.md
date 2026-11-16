---
"@napuketto/adapter": patch
"@napuketto/cli": patch
"@napuketto/kernel": patch
"@napuketto/loader": patch
"@napuketto/media": patch
"@napuketto/network": patch
---

统一全仓命名规范、错误消息提取与抛错范式，并收敛重复工具函数（纯重构，公开 API 保留
`@deprecated` 别名与旧环境变量双读回退）。

- `kernel` 新增唯一权威 `errorMessage(err)`；`adapter` / `apps/cli` 统一复用，删除各包内联
  `err instanceof Error ? err.message : String(err)` 与本地 `errMsgString`。
- 环境变量前缀统一为 `NAPUKETTO_*`（读取侧回退 `NAPKETTO_*` / `NAPUTO_*`；`loader` 注入侧
  切换到新前缀，`NAPUTO_DISABLE_MEDIA_PATCH` / `NAPUTO_MEDIA_PATCH_STATUS` 两个原生契约键
  保持不变），布尔解析统一走 `isEnvEnabled`（`"1"` / `"true"`）。
- `adapter` 动作 / 适配器生命周期抛错统一为 `kernelError`：Satori 动作的 `NOT_FOUND` /
  `INVALID_PARAM` 现分别映射为 HTTP 404 / 400（此前落 `UNKNOWN` → 500），OB11 下载类失败
  映射为 `SEND_CODE_FAILED`（100）。
- `media` 下载与转码统一抛 `MediaError`；`network` 统一 `incomingMessageToRequestContext`；
  跨包重复的 `replaceExt` / `NUMERIC_RE` / `fileUriToPath` / Zod schema / 动态模块契约接口
  收敛到单一来源。
- 文件命名统一：`one-bot-api.ts` → `onebot-api.ts`、`log-cfg.ts` → `log-config.ts`、
  `group/group-files-*.ts` → `group/files-*.ts`；`IKernelLoginListener` / `SatoriAction` /
  `QQVersion*` 等旧名保留 `@deprecated` 别名导出。
