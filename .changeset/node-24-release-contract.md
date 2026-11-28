---
"@napuketto/kernel": minor
"@napuketto/media": minor
"@napuketto/network": minor
"@napuketto/adapter": minor
"@napuketto/loader": minor
"@napuketto/cli": minor
"create-napuketto": minor
---

运行时与开发工具链的最低版本统一为 Node.js 24.11.0。请先升级运行 CLI、宿主或消费库包的 Node，再更新 Napuketto。CommonJS 仍可通过 Node 的 `require(esm)` 加载库入口。Windows 脚手架通过系统文件关联打开配置，保留完整路径中的空格和特殊字符，打开失败时提示手动编辑。
