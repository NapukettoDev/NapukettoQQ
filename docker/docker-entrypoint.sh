#!/bin/sh
# NapukettoQQ 容器入口：校验配置 → 对齐数据卷属主 → 降权到 node(1000) 后 exec。
#
# 为什么要这层：
# - Docker 在 bind mount 目标不存在时会建成**空目录**，直接交给 cli 只会得到一句
#   TOML 解析错误；这里提前给出可操作的提示，并以 78（配置校验失败契约）退出。
# - 数据根可能是新建命名卷（root 属主）或宿主机 bind mount，首启统一对齐到 node。
# - 用 exec 替换 PID 1，SIGTERM 直接到达 cli/supervisor，容器停止才能走优雅退出
#   （supervisor 收到信号后停止全部账号，8s 兜底强杀）。
# - 降权用 util-linux 自带的 setpriv（Debian 基础镜像已有），不再安装 gosu。
set -eu

APP_DIR="${APP_DIR:-/app}"
DATA_ROOT="${NAPKETTO_DATA:-$APP_DIR/.napuketto}"
CONFIG="${NAPKETTO_CONFIG:-$APP_DIR/napuketto.toml}"

export NAPKETTO_DATA="$DATA_ROOT"
export NAPKETTO_CONFIG="$CONFIG"

if [ ! -f "$CONFIG" ]; then
    cat >&2 <<EOF
[entrypoint] 未找到配置文件：$CONFIG

请把项目的 napuketto.toml 挂载进容器，例如：
  volumes:
    - ./napuketto.toml:/app/napuketto.toml

没有现成配置时，可从模板开始（仓库 docker/napuketto.toml.example）：
  cp napuketto.toml.example napuketto.toml

注意：容器内协议监听地址要写 0.0.0.0，宿主机/其他容器才能访问；
      模板默认的 127.0.0.1 只在容器内部可达。
EOF
    exit 78
fi

mkdir -p "$DATA_ROOT"

# 只在属主不是 node 时对齐一次；.owner-ok 标记避免 Windows/macOS 的 bind mount
# 每次启动都重复 chown 整个数据根（QQ 原生文件约 300MB）。
if [ "$(id -u)" = "0" ]; then
    if [ "$(stat -c %u "$DATA_ROOT")" != "1000" ] && [ ! -f "$DATA_ROOT/.owner-ok" ]; then
        chown -R node:node "$DATA_ROOT" 2>/dev/null || true
        : >"$DATA_ROOT/.owner-ok" 2>/dev/null || true
    fi
    exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
