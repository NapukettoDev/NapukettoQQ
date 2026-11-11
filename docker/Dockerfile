# syntax=docker/dockerfile:1.7

# NapukettoQQ 官方运行镜像（linux/amd64）
#
# 设计要点：
# - **不内置腾讯二进制**（ADR-019）：官方 Linux deb 由 loader 在首启时下载、解包到
#   数据卷，与原生部署走同一条链路；镜像本身不含 wrapper.node。
# - 需要 glibc 系（Debian）：wrapper.node 不支持 musl/Alpine。
# - 容器以 root 启动入口脚本：校验配置 → 对齐数据卷属主 → setpriv 降权到 node(1000)。
#
# 体积优化（2026-11-11）：
# - 运行阶段刻意用 debian:bookworm-slim，而不是 node:24-bookworm-slim。Node 官方镜像
#   把 node(126MB) 与 npm/corepack(19MB) 放在继承来的层里，事后 rm 只缩小**落地**体积、
#   缩不了**拉取**体积（层数据还在）；这里只从 builder COPY strip 过的 node 与 CLI。
# - strip 去掉 node 的符号表：126MB → 109MB；.dynsym 完整保留（145 个 napi_* 导出），
#   wrapper.node 的 N-API 解析不受影响。
# - ffmpeg/ffprobe 换成 mwader/static-ffmpeg 的纯静态二进制（镜像摘要钉死）：替掉
#   Debian ffmpeg 约 459MB 的动态库闭包（LLVM/Mesa/SDL/flite/…），静态二进制约 270MB。
# - 用 util-linux 自带的 setpriv 替代 gosu（省 2.2MB，少装一个包）。
# - WITH_FFMPEG=false 派生 -slim：默认 tag 保留完整媒体能力，slim 给纯文本 Bot。
#
# 构建（版本缺省 latest；发布工作流会传入精确版本）：
#   docker build -t napukettoqq:local docker/
#   docker build --build-arg NAPUKETTO_VERSION=0.5.17 -t napukettoqq:0.5.17 docker/
#   docker build --build-arg WITH_FFMPEG=false -t napukettoqq:0.5.17-slim docker/

# ==========================================
# 1. 静态 FFmpeg 提取层（钉死版本与摘要）
# ffmpeg 9.0.2，含 libx264 / libx265 / aac / libopus / libvpx / libwebp，OpenSSL 支持 https
# ==========================================
FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg-static

# ==========================================
# 2. Builder：安装已发布的 CLI（独立 prefix，运行阶段整目录 COPY）
# ==========================================
FROM node:24-bookworm-slim AS builder

ARG NAPUKETTO_VERSION=latest

# strip 需要 binutils；它只留在 builder，不进运行镜像
RUN apt-get update \
    && apt-get install -y --no-install-recommends binutils \
    && rm -rf /var/lib/apt/lists/*

# 独立 prefix 安装：/opt/napuketto/{bin,lib} 可整目录拷走，运行阶段不带 npm/corepack。
# npm cache 留在 builder 的 /root/.npm，不进入运行镜像。
RUN npm install -g --no-fund --no-audit --prefix /opt/napuketto "@napuketto/cli@${NAPUKETTO_VERSION}" \
    && npm cache clean --force

# 126MB → 109MB；保留 .dynsym（动态符号表），只删静态符号
RUN strip --strip-unneeded /usr/local/bin/node

# ==========================================
# 3. Runtime：debian slim + 只带运行期必需
# ==========================================
FROM debian:bookworm-slim AS runtime

# 默认带 ffmpeg/ffprobe（完整媒体能力）；-slim 用 --build-arg WITH_FFMPEG=false
ARG WITH_FFMPEG=true

# node 用户与官方 node 镜像保持一致（uid/gid 1000），数据卷属主对齐逻辑不变
RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin node

# wrapper.node 的运行期依赖（详见 docs/guides/operations.md「Linux 原生宿主」）：
#   libx11-6 / libx11-xcb1 / libxext6 / libxcb1 —— 加载期 DT_NEEDED，不需要 X server
#   libgnutls30 —— libbugly 的隐藏依赖（loader 会 LD_PRELOAD）
#   libgssapi-krb5-2 / libgcrypt20 / libuuid1 / libstdc++6 / zlib1g —— 传递依赖
#   ca-certificates —— loader 从腾讯 CDN 下载 deb（https）
#   tzdata —— TZ 生效
# setpriv 在 util-linux 包里（Debian 基础镜像自带），不再安装 gosu。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
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

# strip 过的 node + 已安装的 CLI（含 bin/napuketto 软链）
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /opt/napuketto /opt/napuketto

ENV PATH="/opt/napuketto/bin:${PATH}"

# 按需注入静态 ffmpeg / ffprobe：用 bind mount 从提取层零残留条件拷贝。
# 关闭时该层为空，full / slim 共享前面全部构建缓存。
RUN --mount=from=ffmpeg-static,source=/ffmpeg,target=/tmp/ffmpeg \
    --mount=from=ffmpeg-static,source=/ffprobe,target=/tmp/ffprobe \
    if [ "$WITH_FFMPEG" = "true" ]; then \
        install -m 755 /tmp/ffmpeg /usr/local/bin/ffmpeg \
        && install -m 755 /tmp/ffprobe /usr/local/bin/ffprobe \
        && ffmpeg -version >/dev/null \
        && ffprobe -version >/dev/null; \
    fi

WORKDIR /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 构建期自检：node 能跑（strip 没伤到动态符号）、CLI 能跑
RUN node -v \
    && napuketto --version \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh \
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
