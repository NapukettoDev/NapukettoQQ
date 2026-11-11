# Docker 部署

> 目标读者：把 NapukettoQQ 跑在服务器（或 Docker Desktop）上的人。本文只讲容器化部署的
> 形态、路径与运维；协议字段与默认值见 [configuration.md](configuration.md)。

## 1. 部署形态

官方镜像 `ghcr.io/napukettodev/napukettoqq`（仅 `linux/amd64`）。容器内与原生部署是
**同一套进程拓扑**，没有另起一套运行模式：

```
entrypoint(sh) → gosu node → napuketto CLI(supervisor)
                                └─ 每账号一个 boot 进程 → 自建宿主 → dlopen wrapper.node
```

由此带来三条与原生部署一致的行为：

- 配置仍是单个 `napuketto.toml`，数据根仍是 `.napuketto/`（容器内 `/app/.napuketto`）；
- 登录仍是扫码 + 快速登录，二维码 PNG 落在 `<数据根>/<uin>/cache/qrcode.png`；
- 停容器 = `SIGTERM` → supervisor 停止全部账号 → 8s 兜底强杀（`stop_grace_period` 30s）。

**镜像不内置腾讯二进制**（ADR-019）：`wrapper.node` 由 loader 在首启时从官方 CDN
下载 deb、解包进数据卷，与原生部署完全同一条链路。

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Docker | Engine 24+ / Docker Desktop，含 compose v2 |
| 架构 | `linux/amd64`（arm64 尚未交付，见 [linux-native-host.md](../architecture/linux-native-host.md) 附录 E.2） |
| 磁盘 | 镜像约 1GB（含 ffmpeg）+ 数据卷（QQ 原生文件约 300MB）+ 首启临时解包空间约 1GB |
| 出网 | `ghcr.io`（拉镜像）、`qqdl.gtimg.cn`（首启下载 QQ） |

## 3. 快速开始

```bash
# 1) 取配置模板与 compose（也可以从仓库 docker/ 目录直接复制）
curl -fsSL https://raw.githubusercontent.com/NapukettoDev/NapukettoQQ/main/docker/napuketto.toml.example -o napuketto.toml
curl -fsSL https://raw.githubusercontent.com/NapukettoDev/NapukettoQQ/main/docker/compose.yaml -o compose.yaml

# 2) 改 napuketto.toml：qq 换成你的号，token 换成随机串，监听地址保持 0.0.0.0
#    容器内的 127.0.0.1 是容器自己的回环，宿主机访问不到

# 3) 启动
docker compose up -d
docker compose logs -f
```

首启日志顺序大致是：

```text
… 定位/下载 QQ 原生文件（首启约 1–2 分钟，仅一次）…
… 解包（约 5s）…
… wrapper 装配完成 version=3.2.35-54395
… loginService.initConfig OK commonPath=/app/.napuketto/nt_qq/global
… 请扫描二维码登录（保存: /app/.napuketto/<uin>/cache/qrcode.png | URL: …）
<终端二维码>
```

**扫码方式**（任选其一）：

- 终端：`docker compose logs -f` 里直接渲染 ANSI 二维码，手机对着终端扫；
- 图片：宿主机打开 `./.napuketto/<QQ号>/cache/qrcode.png`（compose 已把它 bind mount 出来）；
- 前台（等价于原生 `pnpm start`，二维码直接画在终端）：

  ```bash
  docker run -it --rm \
    -v "$PWD/napuketto.toml:/app/napuketto.toml" \
    -v "$PWD/.napuketto:/app/.napuketto" \
    -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
    ghcr.io/napukettodev/napukettoqq:latest
  ```

二维码过期时 `docker compose restart` 会重新生成（无需重新下载 QQ 文件）。

登录成功后按配置监听协议端口：

```text
OneBot 11 HTTP   http://127.0.0.1:3000
OneBot 11 WS     ws://127.0.0.1:3001
```

## 4. 容器内布局

| 路径 | 内容 |
|---|---|
| `/app/napuketto.toml` | 配置文件（compose 从宿主机挂入） |
| `/app/.napuketto/` | 数据根（命名卷或 bind mount） |
| `/app/.napuketto/<uin>/cache/qrcode.png` | 登录二维码 |
| `/app/.napuketto/<uin>/logs/napuketto.log` | kernel 日志 |
| `/app/.napuketto/<uin>/logs/loader.log` | 引导 / 协议校准日志 |
| `/app/.napuketto/qq-files/<版本>/…` | 下载解包的 QQ 原生文件 |
| `/app/.napuketto/nt_qq/` | QQ 登录态与业务数据（**备份含它才有意义**） |

镜像内固定了 `NAPKETTO_CONFIG=/app/napuketto.toml` 与 `NAPKETTO_DATA=/app/.napuketto`
（容器里没有 `package.json`，cli 的项目根探测不会命中，必须显式指定）。

## 5. 首次启动会做什么

1. loader 读 `qq-releases.json` 选当前平台/架构的最新官方 Linux deb（约 190MB）；
2. 内置 7zz 三层解包（deb → data.tar.xz → data.tar），提取 `wrapper.node`、
   `major.node`、`libbugly.so`、`sharp-lib/` 等到 `qq-files/<版本>/`，中间产物解完即删；
3. 装配自建宿主：`LD_PRELOAD` = stub + 系统 `libgnutls.so.30`，然后 `dlopen`；
4. 有历史票据走快速登录，否则进入扫码。

下载只在首启发生。之后重建容器、升级镜像都复用数据卷里的 `qq-files/`。

## 6. 端口与安全

- **容器内监听地址必须写 `0.0.0.0`**（模板已写好）。写 `127.0.0.1` 时端口映射
  看起来正常，但从宿主机连不上——这是容器化最常见的坑。
- compose 默认只把端口绑到宿主机 `127.0.0.1`；要局域网访问：
  `HOST_BIND=0.0.0.0 docker compose up -d`，**并且**必须设置 `token`。
- 暴露到公网请走反向代理并上 HTTPS / `wss://`；OneBot 11 的 WS 与 HTTP 是明文。
- 机器人主动连出去的正向 WS（`wsReverseUrls`）不需要映射任何端口，适合连
  `host.docker.internal`（Docker Desktop）或同网络里的 Koishi。

## 7. 多账号与多容器

- **一个容器多账号**：`napuketto.toml` 里写多个 `[[accounts]]`，supervisor 每账号拉起
  一个宿主进程，单账号崩溃不影响其他账号（`autoRestart` 自动重启）。内存按每账号
  约 250MB 预留。
- **一容器一账号**：复制一份 compose，改 project 名、数据根与端口即可；账号之间
  完全隔离，排障与升级更独立。

## 8. 日常运维

```bash
docker compose logs -f --tail=200          # 跟随日志（含二维码）
docker compose ps                          # 状态 + healthcheck
docker compose exec napuketto napuketto status        # 账号运行状态
docker compose exec napuketto napuketto config list   # 当前生效配置
docker compose restart                     # 重启（重新登录，数据保留）
docker compose pull && docker compose up -d           # 升级镜像
```

注意：

- **不要在容器里跑 `napuketto stop`**：它会让容器主进程退出，`restart: unless-stopped`
  随即把容器拉起来。停服务请用 `docker compose stop`。
- 容器反复重启且日志里有 `exit 78`：配置校验失败，改 `napuketto.toml` 后再起
  （重启策略不会修好配置）。
- 健康检查（`healthcheck`）看的是「至少一个账号的 boot 进程存活」：进程起来就 healthy，
  与是否已扫码无关；全部账号退出才是 unhealthy。

## 9. 备份与迁移

只需要备份数据根：

```bash
docker compose stop
tar -czf napuketto-backup.tar.gz -C . .napuketto
docker compose start
```

里面有 `nt_qq/`（登录票据与业务数据）、账号目录与日志。迁移到新机器后**保持同一 QQ 号**
通常可直接快速登录；被风控拦下时重新扫码即可。`qq-files/` 可以不迁（新机会重新下载，
或直接带上省流量与下载时间）。

## 10. 构建自己的镜像

```bash
docker build --build-arg NAPUKETTO_VERSION=0.5.17 -t napukettoqq:0.5.17 docker/
```

- 构建只从 npm 安装**已发布**的 `@napuketto/cli`，不 COPY 仓库源码——镜像内容与源码
  分支无关，可复现、可审计。
- `NAPUKETTO_VERSION` 缺省 `latest`；生产建议钉版本。
- `compose.yaml` 刻意不带 `build:`（只下载 compose 的用户不该被要求先有 Dockerfile）。
  自建镜像后把 compose 里的 `image:` 改成自己的 tag，或直接用它覆盖官方 tag：
  `docker build -t ghcr.io/napukettodev/napukettoqq:latest docker/`。
- 官方镜像由 `.github/workflows/image.yml` 在 CLI 发布 tag（`@napuketto/cli@<版本>`）
  时自动构建推送，标签为 `latest`、`cli-<版本>`、`sha-<短 sha>`。
- GHCR 包首次发布后默认是 **private**，需要在包设置里改成 public（或改用带凭据的拉取）。

## 11. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `libbugly.so: undefined symbol: gnutls_free` | 镜像缺系统 gnutls | 自建镜像要装 `libgnutls30`（官方镜像已装） |
| `libX11.so.6: cannot open shared object file` | 缺 X11 客户端库 | 装 `libx11-6 libx11-xcb1 libxext6 libxcb1` |
| 宿主机连不上 3000/3001 | 配置里还是 `127.0.0.1`，或没映射端口 | 改 `host = "0.0.0.0"`，确认 `docker compose ps` 的 PORTS |
| 容器不断重启，日志有 `exit 78` | 配置校验失败 | 修 `napuketto.toml`；容器起不来时用 `docker compose up` 前台看错误 |
| 首启卡住 / 下载失败 | 到 `qqdl.gtimg.cn` 不通 | 配代理，或挂载宿主机 `/opt/QQ` 复用本地安装 |
| `EACCES` / 写文件失败 | 数据卷属主不对（自定义 `user:` 时常见） | 让入口脚本以 root 启动（默认），或 `chown -R 1000:1000 .napuketto` |
| `数据目录已被其他实例占用` | 同一数据根跑了两个容器 | 停掉旧的，或给新容器独立数据根 |
| healthcheck 一直 unhealthy | 全部账号已退出 | `docker compose exec napuketto napuketto status` + 看 `logs/napuketto.log` |

更多原生层排障（端口冲突、登录挂起、原生噪音）见 [operations.md](operations.md) §4。

## 12. 合规说明

镜像只包含 MIT 许可的本仓运行时代码与第三方系统库；腾讯 QQ 的二进制（`wrapper.node`
等）**不随镜像分发**，由使用者机器在运行时从腾讯官方 CDN 下载，与手动安装 Linux QQ
等价。请遵守腾讯软件许可与当地法律法规。
