---
"@napuketto/network": patch
"@napuketto/adapter": patch
---

修复 Milky 活跃 SSE/WS 导致的关闭阻塞；HttpServer 有界回收普通请求、流式连接及同端口升级资源，重复关闭安全。监听失败 reject 并支持清理后重试；落实普通请求 timeoutMs（504），首次响应生效，迟到/重复 respond 忽略，同步处理及序列化异常回 500。流式响应不受普通请求超时影响。
