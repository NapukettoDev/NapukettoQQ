<div align="center">

<h1 id="napukettoqq">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/wordmark-dark.svg">
    <img src=".github/assets/wordmark-light.svg" alt="NapukettoQQ" width="600">
  </picture>
</h1>

**基于 QQ NT 原生模块的高性能机器人框架**

[![CI](https://img.shields.io/github/actions/workflow/status/NapukettoDev/NapukettoQQ/ci.yml?style=flat-square&label=CI)](https://github.com/NapukettoDev/NapukettoQQ/actions/workflows/ci.yml)
&emsp;
[![Release](https://img.shields.io/github/v/release/NapukettoDev/NapukettoQQ?style=flat-square&label=Release)](https://github.com/NapukettoDev/NapukettoQQ/releases)
&emsp;
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)
&emsp;
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)
&emsp;
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

<p>
  <a href="./docs/architecture.md">文档</a> •
  <a href="#english">English</a>
</p>

</div>

> [!NOTE]
> **声明**：\
> 　本项目是独立的第三方项目，与腾讯和QQ无隶属或授权关系\
> 　项目仅供学习与技术研究，请遵守《QQ 用户协议》及适用法律

---

## 特性

* **原生直连**\
　直接调用官方 NAPI 导出接口，不经过任何代理层
* **无侵入运行**\
　自建宿主直接加载原生模块，不拉起 QQ 客户端、不注入任何进程、零磁盘篡改，内存占用百兆级

<!-- -->

* **双协议对外**\
　OneBot 11（79 动作含别名变体）+ Satori，HTTP / WebSocket / 反向 WebSocket 多实例
* **开箱即用**\
　单进程编排多账号（崩溃自动重启），项目根一份 `napuketto.toml` 管全部配置

---

## 部署

只需两条命令即可完成初始化与启动：

```bash
pnpm create napukettoqq       # 一键生成项目骨架并安装依赖
pnpm start                    # 启动：自动登录，就绪后协议服务开始监听
```

<details>
<summary>点击查看部署演示</summary>

<img src=".github/assets/demo.webp" alt="NapukettoQQ 部署演示" width="600">

</details>

> [!TIP]
> 首次启动自动在项目根生成 `napuketto.toml`（账号必填，协议段不写即不启用）\
> 协议与通信配置均内嵌在 `[[accounts]]` 账号段内

---

## 维护

* **文档**：[架构书](./docs/architecture.md) ｜ [运维手册](./docs/OPERATIONS.md)
* **治理**：[贡献指南](./.github/CONTRIBUTING.md) ｜ [仓库约定](./AGENTS.md) ｜ [安全策略](./.github/SECURITY.md)
* **授权说明**：[MIT](./LICENSE)

---

## 状态

[![Repobeats analytics image](https://repobeats.axiom.co/api/embed/1bf92988cdc683dd8eec6232b526e6c619984c37.svg "Repobeats analytics image")](https://github.com/NapukettoDev/NapukettoQQ/pulse)

---

## English

NapukettoQQ is a **high-performance bot framework built on the QQ NT native module (`wrapper.node`)**. It boots a self-hosted standard Node process, loads the native module directly, and exposes OneBot 11 and Satori protocol interfaces.

```bash
pnpm create napukettoqq
pnpm start
```

*Not affiliated with Tencent. Entirely original implementation with no NapCat code. Released under the [MIT License](./LICENSE).*
