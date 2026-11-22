---
"@napuketto/adapter": minor
"@napuketto/loader": minor
"@napuketto/cli": patch
---

默认隔离 OB11（含 IPC）、Milky 和 Satori 的调用方本地媒体。需要读取共享文件的集成可在
对应账号协议的 `media.localMediaRoots` 列出导出目录。QQ 媒体查询和下载返回具有账号与协议归属、
带有效期的缓存路径，旧缓存路径请重新获取。Satori 仅接受当前账号已发布的内部缓存引用。
