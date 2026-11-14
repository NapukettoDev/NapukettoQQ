---
"@napuketto/loader": minor
---

入站图片自动下载补丁接线（issue #105）：`launchSelfHost` 新增 `nativeMediaPatch` 选项
（缺省 true）——私有 native stub 组件在 wrapper 加载后运行期放行 QQ 原生收图自动下载
（不改安装目录、版本特征失配自动降级）；显式 false 注入 killswitch
`NAPUTO_DISABLE_MEDIA_PATCH=1`。状态文件恒注入 `NAPUTO_MEDIA_PATCH_STATUS`（指向
`<账号数据目录>/media-patch-status.json`），self-host bootstrap 完成后读取并以
`[media-patch]` 前缀记录结构化结果（applied / degraded / disabled_by_env + 组件明细）。
