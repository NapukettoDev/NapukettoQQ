# syntax=docker/dockerfile:1

# NapukettoQQ 官方运行镜像（linux/amd64）
#
# 设计要点：
# - 只装运行时：Node 24 + @napuketto/cli + QQ 原生文件所需的系统库 + ffmpeg。
# - **不内置腾讯二进制**（ADR-019）：官方 Linux deb 由 loader 在首启时下载、解包到
#   数据卷，与原生部署走同一条链路；镜像本身不含 wrapper.node。
# - 需要 glibc 系（Debian）：wrapper.node 不支持 musl/Alpine。
# - 容器以 root 启动入口脚本：校验配置 → 对齐数据卷属主 → gosu 降权到 node(1000)。
#
# 构建（版本缺省 latest；发布工作流会传入精确版本）：
#   docker build -t napukettoqq:local docker/
#   docker build --build-arg NAPUKETTO_VERSION=0.5.17 -t napukettoqq:0.5.17 docker/
FROM node:24-bookworm-slim

ARG NAPUKETTO_VERSION=latest

# wrapper.node 的运行期依赖（详见 docs/architecture/linux-native-host.md §5）：
#   libx11-6 / libx11-xcb1 / libxext6 / libxcb1 —— 加载期 DT_NEEDED，不需要 X server
#   libgnutls30 —— libbugly 的隐藏依赖（loader 会 LD_PRELOAD）
#   libgssapi-krb5-2 / libgcrypt20 / libuuid1 / libstdc++6 / zlib1g —— 传递依赖
# ffmpeg —— packages/media 的语音归一化与视频转码依赖系统 PATH
# gosu —— 入口脚本降权；tzdata —— TZ 生效
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        gosu \
        tzdata \
        libx11-6 \
        libx11-xcb1 \
        libxext6 \
        libxcb1 \
        libuuid1 \
        libgssapi-krb5-2 \
        libgcrypt20 \
        libgnutls30 \
        libstdc++6 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

# 全局安装 CLI：镜像内容只由已发布的 npm 包决定，不 COPY 仓库代码（可复现、可审计）。
RUN npm install -g --no-fund --no-audit "@napuketto/cli@${NAPUKETTO_VERSION}" \
    && npm cache clean --force

WORKDIR /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/.napuketto \
    && chown node:node /app/.napuketto

# 配置与数据根显式钉在 /app：容器内没有 package.json，cli 的项目根探测不会命中，
# 必须用环境变量指定（配置优先级见 docs/guides/configuration.md §1、§2）。
ENV NODE_ENV=production \
    NAPKETTO_CONFIG=/app/napuketto.toml \
    NAPKETTO_DATA=/app/.napuketto \
    LANG=C.UTF-8 \
    TZ=Asia/Shanghai

# 默认 OneBot 11 HTTP / WS；Satori、Milky 或改过端口的按需自行 -p 映射
EXPOSE 3000 3001

# 健康 = 至少一个账号的 boot 进程存活（supervisor 会按 autoRestart 重启崩溃账号）。
# 只看 supervisor 存活没有意义：配置校验失败（exit 78）时它也会常驻。
HEALTHCHECK --interval=60s --timeout=5s --start-period=180s --retries=3 \
    CMD node -e "const fs=require('node:fs');const root=process.env.NAPKETTO_DATA||'/app/.napuketto';let ok=false;try{for(const n of fs.readdirSync(root)){try{const s=JSON.parse(fs.readFileSync(root+'/'+n+'/runtime.json','utf8'));if(s.status==='running'){try{process.kill(s.pid,0);ok=true}catch{}}}catch{}}}catch{}process.exit(ok?0:1)"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["napuketto"]
