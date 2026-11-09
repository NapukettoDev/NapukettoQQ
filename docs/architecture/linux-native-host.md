# Linux 原生自建宿主研判（ELF + 最小 stub）

> **状态**：研判稿（2026-11-08）。**未定稿，未替代 ADR-019**——现行实现仍是 Linux
> wine + Windows `node.exe`（见 [decisions.md](decisions.md) 的 ADR-019 与
> [runtime.md](runtime.md) §1）。2026-11-08 完成 Stage 0 核心链路实测
> （dlopen / exports / O3 / engine init / getLoginList）；2026-11-09 完成 Stage 0b
> （真实扫码 + 快速登录 + session READY，wrapper 层）、Stage 1 端到端（CLI +
> kernel 平台参数 + loader 原生分支）、Stage 2（deb 下载/解包/缓存管线）、Stage 3
> （消息发送/撤回）与 Stage 3b（arm64 符号 + 解包 + stub 交叉编译的静态核验）。
> X11 运行期、他人消息的实时入站、富媒体发送、arm64 运行期仍未验证，完整
> Stage 0 通过后再按 ADR 规则追加决策。
>
> **结论**：核心加载链路已实测通过，符号层确实比 Windows 简单；但“零 GUI 依赖 /
> 比 Windows 简单得多”只对符号转发成立，实际还漏出 gnutls 这类隐藏依赖。
>
> **核验基线**：官方 Linux QQ `3.2.35`（QQNT `9.9.37`，2026-11-03）amd64 deb；
> arm64 用同版本 `arm64` deb；Node.js `v24.16.0` linux-x64；临时 WSL2 Ubuntu 24.04.3。
> 核验 = 静态分析（ELF dynsym / DT_NEEDED / 字符串 + Node 源码）+ 运行时 spike
> （`LD_PRELOAD`，无 DISPLAY）。

## 1. 结论摘要

- **可行（已实测）**：Linux `wrapper.node` 是 ELF64，undefined 符号在进程全局符号表中
  解析；官方 Linux `node` 已导出全部所需 `napi_*` / `uv_*` / v8 符号。Windows 那 98 个
  PE export forwarder（另有 2 个本地实现）在 Linux 归零。3.2.35 实测 exports = **104**。
- **2 个必需符号 + 1 个可选**：必需 `qq_magic_napi_register` 与
  `_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE`；`PerfTrace` 是运行期 `dlsym`，
  给空实现可消除告警。
- **可以退役 Wine**：不再需要 Wine、Windows 版 `node.exe`（约 30MB 下载）、Windows
  QQ 安装包（约 313MB）、`Z:\` 路径转换、WINEPREFIX/DPAPI；官方 Linux QQ 同时提供
  amd64 / arm64 / loongarch / mips64el。
- **“零 GUI 依赖”仍不成立**：加载期必须能找到 `libX11` / `libX11-xcb` / `libXext`，
  并经 `libbugly` 拉 `libgssapi-krb5` / `libgnutls`、经 `libssh2` 拉 `libgcrypt`。
  无 DISPLAY 的 dlopen / engine init 已实测通过，但 X11 运行期功能（截图等）未测。
- **工程量不在 3 个点**：真正的成本在 deb 包获取与布局、双版本号、平台参数、无头依赖、
  清单/更新链、arm64、CI/发布与 ADR。
- **建议**：Stage 0 核心链路、登录/session READY、消息发送/撤回与 arm64 静态核验
  已通过；下一步补 X11 运行期与 arm64 真机运行，再决定立项。Wine 先保留一个版本
  作为回退，不要直接删除。

## 2. 背景：Windows 为什么需要近百条 forwarder

Windows PE 的导入表（IAT）按“模块名 + 符号名”绑定：`wrapper.node` 的导入表写死了
这些符号来自 `QQNT.dll`。即使 `node.exe` 自己导出了 `napi_*` / `uv_*`，PE 加载器也不会
去 `node.exe` 找。因此现有方案必须：

1. 在 `PATH` 前置一个自研的轻量 `QQNT.dll`（[`native/stub/stub-qqnt.def`](../../packages/loader/native/stub/stub-qqnt.def)）；
2. 把宿主符号转发到 `node.exe`（40 个 `napi_*`、56 个 `uv_*`、1 个 `qq_magic` 别名、
   1 个 v8 mangled，共 98 条转发；stub 定义共 100 条导出）；
3. 另给 2 个 `node.exe` 没有的符号提供本地实现（`IsEnvironmentStopping`、`PerfTrace`）。

Linux 的 ELF 没有这个“按模块名绑定”的限制：`dlopen(wrapper.node)` 时，未定义符号在
全局作用域（主程序 + `RTLD_GLOBAL` 库）里按名字解析。官方 Linux `node` 构建时导出了
自身符号，于是 `napi_*` / `uv_*` 自动命中。对比：

| 维度 | Windows 自建宿主（现行） | Linux 原生自建宿主（候选） |
|---|---|---|
| 目标二进制 | Windows `wrapper.node`（PE/COFF） | Linux `wrapper.node`（ELF64） |
| 符号绑定 | IAT 写死模块名 `QQNT.dll` | 全局符号表按名解析 |
| `napi_*` / `uv_*` | stub 逐项转发到 `node.exe` | 0 行代码，直接解析 |
| 自定义符号 | `qq_magic` + 2 个 C++ 符号 | 2 个必需：`qq_magic` + `IsEnvironmentStopping`；`PerfTrace` 可选（dlsym） |
| 注入方式 | `PATH` 前置 `QQNT.dll` | `LD_PRELOAD` 或 `RTLD_GLOBAL` 加载 `.so` |
| 架构 | 仅 x86_64（Wine + Windows 二进制） | 官方 x64 / arm64 / loongarch / mips64el |
| 额外依赖 | Wine、Windows `node.exe` | X11 / krb5 / gnutls / gcrypt 等系统库，无 Wine |

## 3. 核验方法与基线

- **QQ 包**：官方 Linux 下载配置
  [`linuxConfig.js`](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js)
  （页面 [im.qq.com/linuxqq](https://im.qq.com/linuxqq/index.shtml)）。基线版本
  `3.2.35`，amd64 deb 188,287,504 字节（arm64 deb 208,717,176 字节），内部目录
  `9.9.37`。
- **解包**：`7z x` 三次（deb 本质是 `ar`，内含 `data.tar.xz`），或 `ar x` + `tar -xf`。
- **ELF 分析**：`readelf --dyn-syms --wide`、`readelf -d`、`readelf --version-info`
  （`readelf` 跨架构可用，arm64 结论见 §9.11）。
- **Node 符号**：Node.js `v24.16.0` linux-x64 官方 tar.xz。
- **Node 行为**：`process.dlopen` 的 `flags` 传递与自注册规则，核对 Node
  [`src/node_binding.cc`](https://github.com/nodejs/node/blob/v24.16.0/src/node_binding.cc)。
- **运行时 spike**：临时 WSL2 Ubuntu 24.04.3，`g++ 13`；Node.js `v24.16.0`
  linux-x64；装 `libx11-6` / `libx11-xcb1` / `libxext6` / `libuuid1` /
  `libgssapi-krb5-2` / `libgcrypt20` / `libgnutls30t64`；`DISPLAY` 未设置；
  `LD_PRELOAD=libnapuketto_stub.so:libgnutls.so.30`。
- **未做**：X11 运行期功能（截图、剪贴板等）；他人消息的实时入站；富媒体发送；
  arm64 运行期（arm64 静态核验见 §9.11）。完整 Stage 0 仍需补这些。

> 版本相关数字只用于这次研判；QQ 升级后重跑附录 A 的命令即可重新确认。

## 4. 符号缺口：2 个必需 + 1 个可选

基线 deb 的 `wrapper.node` 共有 641 条 undefined 记录（640 个唯一名），其中：

- `napi_*`：41 个；
- `uv_*`：53 个；
- v8 mangled：1 个（`_ZN2v87Isolate10GetCurrentEv`）；
- node mangled：1 个（`_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE`）；
- 其余是 libc / zlib / X11 / libuuid / libvips / libbugly 等系统或随包库。

Node v24.16.0 导出 145 个 `napi_*`、318 个 `uv_*`、1558 个 v8、5774 个 `node::*`。
上述 41 + 53 + 1 个 v8 符号**全部命中**；前提是 node 为官方或发行版构建（导出符号），
自己编译且 `-fvisibility=hidden` 的 node 不保证。真正缺的只有：

```text
qq_magic_napi_register                              (GLOBAL UND, JUMP_SLOT)
_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE      (GLOBAL UND, JUMP_SLOT)
```

`qq_magic_napi_register` 在 `wrapper.node` 的构造阶段（`.init_array`）被调用，必须解析到
一个把 `napi_module` 交回标准 `napi_module_register` 的实现；`IsEnvironmentStopping`
在停止路径使用，返回 `false` 即可（与 Windows stub 语义一致）。

`PerfTrace` 不在上面的静态 `UND` 表里，但运行期会被 `dlsym("PerfTrace")` 查询；不导出
只会打印 `loadSymbolFromShell: dlsym failed PerfTrace`，不影响加载，但建议给空实现。

### 4.1 不要被这些符号误导

- `OPENSSL_memory_alloc` / `OPENSSL_memory_free` / `OPENSSL_memory_get_size` /
  `sdallocx` / `__gcov_dump` / `__gcov_flush`：`WEAK UND`。ELF 对 weak 的
  `GLOB_DAT` 解析为 0，不阻塞加载。
- `_ZN2nt9wifiphoto...`：`GLOBAL UND`，但是在 36 个 `.so` / `.node` 里没有找到定义，
  且是 `JUMP_SLOT`。默认 `RTLD_LAZY` 下不阻塞加载；**不要为了“尽早报错”把
  `wrapper.node` 改成 `RTLD_NOW`**，否则会在这些符号上失败。该功能（文件桥）若被调用
  会报 symbol lookup error，自建宿主不应触碰。
- `PerfTrace`：运行期 `dlsym("PerfTrace")`，不导出会打印
  `loadSymbolFromShell: dlsym failed PerfTrace`；建议导出空实现（与 Windows stub 一致）。

### 4.2 `process.dlopen` 的两个行为

1. **flags 生效**：POSIX 上 `DLOpen` 把 `flags` 传给 `dlopen(filename, flags)`；默认
   `RTLD_LAZY`。`os.constants.dlopen.RTLD_NOW | RTLD_GLOBAL` 可用。
2. **普通 `.so` 不能直接 `process.dlopen`**：Node 在找不到
   `napi_register_module_v1` / `node_register_module_vN` 时会 `dlclose` 并抛
   `Module did not self-register`。所以“先 `process.dlopen(stub, RTLD_GLOBAL)`”这个
   写法，如果 stub 只是几个符号的普通 `.so`，会在第一步失败、stub 被卸载。

两条可行路径：

- **推荐**：`LD_PRELOAD=libnapuketto_stub.so` 随 node 子进程启动。loader 本来就控制
  子进程 env，stub 不需要 node 头文件，也没有自注册问题；缺点是 `LD_PRELOAD` 会传给
  node 的子进程（对本项目通常无害）。
- **备选**：stub 里加一个 dummy `NAPI_MODULE_INIT`（导出 `napi_register_module_v1`），
  再用 `process.dlopen` + `RTLD_NOW | RTLD_GLOBAL`。更“进程内”，但多一层 Node 行为依赖。

### 4.3 早期研判中需要修正的表述

| 表述 | 核验结果 |
|---|---|
| “只需实现 `qq_magic_napi_register`” | 还需 `node::IsEnvironmentStopping`；`PerfTrace` 建议补空实现 |
| “先 `process.dlopen(stub, RTLD_GLOBAL)` 即可” | 普通 `.so` 会 `Module did not self-register`；需 `LD_PRELOAD` 或 dummy 自注册 |
| “零 GUI 依赖，不需要 Xvfb” | 无 DISPLAY 的 dlopen / engine init 已实测通过，但加载期需要 X11 客户端库；X11 运行期功能未测 |
| “按 `DT_NEEDED` / `ldd` 准备依赖就够” | `libbugly` 还缺 gnutls（有约 70 个 gnutls UND、但没有 `DT_NEEDED`） |
| “AppID 参考 NapCat Releases 的映射” | 用 `major.node` 解析；`package.json` 的映射不是登录 appid |
| “扩充 `qq-extract` / `qq-releases` 即可” | 还涉及扁平布局、`sharp-lib`、双版本、清单 schema |
| “可以退役 `win-node.ts`” | Windows 非 node 宿主仍需要；退的是 `wine.ts` |

## 5. 运行时依赖：不是“零 GUI”

基线 `wrapper.node` 的直接 `DT_NEEDED`：

```text
libpthread.so.0  libvips-cpp.so.42  libX11.so.6  libX11-xcb.so.1
libuuid.so.1     libbugly.so        libz.so.1    libXext.so.6
librt.so.1       libm.so.6          libgcc_s.so.1  libc.so.6
ld-linux-x86-64.so.2
```

传递依赖里：

- `libbugly.so` → `libcrbase.so`、`libunwind-x86_64.so.8`、`libgssapi-krb5.so.2`、
  `libssh2.so.1`；
- `libssh2.so.1` → `libgcrypt.so.20`；
- `libvips-cpp.so.42` 只依赖 `libstdc++` 与 glibc 系（不再拉 glib，随包自包含）。

**隐藏依赖（实测，2026-11-08）**：`libbugly.so` 还引用约 70 个 gnutls 符号，但
`DT_NEEDED` 里**没有** `libgnutls`；其中 `gnutls_free` 是 `GLOB_DAT`，加载期就必须解析。
标准 node 进程里没人加载 gnutls，于是 `dlopen(wrapper.node)` 直接失败：

```text
libbugly.so: undefined symbol: gnutls_free
```

`ldd` / `DT_NEEDED` 闭包都发现不了它（库本身没声明依赖）。解决：把系统的
`libgnutls.so.30` 一并 `LD_PRELOAD`（或让宿主进程提前用 `RTLD_GLOBAL` 加载）。
Ubuntu 24.04 包名是 `libgnutls30t64`，Debian 12 是 `libgnutls30`。

因此：

- **无 DISPLAY 可以跑（已实测到 engine init / getLoginList）**，但不是“零 GUI 依赖”：
  加载期必须能找到 `libX11.so.6` / `libX11-xcb.so.1` / `libXext.so.6`；
  `node:24-slim` 这类镜像默认没有，必须显式安装。
- **运行期是否碰 X11 仍需实测**：`wrapper.node` 里有 `XOpenDisplay` 引用（截图/剪贴板
  一类能力）；init 阶段没有崩，不代表这些功能在无 DISPLAY 下可用。
- **glibc 基线**：`wrapper.node` 最高需要 `GLIBC_2.17`；Node v24 最高 `GLIBC_2.28`。
  实际下限由 Node 决定，约 Debian 10 / Ubuntu 20.04 起；musl（Alpine）不支持。
- **Docker 依赖参考**（Debian/Ubuntu，按实际镜像校验）：

```text
libx11-6 libx11-xcb1 libxext6 libxcb1 libuuid1
libgssapi-krb5-2 libgcrypt20 libgnutls30 libstdc++6 zlib1g
```

> Ubuntu 24.04 的 gnutls 包名是 `libgnutls30t64`；`LD_PRELOAD` 路径通常是
> `/usr/lib/x86_64-linux-gnu/libgnutls.so.30`（arm64 为
> `/usr/lib/aarch64-linux-gnu/libgnutls.so.30`）。

## 6. 包获取与布局

Linux QQ 的 deb 安装后是扁平布局：

```text
/opt/QQ/resources/app/wrapper.node     # 152MB
/opt/QQ/resources/app/major.node       # 112MB
/opt/QQ/resources/app/sharp-lib/libvips-cpp.so.42
/opt/QQ/resources/app/libbugly.so
/opt/QQ/resources/app/libcrbase.so
...
```

**没有** Windows 的 `versions/<版本>/resources/app/` 层级。而 kernel 的 ADR-018 路径与
loader 的 `resolveFromRoot` 都按 Windows 结构解析。两个选择：

1. **缓存里合成 Windows 同构路径**（推荐，改动最小）：
   `<数据根>/qq-files/<版本>/versions/<版本>/resources/app/{wrapper.node,major.node,...}`。
   kernel 的 `resolveWrapperPath` 不用改。
2. 让 kernel 同时支持扁平布局。改动面更大，且会碰 ADR-018。

提取器不能只加 `.so` 扩展名：现有 [`qq-extract.ts`](../../packages/loader/src/qq-extract.ts)
只收顶层 `.node` / `.dll`，`lastIndexOf(".")` 还会把 `libfoo.so.1` 当成扩展名 `.1`；
`sharp-lib/` 子目录也会被跳过。Linux 分支需要：

- 保留 `sharp-lib/`（`wrapper.node` 的 RUNPATH 是 `$ORIGIN:$ORIGIN/sharp-lib`）；
- 收 `*.so` 与 `*.so.*`；
- 至少带上 `libbugly.so`、`libcrbase.so`、`libunwind*.so*`、`libssh2.so.1`；
  `libssl` / `libcrypto` 属于随包其他模块，不在 wrapper 的闭包里，可不带。

**已落地（2026-11-09 Stage 2）**：`extractLinuxWrapperFiles` 按上述白名单提取
（另有 `pub.key` / `cacert.pem` / `package.json` / `application.json` 四个小文件）；
`extractDebInstaller` 用内置 `7zz` 三层解包（`deb(ar)` → `data.tar.xz` →
`data.tar` → `opt/QQ/resources/app`），不依赖 `dpkg-deb`，中间产物解完即删；
`NAPUTO_LINUX_NATIVE=1` 时定位阶段校验 wrapper 为 ELF，误指向 Windows 安装立即报错。

下载侧：

- 官方配置是独立的 `linuxConfig.js`（不是 Windows 用的那份 rainbow 配置）；x64 /
  arm64 提供 deb、rpm、AppImage，loongarch / mips64el 以 deb 为主。
  实测地址：
  `https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/linuxConfig.js`
  （`x64DownloadUrl.deb` / `armDownloadUrl.deb` / `updateDate`）。
- URL 路径段 `/QQNTV2/` 大写会被边缘 WAF 403，改成小写 `/qqntv2/` 即 200——现有
  `normalizeDownloadUrl` 已覆盖。
- **优先 deb，不用 AppImage**：AppImage 需要 FUSE 或 `unsquashfs`，7-Zip 不支持
  squashfs；deb 用 7z / ar 即可。
- **清单已升级 schema 2（2026-11-09）**：条目新增 `platform`（缺省 `win32`）、
  `arch`（缺省 `x64`）、`coreVersion`；`version` 是缓存目录名 / `app_version`
  （Linux 用客户端版本 `3.2.35-54395`，core 版本记在 `coreVersion: "9.9.37"`）。
  基线 x64 deb：`QQ_3.2.35_261103_amd64_01.deb`，188,287,504 字节，
  sha256 `7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac`。
  cron 目前仍只自动维护 Windows 条目，Linux 新版本暂由手工 PR 补（每日下载
  188MB×2 算 sha256 不划算，后续可按 ETag 缓存）。

## 7. 平台参数与版本：两套版本号

基线 Linux QQ 的 `major.node` 内嵌：

```text
QQAppId/537403759
V1_LNX_NQ_3.2.35_54395_GW_B
```

`resources/app/package.json` 的 `version` 是 `3.2.35-54395`，另有平台 appid 映射
（`linux: 537391511`）——**不要拿它当登录 appid**；基线 Windows 9.9.33 的
`package.json` 没有这个映射，登录一直用的是 `major.node` 里的 appid。因此：

- appid 继续走 `parseAppidFromMajor`，不需要外部维护的 AppID 映射表；NapCat 也是从
  `major.node` 解析。
- **qua 建议直接从 `major.node` 扫描** `V1_(WIN|LNX|MAC)_NQ_..._GW_B`，而不是拼接。
  现有 [`wrapper-config.ts`](../../packages/kernel/src/wrapper/wrapper-config.ts) 拼的是
  `V1_WIN_NQ_${fullVersion}_${build}_GW_B`，在 Windows 上会得到带连字符的
  `V1_WIN_NQ_9.9.33-52230_52230_GW_B`，与 `major.node` 的
  `V1_WIN_NQ_9.9.33_52230_GW_B` 不一致；登录能过说明服务端不严，但 Linux 不应继续赌。
- **两个版本号**：`3.2.35-54395` 是客户端版本（`app_version` / `clientVer` 用；
  `major.node` 里的 qua 也带这组数字），也是缓存 key 与 `NAPUTO_QQ_VERSION` 的建议值；
  `9.9.37` 是 QQNT 核心版本（展示 / 清单 / 下载路径用）。现有 kernel 把二者混成一个
  `fullVersion`；Linux 必须拆开。缓存 key 建议用客户端版本，清单同时记录两者。
- **platform 参数**：`buildEngineConfig` / `buildSessionConfig` /
  `defaultEngineConfig` 里 `KWINDOWS`、`rdeliveryConfig.platform` 等至少 4～5 处要按
  `process.platform` 切到 `KLINUX`（`PlatformType` 已有 `KLINUX = 5`）。
- **9.9.37 升级验证**：Linux 3.2.35 对应 QQNT 9.9.37，比仓库验证过的 9.9.33 新；Linux
  没有旧版可退，等于强制做一次 9.9.37 的 kernel 兼容验证（Windows 清单里 9.9.36 /
  9.9.37 的 appid 还是 0，尚未探测）。

其他平台相关点：

- **本地安装探测**：Linux 原生分支已识别 `/opt/QQ`（deb 扁平布局：
  `<根>/qq` + `<根>/resources/app/wrapper.node`，`NAPUTO_QQ_DIR` 可覆盖，版本取自
  `resources/app/package.json`），优先于数据根缓存，省掉 190MB deb 下载（§9.13）。
  探测自带 ELF 魔数校验，不会把 `/mnt/c/.../QQNT` 下的 Windows PE `wrapper.node`
  当成 Linux 文件（原生 `dlopen` 会报 invalid ELF header）。
- **宿主是 Bun 时**：与 Windows 同理，wrapper 需要真 node 的 `napi_*`；Linux 分支要有
  `which node` 之类解析，现有 `findSystemNode` 用的是 Windows `where`。
- **数据目录**：建议把 `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` 收敛到数据根，
  避免原生层向用户目录写日志/缓存；`~/.config/QQ` 一类路径要显式覆盖。Stage 0b 实测
  Bugly 会无条件写 `$HOME/.config/QQ/crash_files/`（`desktopGlobalPath` 不影响它），
  自建宿主必须处理这个副作用。

## 8. 工程改造清单

| 区域 | 改动 |
|---|---|
| `packages/loader` | Linux 平台分支（不再 wine）；`.so` stub 查找与 `LD_PRELOAD`/`RTLD_GLOBAL`；deb 解包与缓存布局；`qq-releases` 平台字段；Linux 本地探测；Bun 宿主的 node 解析 |
| `packages/kernel` | `platform_type` / `qua` / session `platform` 平台化；双版本号；`major.node` qua 解析；Linux 数据目录回退 |
| `native/`（私有 submodule） | 新增 `stub-linux.cc`（2 必需 + `PerfTrace`）+ `linux-x64` / `linux-arm64` 预编译 `.so`；`files` 字段与发布打包守卫 |
| 发布链 | `release.yml` 的 native 打包守卫要同时检查 Linux `.so`；changeset（loader/kernel minor） |
| CI | gate/windows 不检私有 submodule，真 Linux smoke 不能直接跑；放到 release / self-hosted，或消费已发布 loader 包 |
| 文档 | Stage 0 通过后新增 ADR（替代 ADR-019 的 Linux 分支，Windows 不动），同步 overview/runtime/loader design |

注意：**`win-node.ts` 不能整体删除**。Windows 上非 node 宿主（Bun / Koishi CE）仍走
`resolveWinHostNode` → `ensureWinNode` 下载 Windows `node.exe`；能退役的是 `wine.ts`
及其 Linux 路径转换。

## 9. Stage 0 验证方案（核心链路已实测）

目标：在不改主链路的前提下，确认“标准 Linux node + 2 必需 + `PerfTrace` 的 stub +
Linux `wrapper.node`”能加载、能初始化 engine、无 DISPLAY 不崩。

### 9.1 最小 stub

```cpp
// stub-linux.cc：不需要 node 头文件
struct napi_module;
extern "C" void napi_module_register(struct napi_module*);

// 把腾讯的魔数注册桥接回标准 N-API 注册
extern "C" void qq_magic_napi_register(struct napi_module* mod) {
    napi_module_register(mod);
}

// node::IsEnvironmentStopping(v8::Isolate*)：与 Windows stub 同语义
namespace v8 { class Isolate; }
namespace node {
bool IsEnvironmentStopping(v8::Isolate*) { return false; }
}

// wrapper.node 运行期 dlsym("PerfTrace")，空实现消除加载告警
extern "C" void PerfTrace(void) {}
```

```bash
g++ -shared -fPIC -O2 stub-linux.cc -o libnapuketto_stub.so
```

如果坚持用 `process.dlopen` 加载 stub，还需加 dummy 自注册（否则 `Module did not
self-register`）：

```cpp
#include <node_api.h>
NAPI_MODULE_INIT() { return exports; }
```

### 9.2 跑起来

```bash
# 1) 下载（注意 /qqntv2/ 小写；大写会被 WAF 403）
curl -L -o linuxqq.deb \
  https://qqdl.gtimg.cn/qqfile/qqntv2/9.9.37/release/816b3c79/QQ_3.2.35_261103_amd64_01.deb

# 2) 解包（7z 或 ar + tar）
7z x linuxqq.deb -oqq
7z x qq/data.tar.xz -oqq/root

# 3) 系统依赖（Ubuntu 24.04；Debian 12 用 libgnutls30）
apt-get install -y libx11-6 libx11-xcb1 libxext6 libuuid1 libstdc++6 zlib1g \
  libgssapi-krb5-2 libgcrypt20 libgnutls30t64

# 4) 无 DISPLAY 加载（gnutls 必须一起 preload，否则 libbugly 的 gnutls_free 解析失败）
W=$PWD/qq/root/opt/QQ/resources/app/wrapper.node \
LD_PRELOAD=$PWD/libnapuketto_stub.so:/usr/lib/x86_64-linux-gnu/libgnutls.so.30 \
node -e 'const m={exports:{}};process.dlopen(m,process.env.W);
console.log(Object.keys(m.exports).length);'
```

预期：exports **104**（3.2.35 / 9.9.37 基线），至少包含
`NodeIKernelLoginService`、`NodeIQQNTWrapperEngine`、`NodeIO3MiscService`。

### 9.3 实测结果（2026-11-08）

环境：临时 WSL2 Ubuntu 24.04.3；Node.js `v24.16.0` linux-x64；Linux QQ `3.2.35` /
QQNT `9.9.37`；`DISPLAY` 未设置；`g++ 13`。

| 项 | 结果 |
|---|---|
| `dlopen(wrapper.node)` | **exports = 104** |
| 关键服务 | `NodeIQQNTWrapperEngine` / `NodeIKernelLoginService` / `NodeIO3MiscService` 均在 |
| O3 激活 | `addO3MiscListener` 成功 |
| `engine.initWithDeskTopConfig` | `KLINUX` + `V1_LNX_NQ_3.2.35_54395_GW_B` + `app_version=3.2.35-54395` → OK，进程存活 |
| `loginService.initConfig` + `getLoginList` | `{"result":0,"LocalLoginInfoList":[]}` |
| 数据路径 | MMKV 落在 `<data>/nt_qq/global/nt_data/mmkv` |
| 反例：只 preload stub（不 preload gnutls） | `libbugly.so: undefined symbol: gnutls_free` |
| 反例：缺 `PerfTrace` | `loadSymbolFromShell: dlsym failed PerfTrace`（不阻塞） |
| 无 DISPLAY | 上述加载/初始化均通过；X11 运行期功能未测 |

实测配置要点：engine `platform_type=5`、`app_type=4`、`app_version=3.2.35-54395`、
`qua=V1_LNX_NQ_3.2.35_54395_GW_B`、`desktopGlobalPath=<data>/nt_qq/global`；
login `appid=537403759`、`platVer=Linux 6.18.33.2-2`、`clientVer=3.2.35-54395`、
`commonPath=<data>/nt_qq/global`、`externalVersion=false`。以上为临时 spike 脚本结果，
未入库；复现按 §9.2 + 本段配置。

### 9.4 验收标准

- `ldd qq/root/opt/QQ/resources/app/wrapper.node` 无 `not found`——注意这是必要但
  不充分条件：`libbugly` 的 gnutls 是隐藏依赖，`ldd` 看不出来，必须实际 `dlopen`；
- 无 DISPLAY 下 `dlopen` 成功，exports **104**（3.2.35 基线）且关键 service 正常；
- `NodeIO3MiscService.get().addO3MiscListener(...)` 后 `getLoginList` 能 resolve
  （`result:0`，无账号时列表为空即正常）；
- 用 `KLINUX` + `major.node` 解析出的 qua 调 `initWithDeskTopConfig`，不崩、不挂；
- X11 运行期功能（截图 / 剪贴板等）单独验证；若崩溃，评估 Xvfb / X11 stub，再决定
  “零 Xvfb”是否成立。

### 9.5 常见失败与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `libX11.so.6: cannot open shared object file` | 缺 X11 客户端库 | 装 libx11-6 / libx11-xcb1 / libxext6 |
| `libbugly.so: undefined symbol: gnutls_free` | libbugly 缺 gnutls 且无 `DT_NEEDED` | `LD_PRELOAD` 系统 `libgnutls.so.30`（Ubuntu 24.04 装 `libgnutls30t64`） |
| `loadSymbolFromShell: dlsym failed PerfTrace` | stub 未导出 `PerfTrace` | 加 `extern "C" void PerfTrace(void) {}`（不阻塞加载） |
| `undefined symbol: qq_magic_napi_register` | stub 未生效/顺序不对 | 检查 `LD_PRELOAD` 是否生效（或按 §4.2 用 RTLD_GLOBAL + dummy 自注册） |
| `Module did not self-register` | 用 `process.dlopen` 加载普通 `.so` | 改用 `LD_PRELOAD`，或加 dummy `NAPI_MODULE_INIT` |
| `invalid ELF header` | 误选了 Windows `/mnt/c` 的 PE wrapper | 平台过滤/ELF 魔数校验 |
| 无 DISPLAY 时崩在 `XOpenDisplay` | 运行期 X11 依赖 | Xvfb 或 X11 stub；记录为约束 |

### 9.6 后续阶段

1. **Stage 0b**：真实 QR / 快速登录 + session READY + 9.9.37 kernel 兼容验证；未过不立项；
2. **Stage 1**：stub 入私有 native（x64/arm64），loader Linux 分支与参数化；
3. **Stage 2**：deb 管道、清单平台字段、缓存布局、提取器；
4. **Stage 3**：kernel 平台参数、双版本、登录 READY、文档/ADR/CI；
5. **Stage 4**：退役 wine（先保留一个版本的回退开关），真实登录/风控验证后再删。

### 9.7 Stage 0b 实测：扫码 → 快速登录 → session READY（2026-11-09）

同一环境（WSL2 Ubuntu 24.04.3 / Node v24.16.0 / Linux QQ 3.2.35 / QQNT 9.9.37 /
`LD_PRELOAD=stub:libgnutls.so.30`，无 DISPLAY）：

| 步骤 | 结果 |
|---|---|
| QR 登录 | `onQRCodeSessionUserScaned` → `onQRCodeLoginSucceed`（uin/uid/nick 正常） |
| 二维码过期 | `onQRCodeSessionFailed [1,3]` 后重新 `getQRCodePicture()` 可刷新，无需重启进程 |
| 再次启动 + 快速登录 | `getLoginList` 返回 1 条 `isQuickLogin:true`；`quickLoginWithUin` → `result:"0"`、`loginErrorInfo.errMsg:""`，并触发 `onQRCodeLoginSucceed` |
| session 创建顺序 | `StartupSessionWrapper.create()` + `getNTWrapperSession("nt_1")` **在 engine init 之前**，两者均成功 |
| session.init | `KLINUX`、`platform=5`、`rdeliveryConfig.platform=5`、appid `537403759`、`platVer=Linux <release>`、guid 来自 `getMachineGuid` → 不抛错 |
| init 完成信号 | `onOpentelemetryInit {is_init:true}` 与 `onSessionInitComplete 0` 都触发（创建顺序生效） |
| READY | `getMsgService()` 立即非空；Msg/Group/Buddy/Ticket/Profile/RichMedia/RecentContact 七个 service 均非空 |
| 资料自检 | `getProfileService().getUserDetailInfoByUin()` → `result:0`，能读到 self 昵称/uid |

结论：**wrapper 层登录 + session READY 已实测通过**（含 9.9.37 核心）。

新发现/注意：

- 快速登录也会触发 `onQRCodeLoginSucceed`（`mainAccount` 为空）；不能把该事件当成
  “必须扫码”的唯一信号，成功判定以 `quickLoginWithUin` 的 `errMsg` 为准。
- Bugly 初始化会把崩溃目录写到 `$HOME/.config/QQ/crash_files/`，不受
  `desktopGlobalPath` 控制；自建宿主需要收敛 `HOME`/`XDG_*`，否则污染用户目录。
- `startupSession.start()` 后 `onMSFStatusChange [1,0]`、`onNTSessionCreate 0` 先到，
  READY 判定仍以 `getMsgService` 非空为准（与现有 kernel 一致）。
- 本次只是 wrapper 层 spike；真 kernel 端到端见 §9.8（Stage 1 已跑通）。

### 9.8 Stage 1 端到端（2026-11-09，CLI + kernel）

kernel 平台参数化与 loader `NAPUTO_LINUX_NATIVE=1` 分支合入后，用真 CLI 跑通：

| 项 | 结果 |
|---|---|
| 启动方式 | 系统 node 直接跑 `apps/cli/dist/index.mjs`；无 wine、无 Windows node、无 `Z:\` |
| QQ 文件 | `NAPUTO_QQ_FILES` 指向 `<数据根>/qq-files/3.2.35-54395`（`versions/.../resources/app` 软链到解包目录） |
| 预加载 | `LD_PRELOAD=<stub>.so:<libgnutls>.so.30`（loader 自动装配） |
| 快速登录 | `bootstrap: 登录成功 uin=… nick=PaperKoi` |
| session | `激活 session init + start 完成` → `QQ session 就绪（getMsgService 可用）` |
| 适配器 / 事件 | `onebot11 adapter started`、`satori adapter started`；启动即收到离线消息历史 |
| 优雅退出 | SIGTERM → `收到退出信号` → 子进程 code=0 |

新发现（Stage 2/3 要处理）：

- ~~commonPath 落在 `$HOME`~~ **已修（2026-11-09）**：kernel 的 `resolveQqUserDataRoot`
  改为按平台分流——Windows 仍走 `getNTUserDataInfoConfig()`，Linux 直接用数据根，
  QQ 数据固定 `<数据根>/nt_qq`（多账号共享，与 Windows QQ 数据目录语义一致）。
  loader 把 `NAPUTO_DATA_ROOT` 注入 `BootEnv.dataRoot`，并让 kernel 的 `paths.dataRoot`
  是全局数据根（账号目录仍是 `<数据根>/<uin>`）。复测：删掉
  `$HOME/Documents/Tencent Files/nt_qq` 软链后快速登录仍成功，`commonPath` 为
  `/tmp/ntqq2/nt_qq/global`，`$HOME/Documents/Tencent Files` 保持空目录。
  迁移已有 QQ 数据时把 `nt_qq` 拷到数据根即可。
- Bugly 依旧写 `$HOME/.config/QQ/crash_files/`（§7 已记）。
- `setStatus` 报 `cs return ok, but response empty!`，Login 桥未注册；不影响登录与
  消息接收，属于既有兼容性问题。

### 9.9 Stage 2：deb 管线实测（2026-11-09）

用官方 deb（`QQ_3.2.35_261103_amd64_01.deb`，188,287,504 字节）跑真实管线：

| 项 | 结果 |
|---|---|
| `extractDebInstaller`（内置 7zz 三层解包） | 5.5s 完成，`data.tar`（~642MB）等中间产物解完即删 |
| `extractLinuxWrapperFiles` | 65ms；缓存布局 `<数据根>/qq-files/3.2.35-54395/versions/3.2.35-54395/resources/app/` |
| 产物 | `wrapper.node` 152,431,496 / `major.node` 111,947,856 / `libbugly.so` / `libunwind.so.8` / `sharp-lib/libvips-cpp.so.42` 齐全 |
| CLI（用该缓存作 `NAPUTO_QQ_FILES`） | 快速登录成功 → session READY → 适配器启动 → SIGTERM code=0 |
| 清单 | schema 2 已含 Linux x64 条目；sha256 与官方文件一致（`7de0386…f9ac`） |

未覆盖：真实网络下载（`downloadFile` 的 https 链路未在 CI 跑，但 URL/sha256 已用官方
文件核对）；Linux 本地 `/opt/QQ` 安装探测；arm64 条目与符号核验。

### 9.10 Stage 3：消息发送/撤回实测（2026-11-09）

环境同 §9.9（WSL2 Ubuntu 24.04 / Node v24.16.0 / 无 DISPLAY / `NAPUTO_LINUX_NATIVE=1`），
真 CLI + OneBot 11 HTTP，对开发群（1101729931）走完整消息动作链：

| 项 | 结果 |
|---|---|
| `send_msg`（文本） | retcode 0、424ms，返回 `message_id` |
| 真实送达 | `get_group_msg_history` 能查到该文本 |
| `get_msg` | retcode 0，返回原文（**修复前** retcode 102「不存在或已被撤回」） |
| `delete_msg`（撤回） | retcode 0；历史里该消息内容清空（撤回墓碑），撤回真生效 |
| id 一致性 | 发送返回 / 历史 / `get_msg` / `delete_msg` 是同一个 `message_id` |
| 自身消息事件 | WS 订阅窗口内 0 条——同进程发送不产生 `onRecvMsg`，与 Windows 一致 |

**发现并修复（kernel，详见 `packages/kernel/docs/design.md` §12）**：Linux wrapper 落库的
`msgId` 与 `generateMsgUniqueId()` 生成的不一致——生成的 id 只出现在确认事件的
`guildId` 字段上（`confirmSend` 靠它判成功，所以发送判定没坏）。于是 `send_msg` 返回的
`message_id` 拿去 `get_msg`/`delete_msg` 查不到（历史里同一条消息是另一个 id）。
修复：`confirmSend` 把命中的 `RawMessage` 交回，`sendMessage` 优先返回它的 `msgId`，
缺失才回退生成值；Windows 侧两者本就相同，行为不变。

未覆盖：他人消息的**实时入站事件**（需要第二个账号发消息；离线历史事件已在 Stage 1
验证）；富媒体（图片/语音/文件）发送未实测。

### 9.11 Stage 3b：arm64 符号 / 解包 / stub 静态核验（2026-11-09）

arm64 deb（`QQ_3.2.35_261103_arm64_01.deb`，208,717,176 字节，sha256
`5f93ea62…43cf2`）走与 x64 相同的工具链：`readelf` 静态分析 + loader 真提取管线 +
`aarch64-linux-gnu-g++` 交叉编译 stub。**运行期未验证**（需要 arm64 机器 / qemu +
arm64 node）。

| 项 | x64 | arm64 |
|---|---|---|
| deb 字节 | 188,287,504 | 208,717,176 |
| `wrapper.node` | 152,431,496 | 147,183,032 |
| `major.node` | 111,947,856 | 112,209,336 |
| UND 记录 / 唯一名 | 641 / 640 | 656 / 655 |
| `napi_*` / `uv_*` / v8 / node | 41 / 53 / 1 / 1 | 41 / 53 / 1 / 1 |
| `qq_magic` / `IsEnvironmentStopping` / `PerfTrace(静态)` | 1 / 1 / 0 | 1 / 1 / 0 |
| 静态导出（GLOBAL DEFINED） | 381 | 385 |
| `libbugly.so` gnutls UND（无 `DT_NEEDED`） | 71 | 71 |
| 解包 + 提取 | 5.5s / 65ms | 6.6s / 67ms，20 文件 / 288,021,818 字节 |
| stub 交叉编译 | `build/linux-x64` | `build/linux-arm64`，69,424 字节 |

**结论**

1. **缺口集完全一致**：arm64 也只是缺同样的 2 个必需符号 + 运行期 `PerfTrace`；两份
   `wrapper.node` 的 `napi_*` / `uv_*` / v8 / node 计数逐一相同，`libbugly` 的 gnutls
   隐藏依赖也相同（71 个 UND、无 `DT_NEEDED`）→ arm64 同样要预加载
   `libgnutls.so.30`。stub **同一份源码**交叉编译即可：产物导出恰好 3 个符号
   （`qq_magic_napi_register`、`_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE`、
   `PerfTrace`），无 `DT_NEEDED`，只 UND `napi_module_register`（由 node 提供）。
2. UND 差异只在架构细节：arm64 多出的 15 条是 glibc 2.17 版本后缀与 aarch64 的
   `__addtf3` / `__multf3` / `__clear_cache` / `__getauxval` 等 GCC/内核辅助符号，
   都来自系统 libc / libgcc，不是新缺口。
3. **arm64 额外缺 `libuuid`**（新发现）：两架构都引用 `uuid_generate` /
   `uuid_unparse`，但只有 x64 的 `DT_NEEDED` 里有 `libuuid.so.1`；arm64 既没
   `DT_NEEDED` 也没随包库（`liblinux_compat.so` 不导出 uuid/gnutls）。惰性绑定时
   加载能过，**首次调用会 symbol lookup error** → arm64 宿主需要额外预加载系统
   `libuuid.so.1`（与 gnutls 同类处理）。
4. **解包管线对 arm64 直接可用**：真 loader 管线（`extractDebInstaller` +
   `extractLinuxWrapperFiles`）提取出 20 个文件，arm64 专有文件名都在白名单覆盖内
   （`libparent-ipc-core-arm64.so`、`libunwind-aarch64.so.8`、
   `sharp-linux-arm64v8.node`），`sharp-lib/libvips-cpp.so.42` 保留。
5. 运行时仍待验证：登录 / session READY / 收发在 arm64 上未跑过；stub 的 arm64
   产物尚未进私有 `native/`（`build/linux-arm64/` 只是本机交叉编译产物），清单里
   也还没有 arm64 条目——按既定策略，arm64 作为独立交付项，等真机验证后再登记
   （避免给用户一个未验证的下载入口）。

### 9.13 Stage 3d：本地 deb 安装（扁平 `/opt/QQ`）探测（2026-11-09）

**问题**：deb 装出来的 QQ 没有 Windows 的 `versions/<版本>/resources/app/` 结构，
是扁平的 `/opt/QQ/{qq,resources/app/...}`；此前 loader 只认 `versions/` 布局，Linux
用户即使本机装了 QQ 也会被当成「未安装」，白下 190MB deb。

**做法**：`resolveQqFiles` 新增 L1b（仅 Linux 原生分支）：`NAPUTO_QQ_DIR` > `/opt/QQ`，
校验 `resources/app/wrapper.node` 是 ELF、版本取自 `resources/app/package.json`
（缺失/非法即跳过，不猜版本）；命中返回 `source: "local"`、`qqPath = <根>/qq`。
Wine 分支不启用（要 PE）。

**实测（WSL2，真 x64 ELF wrapper，数据根拷贝去掉 `qq-files` 以排除 L2 命中）**：

| 项 | 结果 |
|---|---|
| 合成扁平安装 | `/tmp/opt-qq/qq` + `/tmp/opt-qq/resources/app/*`（来自 Stage 2 解包产物） |
| 实际加载路径 | `/proc/<self-host pid>/maps` → `/tmp/opt-qq/resources/app/wrapper.node` |
| 数据根 `qq-files/` | 未生成（既未下载也未用缓存） |
| kernel 装配 | `wrapper 装配完成 … version=3.2.35-54395` |
| 登录 | 快速登录成功（同一账号会话） |
| 退出 | SIGTERM → `code=0` 优雅退出 |

**边界**：只覆盖 deb 安装的扁平布局；AppImage / 手工解包到任意目录走
`NAPUTO_QQ_DIR` 显式指定。版本号仍只从 `package.json` 取，不从 `wrapper.node`
猜。

## 10. 决策建议与待决事项

**建议**：

- 把 Linux 原生 ELF 宿主作为 Linux 的目标路线；Windows 保持现有 PE stub 不动。
- Stage 0 核心链路与登录/session READY 已通过；完整 Stage 0（X11 运行期 / 消息收发 /
  arm64）通过前不排期、不改 ADR、不删 Wine；通过后新增 ADR，并保留一个版本的 Wine
  回退（`NAPUTO_LINUX_NATIVE` 开关）。
- arm64 在 x64 验证通过后再作为独立交付项，不随首版承诺。

**拟新增 ADR 草案（完整 Stage 0 通过后写入）**：

> Linux 默认走原生 ELF 自建宿主：标准 Linux `node` + 2 必需符号 + `PerfTrace` 的
> stub `.so`，`dlopen` 官方 Linux `wrapper.node`；Windows 保持 PE stub。Wine 仅保留
> 一个版本的兼容回退，随后删除。理由：ELF 全局符号表消除近百条 forwarder；去掉
> Wine / Windows node.exe / WINEPREFIX；官方 Linux QQ 提供 x64/arm64。本条替代
> ADR-019 的 Linux 运行方式部分，保留其“不内置腾讯二进制”原则。

**已验证（2026-11-08 / 2026-11-09）**：`dlopen` + exports=104、O3 激活、无 DISPLAY、
KLINUX engine init、`getLoginList`、gnutls 隐藏依赖、`PerfTrace` 运行期 dlsym；Stage 0b
另验证扫码登录、快速登录（`isQuickLogin` + `errMsg` 空）、session 创建顺序、
`onOpentelemetryInit` / `onSessionInitComplete`、`getMsgService` READY、七个核心
service 与 self 资料读取；Stage 1 用真 CLI 跑通快速登录 → session READY → 适配器启动
→ 收到离线消息 → SIGTERM 优雅退出（code=0），全程无 wine；Stage 2 用官方 deb 跑通
三层解包 + 缓存布局，并以该缓存再次完成登录 → READY → 适配器启动 → code=0；Stage 3
走 OneBot 11 动作链实测 `send_msg` → `get_group_msg_history` 可见 → `get_msg` →
`delete_msg` 撤回全部成功（同时修掉 Linux 下发送返回 id 与历史 id 不一致的缺陷）；
Stage 3b 对 arm64 做静态核验：缺口集与 x64 逐一相同（41 `napi_*` / 53 `uv_*` / 1 v8 /
1 node / 2 必需 + `PerfTrace`）、`libbugly` 同样有 71 个 gnutls UND 且无 `DT_NEEDED`、
真 loader 管线可提取 arm64 deb（20 文件 / 288MB）、stub 用同一份源码交叉编译出 3 符号
无依赖的 `.so`；同时发现 arm64 缺 `libuuid` 的 `DT_NEEDED`（需额外预加载）。

**待决/待验证**：

- X11 运行期功能（截图 / 剪贴板等）；init 阶段已通过，但这些功能未测。
- 消息**发送 + 撤回已实测通过**（§9.10）；未覆盖他人消息的实时入站事件（需第二个账号）
  与富媒体发送。
- arm64 符号与解包**已静态核验**（§9.11）：缺口集与 x64 一致、stub 可交叉编译、
  真 loader 管线可提取；**运行期未验证**（需 arm64 机器）。stub 的 arm64 产物尚未进
  私有 `native/`，清单也尚无 arm64 条目——等真机验证后再登记。
- arm64 需要额外预加载系统 `libuuid.so.1`（`uuid_generate` / `uuid_unparse` 是
  lazy UND 且无 `DT_NEEDED`），x64 靠 `DT_NEEDED` 自动解析。
- Linux 本地 `/opt/QQ` 扁平安装探测（当前只认 `versions/` 缓存布局；Stage 3d 已实现，
  见 §9.13）。
- 公开 CI 无法检私有 submodule，真 smoke 放哪里（release / self-hosted / 已发布包）。
- 是否用 dummy `libbugly.so` 去掉 krb5 / gnutls / gcrypt 依赖（可减依赖，但有行为风险，
  暂不建议）。
- Bugly 固定写 `$HOME/.config/QQ/crash_files/`，需要 `HOME`/`XDG_*` 收敛方案。

## 附录 A：核验数据与重跑命令

基线数据（Linux QQ 3.2.35 / QQNT 9.9.37，amd64）：

| 项 | 值 |
|---|---|
| deb | 188,287,504 字节 |
| `wrapper.node` | 152,431,496 字节，ELF64 x86-64 |
| `major.node` | 111,947,856 字节 |
| wrapper undefined（唯一） | 641 |
| 其中 `napi_*` / `uv_*` | 41 / 53 |
| 非系统必需符号 | 2（`qq_magic` + `IsEnvironmentStopping`）；`PerfTrace` 为运行期 dlsym 可选 |
| 运行时 exports（3.2.35） | **104** |
| 运行时 engine init / getLoginList | KLINUX + `V1_LNX_NQ_3.2.35_54395_GW_B` → OK；`{"result":0,"LocalLoginInfoList":[]}` |
| Stage 0b 扫码登录（2026-11-09） | QR 成功；`onQRCodeSessionUserScaned` → `onQRCodeLoginSucceed` |
| Stage 0b 快速登录 | `getLoginList` 1 条 `isQuickLogin:true`；`quickLoginWithUin` `result:"0"`、`errMsg:""` |
| Stage 0b session READY | `onOpentelemetryInit is_init:true` / `onSessionInitComplete 0`；`getMsgService` 立即非空；7 个核心 service 非空 |
| Bugly 副作用 | 写 `$HOME/.config/QQ/crash_files/`，不受 `desktopGlobalPath` 控制 |
| 隐藏依赖 | `libbugly` 有约 70 个 gnutls UND，但无 `DT_NEEDED`；需 `LD_PRELOAD` `libgnutls.so.30` |
| wrapper 最高 GLIBC | 2.17 |
| Node v24.16.0 最高 GLIBC | 2.28 |
| Node 导出 | 145 `napi_*` / 318 `uv_*` / 1558 v8 / 5774 `node::*` |

arm64 基线（同版本 `arm64` deb，见 §9.11）：

| 项 | 值 |
|---|---|
| deb | 208,717,176 字节，sha256 `5f93ea62347dd772c7be4115413c95d2a60d189f3dd81bc194834bd4d7343cf2` |
| `wrapper.node` / `major.node` | 147,183,032 / 112,209,336 字节，ELF64 AArch64 |
| wrapper undefined（唯一） / 静态导出 | 655 / 385 |
| `napi_*` / `uv_*` / v8 / node | 41 / 53 / 1 / 1（与 x64 相同） |
| 非系统必需符号 | 同 x64：2（`qq_magic` + `IsEnvironmentStopping`）+ `PerfTrace` |
| `libbugly.so` gnutls UND（无 `DT_NEEDED`） | 71 |
| 缺失的系统 `DT_NEEDED` | `libuuid.so.1`（x64 有；arm64 需预加载） |
| stub 交叉编译 | 69,424 字节，导出 3 符号，无 `DT_NEEDED` |

重跑：

```bash
# 下载配置（x64/arm64/loongarch/mips）
curl -s https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js

# 解包后看符号
readelf --dyn-syms --wide wrapper.node \
  | awk '$7=="UND" && $5=="GLOBAL"{print $8}' | sort -u

# 依赖与版本
readelf -d --wide wrapper.node | grep NEEDED
readelf --version-info --wide wrapper.node | grep 'Name: GLIBC_'

# Node 侧对照
readelf --dyn-syms --wide node | grep -c 'napi_'

# arm64：解包 + 交叉编译 stub（产物不入公共仓库）
7zz x QQ_*_arm64_01.deb -od0 && 7zz x d0/data.tar.xz -od1 && 7zz x d1/data.tar -od2
readelf --dyn-syms --wide d2/opt/QQ/resources/app/wrapper.node \
  | awk '$7=="UND" && $8!=""{print $8}' | sort -u
cd packages/loader/native
ARCH=arm64 CXX=aarch64-linux-gnu-g++ bash stub/build-linux.sh
readelf --dyn-syms --wide build/linux-arm64/libnapuketto_stub.so | grep -v UND
```

> 注：arm64 的 `linuxConfig.js` 字段是 `armDownloadUrl.deb`
> （`…/QQ_3.2.35_261103_arm64_01.deb`）；`qqdl.gtimg.cn` 的 `/QQNTV2/` 段需降为
> `/qqntv2/` 才能下载（`normalizeDownloadUrl` 已处理，手测时注意）。

## 附录 B：参考

- [QQ Linux 下载页](https://im.qq.com/linuxqq/index.shtml)
- [Linux 下载配置（linuxConfig.js）](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js)
- [NapCat Linux 启动器（Xvfb + LD_PRELOAD 劫持 package.json main）](https://github.com/NapNeko/napcat-linux-launcher)
- [Node.js `src/node_binding.cc`（DLOpen / 自注册）](https://github.com/nodejs/node/blob/v24.16.0/src/node_binding.cc)
- 仓内相关：[decisions.md](decisions.md)（ADR-019）、[runtime.md](runtime.md)、
  [overview.md](overview.md)、[loader design](../../packages/loader/docs/design.md)
