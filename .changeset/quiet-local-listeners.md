---
"@napuketto/network": minor
"@napuketto/adapter": minor
---

F-03 同端口 Upgrade 钩子须同步选择接受或拒绝。未匹配、拒绝及决策异常会收到 HTTP 响应，随后关闭连接。Milky 继续在 `/event` 完成鉴权和握手。

F-04 OneBot 11、Satori 和 Milky 的已启用非回环监听要求有效 token。部署请替换空白和占位 token 并同步客户端。可信本机部署可绑定数值回环后免鉴权。

F-13 请求和传输失败日志使用固定错误类别、路由模板或配置索引。鉴权解析失败回调改为无参通知。
