---
"@napuketto/kernel": patch
"@napuketto/loader": patch
---

fix(kernel/loader): 修复视频消息经 IPC 传输后 thumbPath 丢 Map 形态导致接收链路崩溃与缩略图路径丢失

- kernel：`toCanonicalElements` 读 `videoElement.thumbPath` 改为防御式（`readVideoThumbPath`）——进程内为 `Map<0, path>`，经 JSON/IPC 序列化后退化为平面对象 `{"0": path}`（未规整链路为空对象 `{}`），原实现直接 `.get(0)` 抛 TypeError，整条视频消息事件分派失败（koishi IPC 模式 2026-10-24 线上报错）；类型契约同步放宽为 Map / 平面对象 / 字符串联合
- loader：IPC 编码（`encodeIpcMessage`，`sendIpc` 统一改走该出口）出站前经 `toJsonSafe` 深规整——`JSON.stringify` 会把 Map 内容全丢（Map → `{}`、Set → `[]`），此前事件 args 里的视频缩略图路径与动作结果（如 `uinToUid` 返回的 `Map`）跨进程后全部丢失；规整后 Map → 平面对象、Set → 数组，配合 kernel 侧防御读取，缩略图路径跨进程完整保留
