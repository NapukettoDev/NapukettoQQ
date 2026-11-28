---
"@napuketto/loader": minor
"@napuketto/cli": minor
---

原生补丁契约键统一到规范前缀：`NAPUTO_DISABLE_MEDIA_PATCH` / `NAPUTO_MEDIA_PATCH_STATUS` 改为 `NAPUKETTO_DISABLE_MEDIA_PATCH` / `NAPUKETTO_MEDIA_PATCH_STATUS`，闭源 stub 源码与预编译 `QQNT.dll` 同步更新。部署侧若手工设置过旧键，需改用新键（旧拼写不再读取）。
