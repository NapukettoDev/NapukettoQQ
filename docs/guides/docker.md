# Docker 部署

> 适用场景：把 NapukettoQQ 跑在服务器或 Docker Desktop 上。本文只讲容器化部署的文件、
> 路径与运维；协议字段与默认值见 [configuration.md](configuration.md)，原生层排障见
> [operations.md](operations.md)。

## 部署形态与进程拓扑

官方镜像 `ghcr.io/napukettodev/napukettoqq` 只发布 `linux/amd64`，容器内与原生部署共用同一套进程拓扑：

```text
entrypoint(sh) → setpriv node → CLI(supervisor) → 每账号 boot 进程 → 自建宿主 → dlopen wrapper.node
```

- 配置仍是单个 `napuketto.toml`，数据根 `.napuketto/`（容器内 `/app/.napuketto`）；登录仍是扫码，二维码 PNG 在 `<数据根>/<uin>/cache/qrcode.png`。
- 停容器 = `SIGTERM` → supervisor 停止全部账号 → 8s 兜底强杀（compose 给 30s）。
- **镜像不内置腾讯二进制**：`wrapper.node` 由 loader 首启从官方 CDN 下载、解包进数据卷。

## 前置条件

- **Docker**：Engine 24+ 或 Docker Desktop，含 compose v2。
- **架构**：仅 `linux/amd64`；arm64 现状见 [linux-native-host.md](../architecture/linux-native-host.md)。
- **资源与出网**：镜像约 520MB（slim 240MB）+ 数据卷 300MB + 首启解包峰值 1GB；需能访问 `ghcr.io` 与 `qqdl.gtimg.cn`。

## 镜像变体与部署文件

`docker/` 目录提供官方镜像与单机部署示例（同一份 `Dockerfile`，只差 `WITH_FFMPEG`）：

| 文件 | 用途 |
|---|---|
| `Dockerfile` | 运行镜像定义 |
| `docker-entrypoint.sh` | 入口：校验配置、降权 |
| `compose.yaml` | 单机部署示例 |
| `napuketto.toml.example` | 容器配置模板（`0.0.0.0`） |

- **默认** `latest` / `cli-<版本>` / `sha-<短 sha>`：带静态 `ffmpeg`/`ffprobe`，语音与视频开箱即用。
- **slim** `latest-slim` / `cli-<版本>-slim` / `sha-<短 sha>-slim`：不含 ffmpeg，语音/视频报 `ffmpeg 不可用`。

`compose.yaml` 默认用 `latest`；纯文本部署把 `image:` 换成 `...:latest-slim` 即可。

## 操作步骤

取到两个文件（也可直接从仓库 `docker/` 目录复制）：

```bash
curl -fsSL https://raw.githubusercontent.com/NapukettoDev/NapukettoQQ/main/docker/napuketto.toml.example -o napuketto.toml
curl -fsSL https://raw.githubusercontent.com/NapukettoDev/NapukettoQQ/main/docker/compose.yaml -o compose.yaml
```

1. 改 `napuketto.toml`：`qq` 换成你的号、`token` 换成随机串、监听地址保持 `0.0.0.0`
   （容器内的 `127.0.0.1` 是容器自己的回环，宿主机访问不到）。
2. `docker compose up -d`，再用 `docker compose logs -f` 看首启进度。
3. 扫码：终端里渲染 ANSI 二维码，或打开 `./.napuketto/<QQ号>/cache/qrcode.png`；过期时
   `docker compose restart` 重新生成，无需重新下载 QQ 文件。

## 容器内路径布局

下表路径相对 `/app/.napuketto/`（镜像已固定 `NAPKETTO_CONFIG` 与 `NAPKETTO_DATA`）：

| 路径 | 内容 |
|---|---|
| `/app/napuketto.toml` | 配置文件（宿主机挂入） |
| `<uin>/cache/qrcode.png` | 登录二维码 |
| `<uin>/logs/` | kernel 与 loader 日志 |
| `qq-files/<版本>/` | 下载解包的 QQ 原生文件 |
| `nt_qq/` | 登录态与业务数据（备份含它） |

## 首次启动链路

- loader 读 `qq-releases.json`，选当前平台/架构的最新官方 Linux deb（约 190MB）；
- 内置 7zz 三层解包（deb → data.tar.xz → data.tar），提取 `wrapper.node`、`major.node`、`libbugly.so`、`sharp-lib/` 等，中间产物解完即删；
- 装配自建宿主：`LD_PRELOAD` = stub + 系统 `libgnutls.so.30`，然后 `dlopen`；
- 有历史票据走快速登录，否则进入扫码；下载只在首启发生，之后复用 `qq-files/`。

## 端口与安全

- **容器内监听地址必须写 `0.0.0.0`**：写 `127.0.0.1` 时端口映射看着正常，宿主机却连不上。
- compose 默认只绑宿主机 `127.0.0.1`；局域网访问用 `HOST_BIND=0.0.0.0 docker compose up -d`，并设 `token`。
- 暴露公网请走反向代理并上 HTTPS / `wss://`；OneBot 11 的 HTTP 与 WS 都是明文。
- 正向 WS（`wsReverseUrls`）不需要映射端口，适合连 `host.docker.internal` 或同网络 Koishi。

## 多账号与多容器

- **一容器多账号**：多个 `[[accounts]]`，每账号一个宿主进程，崩溃互不影响（`autoRestart`），每账号约 250MB。
- **一容器一账号**：复制 compose，改 project 名、数据根与端口，隔离与升级更独立。
- 同一数据根只能给一个容器用，否则报「数据目录已被其他实例占用」。

## 日常运维

```bash
docker compose logs -f --tail=200                    # 跟随日志（含二维码）
docker compose ps                                    # 状态 + healthcheck
docker compose exec napuketto napuketto status       # 账号运行状态
docker compose restart                               # 重启（数据保留）
docker compose pull && docker compose up -d          # 升级镜像
```

不要在容器里跑 `napuketto stop`（进程退出后 `restart: unless-stopped` 会立刻拉起）；停服务用
`docker compose stop`。健康 = 至少一个账号 boot 进程存活，全部退出才 unhealthy。

## 备份与迁移

```bash
docker compose stop
tar -czf napuketto-backup.tar.gz -C . .napuketto
docker compose start
```

只需备份数据根（`nt_qq/`、账号目录与日志）；迁移后保持同一 QQ 号通常可直接快速登录，被风控时重新扫码；`qq-files/` 可不迁。

## 自建镜像

```bash
docker build --build-arg NAPUKETTO_VERSION=<版本> -t napukettoqq:<版本> docker/
docker build --build-arg NAPUKETTO_VERSION=<版本> --build-arg WITH_FFMPEG=false -t napukettoqq:<版本>-slim docker/
```

- 构建只从 npm 安装**已发布**的 `@napuketto/cli`，不 COPY 仓库源码；`compose.yaml` 不带
  `build:`，自建后改 `image:` 即可。
- `NAPUKETTO_VERSION` 缺省 `latest`；`WITH_FFMPEG` 缺省 `true`：ffmpeg/ffprobe 用
  `mwader/static-ffmpeg` 的静态二进制，不引入 Debian ffmpeg 的动态库闭包。

## 验证与常见排障

| 现象 | 处理 |
|---|---|
| `gnutls_free` undefined symbol | 自建镜像补 `libgnutls30` |
| `libX11.so.6` 缺失 | 补 `libx11-6` 等 X11 客户端库 |
| 语音/视频报 ffmpeg 不可用 | 换默认 tag，或 `WITH_FFMPEG=true` |
| 宿主机连不上 3000/3001 | 改 `host = "0.0.0.0"`，核对端口映射 |
| 反复重启且日志有 `exit 78` | 配置校验失败，修 `napuketto.toml` |
| 首启卡住 / 下载失败 | 查 `qqdl.gtimg.cn` 出网，或挂载 `/opt/QQ` |
| `EACCES` / 写文件失败 | 数据卷属主错，`chown -R 1000:1000` |

## 合规说明
镜像只含 MIT 许可的本仓运行时代码与第三方系统库；腾讯 QQ 的二进制（`wrapper.node` 等）
**不随镜像分发**，由使用者机器在运行时从腾讯官方 CDN 下载，请遵守腾讯软件许可与当地法律。
默认镜像里的 `ffmpeg`/`ffprobe` 来自
[`mwader/static-ffmpeg`](https://github.com/wader/static-ffmpeg) 的 GPL 静态构建，作为独立
可执行文件分发、不链接本仓代码；slim 变体不含它们。
