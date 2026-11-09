# Linux 原生宿主 smoke（夜间 + 手动）

验证**用户真正装到的发布形态**能不能加载官方 Linux QQ 的 ELF `wrapper.node`。公开仓
CI 检不到私有 `packages/loader/native` 子模块，所以这里消费 **npm 上已发布的**
`@napuketto/loader` tarball（`files` 自 0.6.x 起含 `native/build/linux-x64`，包里自带
stub 与 `assets/7zip/7zz`），不依赖源码构建。

## 步骤

1. `npm pack @napuketto/loader@<版本>` → 解包 → 断言 `native/build/linux-x64/libnapuketto_stub.so`
   在包里（**打包回归守卫**：0.6.0 曾缺该目录，用户侧 `NAPUTO_LINUX_NATIVE=1` 直接报 stub 未找到）
2. 读包内 `qq-releases.json` 取 linux/x64 条目 → 下载官方 deb（sha256 校验，URL 的
   `/QQNTV2/` 需降为 `/qqntv2/` 否则 403）
3. 包内 `7zz` 三层解包（ar → `data.tar.xz` → `data.tar`）→ `opt/QQ/resources/app/wrapper.node`
4. `LD_PRELOAD=<stub>:<libgnutls.so.30>` 跑 `dlopen-check.cjs`：真 `process.dlopen`，
   断言导出 ≥100 且含 `NodeIQQNTWrapperEngine`（3.2.35 实测 104）

对应 `docs/architecture/linux-native-host.md` §10 的「公开 CI 落点」定案：不上 PR 门禁
（单次约 190MB 下载 + 依赖 npm 已发布版本），放 nightly + 手动触发。

## 本地跑

```bash
# 默认 loader=latest；Linux 主机（Ubuntu 24.04 需 libgnutls30t64）
node tooling/linux-native-smoke/smoke.mjs
node tooling/linux-native-smoke/smoke.mjs --loader-version 0.6.1 --work-dir /tmp/smoke
```

WSL 里跑同样适用（真 ELF、真 `wrapper.node`）。失败时看 `[smoke] ERROR` 行的提示：
- 「发布包缺少 Linux stub」→ `packages/loader` 的 `files` 漏了 `native/build/linux-x64`
- 「sha256 不匹配」→ 清单里的 deb 摘要过期（`tooling/qq-releases` 的更新脚本）
- 「dlopen 失败」→ stub / gnutls / GLIBC 环境问题，`ldd wrapper.node` 对照
