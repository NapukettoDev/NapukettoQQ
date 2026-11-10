# Linux 原生宿主 smoke（夜间 + 手动）

验证**用户真正装到的发布形态**能不能加载官方 Linux QQ 的 ELF `wrapper.node`。公开仓
CI 检不到私有 `packages/loader/native` 子模块，所以这里**安装 npm 上已发布的**
`@napuketto/loader`（不是从源码构建），直接调它自己的 API。

## 步骤

1. `npm install @napuketto/loader@<版本>`（真实安装形态：`dist` + `native` + `assets/7zip`
   + `qq-releases.json`，带 zod 依赖）
2. 断言包内 `native/build/linux-x64/libnapuketto_stub.so` 存在（**打包回归守卫**：
   0.6.0 曾缺该目录，用户侧 `NAPUTO_LINUX_NATIVE=1` 直接报 stub 未找到）
3. `ensureQqFiles({ dataRoot })` —— 走 loader 自己的发布链路：
   读清单 → 下载官方 deb（loader 内校验 sha256）→ 包内 `7zz` 三层解包 →
   `extractLinuxWrapperFiles` 合成缓存布局 → 返回 `wrapperPath`/`version`
4. `LD_PRELOAD=<stub>:<libgnutls.so.30> node dlopen-check.cjs <wrapper>`：
   真 `process.dlopen`，断言导出 ≥100 且含 `NodeIQQNTWrapperEngine`（3.2.35 实测 104）

一次 smoke 同时覆盖「打包」「清单」「deb 下载 + sha256 + 解包 + 缓存布局」「ELF + dlopen」
四条链路；用 `ensureQqFiles` 而不是 `resolveQqFiles`，是为了避开本机安装探测（开发机上
可能命中 `/mnt/c` 的 Windows QQ，拿到 PE wrapper），保证 clean CI 与本地走同一条路。

对应 `docs/architecture/linux-native-host.md` §10 的「公开 CI 落点」定案：不上 PR 门禁
（单次约 190MB 下载 + 依赖 npm 已发布版本），放 nightly + 手动触发。

> 这条路第一次真实跑（2026-11-10 手动 dispatch）就抓到发布包泄漏 `catalog:` 协议
> （`npm install` 直接 `EUNSUPPORTEDPROTOCOL`）——测发布形态才有这个价值：本地
> `pnpm pack` 会改写 catalog，源码侧怎么测都发现不了。修复见
> [release.md](../../docs/guides/release.md) §5。

## 本地跑

```bash
# 默认 loader=latest；Linux 主机需要：libgnutls30t64（libbugly 隐藏依赖，必须 preload）
#   + libx11-6 / libx11-xcb1 / libxext6 / libxcb1（wrapper.node 的 DT_NEEDED）
#   + libuuid1（arm64 缺 DT_NEEDED）；Ubuntu 24.04 一条命令：
sudo apt-get install -y libgnutls30t64 libuuid1 libx11-6 libx11-xcb1 libxext6 libxcb1
node tooling/linux-native-smoke/smoke.mjs
node tooling/linux-native-smoke/smoke.mjs --loader-version 0.6.1 --work-dir /tmp/smoke-v2

# 校验「待发布」的包：tarball 必须用 pnpm pack 产出
# （npm pack 不会把 workspace 的 `catalog:` 依赖改写成真实版本，安装会报
#  EUNSUPPORTEDPROTOCOL "catalog:"——发布链走的是 pnpm，这里保持一致）
(cd packages/loader && pnpm pack --pack-destination /tmp)
node tooling/linux-native-smoke/smoke.mjs --tarball /tmp/napuketto-loader-0.6.0.tgz
```

WSL 里跑同样适用（真 ELF、真 `wrapper.node`）。失败时看 `[smoke] ERROR` 行的提示：
- 「发布包缺少 Linux stub」→ `packages/loader` 的 `files` 漏了 `native/build/linux-x64`
- 「sha256 不匹配」→ 清单里的 deb 摘要过期（`tooling/qq-releases` 的更新脚本）
- 「dlopen 失败」→ stub / gnutls / GLIBC 环境问题，`ldd wrapper.node` 对照
