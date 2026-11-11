# Docker 部署文件

本目录是 NapukettoQQ 的官方镜像与 Compose 部署示例。

| 文件 | 用途 |
|---|---|
| `Dockerfile` | 官方运行镜像（Node 24 + `@napuketto/cli` + QQ 原生文件所需系统库 + ffmpeg） |
| `docker-entrypoint.sh` | 校验配置 → 对齐数据卷属主 → `gosu` 降权到 `node(1000)` |
| `compose.yaml` | 单机部署示例（配置 / 数据卷 / 端口 / 健康检查） |
| `napuketto.toml.example` | 面向容器的配置模板（监听 `0.0.0.0`） |

```bash
cp napuketto.toml.example napuketto.toml   # 改 qq / token
docker compose up -d
docker compose logs -f                     # 首次启动：下载 QQ → 二维码
```

完整说明（首次启动链路、端口与安全、备份迁移、排障）见
[docs/guides/docker.md](../docs/guides/docker.md)。

要点：

- 镜像**不内置腾讯二进制**，`wrapper.node` 由 loader 首启时从官方 CDN 下载到数据卷；
- 只支持 `linux/amd64`（arm64 尚未交付）；
- 容器内监听地址要写 `0.0.0.0`，默认 `127.0.0.1` 在容器里只有容器自己能访问。
