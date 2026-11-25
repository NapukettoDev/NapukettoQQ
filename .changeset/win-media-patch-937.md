---
"@napuketto/loader": patch
---

fix: Windows QQNT 9.9.37-54395 入站图片自动落盘恢复

9.9.37 的 `PicDownloadMgr` 对象布局变化使旧版固定的次 vtable 槽位校验把真实实例
全部过滤，补丁等待 15 分钟后报 `no_instance`，OB11 侧 `image.data.file` 恒为空。
Windows stub 改为版本无关解析：槽 20 函数指针回溯到 MSVC `CompleteObjectLocator`
动态求主 vtable，对象形态按 RTTI 次 vtable 动态统计；同时区分 `matched`/`cleared`、
写前校验页可写、排除当前线程栈，并在模块尚未完成重定位时短窗口重试。
状态 JSON 增量输出 `matched` / `slotOff` / `disp` 诊断字段（旧字段语义不变）。
