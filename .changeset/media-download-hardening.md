---
"@napuketto/media": minor
"@napuketto/adapter": patch
---

媒体下载路径收敛与出站加固（对应安全审计 C-02 的下载面）：

- `downloadUrl` 改为**流式落盘**（同目录临时文件 + 原子 rename，失败清理），内存占用不随文件大小增长；超时覆盖重定向与读 body 全过程。
- 仅允许 `http`/`https`；手动跟随 30x（上限 5 跳）且**每一跳重新校验**，阻断「首跳合法、跳转内网」。字面 IP 目标拒绝链路本地（含 `169.254.169.254` 云元数据）、未指定、多播与保留段；环回与 RFC1918 私有段保留（自建 LAN 媒体服务/本机渲染服务是受支持部署形态）。
- 新增 `headers` 透传选项。adapter 的 `downloadBufferToFile` 不再裸 `fetch` + `arrayBuffer()`（无超时、无大小上限，超大响应可直接打爆堆），统一走该原语。
- Satori `resolveAsset` 修复 URL 尾段为 `..` / `.` 时文件名逃出缓存目录的问题（回退 `asset-<时间戳>`）。

已知边界：本层不解析域名（DNS rebinding 由部署侧网络策略兜底）；本地文件路径白名单需要协议配置契约，留待后续单独变更。
