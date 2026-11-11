
<div align="center">

<h1 id="napukettoqq">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/wordmark-dark.svg">
    <img src=".github/assets/wordmark-light.svg" alt="NapukettoQQ" width="800">
  </picture>
</h1>

<p><b>基于 QQNT 原生模块的自托管机器人框架 —— 无客户端、无注入、原生直连</b></p>

<p>
  <a href="https://github.com/NapukettoDev/NapukettoQQ/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/NapukettoDev/NapukettoQQ/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/create-napukettoqq"><img src="https://img.shields.io/npm/v/create-napukettoqq?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  &nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

<p>
  <a href="./docs/README.md">文档</a> •
  <a href="#english">English</a>
</p>

</div>

---

## 支持的协议

| 协议 | 传输形态 | 能力概览 |
| :--- | :--- | :--- |
| **Milky** | 单端口 HTTP + SSE / WS 事件流 + WebHook 推送 | **64 个动作 / 20 个事件** — 对齐 Milky 1.3.0 规范；覆盖消息、群管、好友、群通知、群文件与表情表态 |
| **Satori** | HTTP RPC / WS 事件 | **22 个动作** — 涵盖消息、频道、群组、成员、好友与表态 |
| **OneBot11** | HTTP / WS / 反向 WS / Webhook | **79 个动作** — 涵盖消息、群管、好友、通知、系统与媒体 |
| **KuroBot** | 出站 WS 客户端 | **`kurobridge-ws` 0.4.0** — 开箱即用的 QQ 群聊与 Minecraft 服务器互通 |

> 传输实例、鉴权、事件字段与已知限制详见协议文档：[Milky](./docs/protocols/milky.md) · [Satori](./docs/protocols/satori.md) · [OneBot 11](./docs/protocols/onebot11.md) · [KuroBot](./docs/protocols/kurobot.md)。

---

## 快速开始

- **运行环境**：Node.js 24+（Windows 10/11 x64 或 Linux x64）
- **依赖说明**：无需安装 QQ 客户端；Linux 系统需装 `libgnutls30`，详见 [原生宿主文档](./docs/architecture/linux-native-host.md)

### 1. 创建并启动

```bash
pnpm create napukettoqq      # 按提示填写项目名
cd <项目名>
pnpm start
```

* 首次启动，会在项目根目录生成 `napuketto.toml`；

<br>

<details>
<summary><b>点击查看部署演示</b></summary>
<br>

<img src=".github/assets/Deploy.webp" alt="NapukettoQQ 部署演示" width="600">

</details>

<br>

<details>
<summary><b>使用 Docker 部署（仅支持 <code>linux/amd64</code>）</b></summary>
<br>

官方容器镜像，无需安装 Node.js 环境

```bash
curl -fsSL https://raw.githubusercontent.com/NapukettoDev/NapukettoQQ/main/docker/compose.yaml -o compose.yaml
curl -fsSL https://raw.githubusercontent.com/NapukettoDev/NapukettoQQ/main/docker/napuketto.toml.example -o napuketto.toml

# 编辑 napuketto.toml 修改 qq 与 token（容器内监听地址请保持 0.0.0.0）
docker compose up -d
docker compose logs -f      # 首次启动：下载官方包 → 解包 → 渲染二维码
```

完整说明详见 [Docker 部署指南](./docs/guides/docker.md)。

</details>

<br>

### 2. 配置

用编辑器打开生成的 `napuketto.toml`：
- 修改 `qq` 为你的机器人账号。
- 设置 `token` 访问密钥（若部署于公网请务必配置）。

模板配置文件有极详尽的注释供参考；进阶配置见 [配置文档](./docs/guides/configuration.md)。

---

## 结构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/architecture-dark.svg">
    <img src=".github/assets/architecture-light.svg" alt="NapukettoQQ 结构：CLI / supervisor → boot → 自建宿主（标准 Node，加载 stub QQNT.dll 与 wrapper.node）→ kernel → adapter → Milky / OneBot 11 / Satori / KuroBot">
  </picture>
</p>

详细启动顺序、QQ 文件来源与数据流向详见 [运行链路文档](./docs/architecture/runtime.md)。

---

## 排障

```bash
pnpm exec napuketto status              # 查看 supervisor 与各账号状态
pnpm exec napuketto status -q <uin>     # 查看指定账号
pnpm exec napuketto stop                # 停止全部服务
pnpm exec napuketto restart             # 重启 supervisor
pnpm exec napuketto config list         # 查看当前有效配置
```

* 日志位于 `<数据根>/<uin>/logs/`（`napuketto.log` 业务、`loader.log` 引导、`napuketto-boot.log` 进程日志）
* 常见排障与进阶运维见 [运维手册](./docs/guides/operations.md)

---

## 开发

* **提交流程**：所有改动均通过 PR 提交，合入前须确保本地 `pnpm check` 通过。
* **发布与CI**：涉及发布内容的改动需随提交附上 `changeset`；待 CI 全绿后方可合并。
* **规范参考**：[贡献指南](./.github/CONTRIBUTING.md) | [工程指南](./AGENTS.md)。

| 路径 | 职责说明 |
| --- | --- |
| `packages/kernel` | 唯一原生交互层：wrapper 加载、登录/Session、业务 API、事件通道、缓存 |
| `packages/network` | 协议无关传输原语：HTTP / WS Server & Client、泛型广播 |
| `packages/media` | 图片、音频、视频与文件识别及转码处理 |
| `packages/adapter` | 协议适配器容器：Core + Milky / OneBot 11 / Satori / KuroBot 实现 |
| `packages/loader` | QQ 文件定位与下载、stub 校验、自建宿主启动、实例锁、IPC 通信 |
| `apps/cli` | 单账号 / 多账号 supervisor、配置命令、状态查询与停启控制 |
| `apps/napuketto-create` | 项目初始化脚手架 |

---

## 文档

| 类别 | 链接导航 |
| --- | --- |
| **总览与架构** | [文档首页](./docs/README.md) · [架构总览](./docs/architecture/overview.md) · [运行链路](./docs/architecture/runtime.md) · [架构决策记录 (ADR)](./docs/architecture/decisions.md) |
| **使用与维护** | [配置指南](./docs/guides/configuration.md) · [开发指南](./docs/guides/development.md) · [运维手册](./docs/guides/operations.md) · [发布流程](./docs/guides/release.md) |
| **协议参考** | [Milky](./docs/protocols/milky.md) · [OneBot 11](./docs/protocols/onebot11.md) · [Satori](./docs/protocols/satori.md) · [KuroBot](./docs/protocols/kurobot.md) |
| **官方生态** | [koishi-plugin-adapter-napuketto](https://www.npmjs.com/package/koishi-plugin-adapter-napuketto)（独立仓库，直接依赖 npm 上已发布的 `@napuketto/*`） |
| **开源治理** | [贡献指南](./.github/CONTRIBUTING.md) · [安全策略](./.github/SECURITY.md) · [MIT 许可证](./LICENSE) |

---

## 状态

---

## English

**NapukettoQQ** is a self-hosted bot framework built on the QQ NT native module (`wrapper.node`). It runs a standard Node.js process with a stub `QQNT.dll`, loads the native module directly, and exposes **Milky**, **OneBot 11**, **Satori**, and **KuroBot** interfaces — with no QQ client, no process injection, and no disk patching.

Each account runs in its own isolated host process supervised by the CLI, with all configurations managed in a single `napuketto.toml` file at the project root.

```bash
pnpm create napukettoqq
cd <project>
pnpm start

```

*Not affiliated with Tencent. Entirely original implementation with no third-party GPL code. Released under the [MIT License](./LICENSE).*


