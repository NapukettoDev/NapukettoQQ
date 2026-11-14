---
"@napuketto/cli": minor
---

主配置新增 `nativeMediaPatch`（缺省 true）：控制入站图片自动下载补丁（stub 私有组件，
issue #105）。supervisor 模式下 `false` 会向账号子进程注入 `NAPUTO_DISABLE_MEDIA_PATCH=1`；
`-q` 直跑不经 supervisor，用同名环境变量显式禁用。配置模板同步补充说明。
