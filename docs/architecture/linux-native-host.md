# Linux 原生自建宿主研判（ELF + 最小 stub）

> **状态**：研判稿（2026-11-08），**实现已发布**（loader 0.6.1–0.7.x，开关
> `NAPUTO_LINUX_NATIVE=1`）。**未替代 ADR-019**：Linux 默认仍是 wine + Windows
> `node.exe`（见 [decisions.md](decisions.md) 的 ADR-019 与 [runtime.md](runtime.md) §1），
> 原生分支只是显式开关；ADR 与 Wine 退役等 arm64 与「他人消息入站 / 视频 / 文件」补齐后
> 再定。2026-11-08 完成 Stage 0 核心链路实测（dlopen / exports / O3 / engine init /
> `getLoginList`）；2026-11-09 完成 Stage 0b（真实扫码 + 快速登录 + session READY，wrapper
> 层）、Stage 1 端到端（CLI + kernel 平台参数 + loader 原生分支）、Stage 2（deb
> 下载/解包/缓存管线）、Stage 3（消息发送/撤回）、Stage 3b（arm64 符号 + 解包 + stub
> 交叉编译的静态核验）、Stage 3c（`HOME`/`XDG_*` 收敛）与 Stage 3d（本地 `/opt/QQ` 扁平
> 安装）；2026-11-10 完成 Stage 3e（X11 消费方盘点）、Stage 4（图片/语音富媒体）、arm64
> qemu 运行期（引擎初始化 + 登录握手）与交付工程化（发布包带 stub、nightly smoke、清单
> 自动维护、解包工具按架构分流）。
> 仍未验证：文件上传（协议侧无 `upload_group_file`，`file` 段到 xml 元素未实现）与
> arm64 真机登录与收发。他人消息的实时入站已于 2026-11-10 实测通过
> （真 CLI + OB11 WS + 第二账号，见附录 D.1）。
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
  无 DISPLAY 的 dlopen / engine init 已实测通过；X11 运行期功能不构成缺口——本仓没有
  截图 / 剪贴板消费方，有 `DISPLAY` 时也不建 X 连接（附录 C）。
- **工程量不在 3 个点**：真正的成本在 deb 包获取与布局、双版本号、平台参数、无头依赖、
  清单/更新链、arm64、CI/发布与 ADR。
- **建议**：x64 链路的加载、登录、消息收发（含他人消息实时入站）、图片/语音/视频与数据根
  收敛都已实测通过，实现已发布（`NAPUTO_LINUX_NATIVE=1`）；剩余缺口是文件发送与 arm64
  真机。补齐后再写 ADR、再退役 Wine——在此之前 Wine 保持默认，作为回退。

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
- **未做**：X11 运行期功能（本仓当前无截图 / 剪贴板消费方，见附录 C）；文件上传
  （`file` 段 / `upload_group_file` 未实现）；arm64 运行期（arm64 静态核验见 §9.11）。
  他人消息实时入站已于 2026-11-10 实测通过（附录 D.1），视频发送见附录 D。

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
- **数据目录**：`HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` 已**收敛到数据根**（Stage 3c
  已实现并实测，见 §9.12）：`libbugly` 的 `NativeCrashHandler` 会无视
  `desktopGlobalPath`，直接向 `$HOME/.config/QQ/crash_files/` 写崩溃记录。收敛后该目录
  落在 `<数据根>/home/.config/QQ/crash_files/`，用户 `$HOME` 零写入。

## 8. 工程改造清单（落地状态，2026-11-10）

| 区域 | 改动 |
|---|---|
| `packages/loader` | ✅ Linux 平台分支（不再 wine）；`.so` stub 查找与 `LD_PRELOAD`；deb 解包与缓存布局；`qq-releases` 平台字段；本地 `/opt/QQ` 探测；`HOME`/`XDG_*` 收敛；非 x64 解包工具回退系统 7-Zip；Bun 宿主按平台解析 node |
| `packages/kernel` | ✅ `platform_type` / `qua` / session `platform` 平台化；双版本号；`major.node` qua 解析；Linux 数据目录回退 |
| `native/`（私有 submodule） | x64 ✅：`stub-linux.cc`（2 必需 + `PerfTrace`）+ `linux-x64` 预编译 `.so`；arm64 产物待真机（附录 E.2 第 1 项） |
| 发布链 | ✅ `files` 已含 `native/build/linux-x64`（2026-11-10 补：此前 0.6.0 的 tarball 只有 Windows `QQNT.dll`，`NAPUTO_LINUX_NATIVE=1` 的用户会直接报「Linux stub 未找到」）；`release.yml` 打包守卫同时检查 Linux `.so`；`tooling/package-exports.test.ts` 钉死白名单。已发布版本对应：0.6.1 `HOME` 收敛、0.7.0 本地安装、0.7.1 stub 入包，0.7.2（解包工具按架构分流）在发布队列中 |
| CI | ✅ nightly smoke（`.github/workflows/linux-native-smoke.yml`，cron `47 4 * * *` + 手动触发）消费**已发布** loader + 官方 deb，真 `dlopen` 验收；不上 PR 门禁（含 190MB 下载）。首跑即抓到发布包 `catalog:` 泄漏（见 [release.md](../guides/release.md) §5） |
| 文档 | ✅ 运维 §4.8 / 配置 §10 已补；ADR 待 arm64 真机与剩余缺口 |

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

当阶段未覆盖：真实网络下载（`downloadFile` 的 https 链路未在 CI 跑，但 URL/sha256 已用
官方文件核对）；本地 `/opt/QQ` 安装探测（§9.13 补上）；arm64 条目与符号核验（§9.11 补上）。

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

**已补测（2026-11-10）**：他人消息的**实时入站事件**实测通过——真 CLI + OB11 WS，
第二账号在群内发文本，WS 收到 `post_type=message` / `message_type=group` / 正确
`user_id` / 文本段（附录 D.1）。当时发现的 Linux 原生对象空值形状缺陷（元素变体
显式 `null` 导致入站消息被误判为 grayTip 丢弃）已随本次修复。

### 9.12 Stage 3c：`HOME`/`XDG_*` 收敛（2026-11-09）

**问题**：`desktopGlobalPath` 只覆盖 QQ 自己的数据；`libbugly` 的崩溃处理器另走
`$HOME`，会向用户目录写 `.config/QQ/crash_files/`（Stage 0b 发现）。

**做法**：Linux 原生分支在 spawn 子进程前把 `HOME` 指向 `<数据根>/home`
（`NAPUTO_LINUX_HOME` 可显式覆盖；无数据根时退到 `<账号目录>/home`），并把
`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` 派到该目录下。
实现是 `linux-native.ts` 的 `resolveLinuxHome` + `linuxHomeEnv`，wine / win32 分支不动。

**实测（WSL2 Ubuntu 24.04，真 CLI + 真 Linux `wrapper.node`，数据根 `/tmp/ntqq2`）**：

| 项 | 结果 |
|---|---|
| strace 观察 | Bugly 只读 `$HOME`（`access`/`mkdir $HOME/.config/QQ/crash_files`），**不读 `XDG_CONFIG_HOME`** |
| Bugly 日志 | `InitBuglyManager path: /tmp/ntqq2/home/.config/QQ/crash_files/` |
| 受管目录 | `/tmp/ntqq2/home/.config/QQ/crash_files` 由原生层自行创建（umask 后 `750`） |
| 用户 `$HOME`（`/root`） | 该目录零写入（`find -newer` 标记为空） |
| 快速登录 | 成功（票据在 `<数据根>/nt_qq`，与 `HOME` 无关） |
| 进程退出 | SIGTERM → 优雅退出 `code=0` |

**结论**：收敛 `HOME` 即可，`XDG_*` 是给 `libvips` / fontconfig 等 C 库的缓存兜底；
`XDG_RUNTIME_DIR` 刻意不接管（会话级 dbus 目录，语义与数据根不同）。副作用是
崩溃记录不再出现在用户熟悉的位置——需要时去 `<数据根>/home/.config/QQ/crash_files/`
取（文档已注明）。

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
5. 运行时仍待验证：登录 / session READY / 收发在 arm64 **真机**上未跑过；stub 的 arm64
   产物尚未进私有 `native/`（`build/linux-arm64/` 只是本机交叉编译产物），清单里
   也还没有 arm64 条目——按既定策略，arm64 作为独立交付项，等真机验证后再登记
   （避免给用户一个未验证的下载入口）。**加载链路、引擎初始化与登录握手的运行期验证
   见附录 E（qemu 模拟）。**

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
- x64 的加载 / 登录 / 收发（含他人消息实时入站）/ 富媒体 / 数据根收敛都已通过，实现已随
  loader 0.6.1+ 发布为显式开关（`NAPUTO_LINUX_NATIVE=1`）；剩余缺口（文件发送、arm64
  真机）补齐前不改 ADR、不删 Wine。
- 补齐后新增 ADR（草案见下），Wine 保留一个版本作为回退，随后删除。
- arm64 作为独立交付项，不随首版承诺：加载链路、引擎初始化与登录握手已验证（qemu），
  真机登录 / 收发待做。

**拟新增 ADR 草案（剩余缺口补齐后写入）**：

> Linux 默认走原生 ELF 自建宿主：标准 Linux `node` + 2 必需符号 + `PerfTrace` 的
> stub `.so`，`dlopen` 官方 Linux `wrapper.node`；Windows 保持 PE stub。Wine 仅保留
> 一个版本的兼容回退，随后删除。理由：ELF 全局符号表消除近百条 forwarder；去掉
> Wine / Windows node.exe / WINEPREFIX；官方 Linux QQ 提供 x64/arm64。本条替代
> ADR-019 的 Linux 运行方式部分，保留其“不内置腾讯二进制”原则。

**已验证（2026-11-08 → 2026-11-10）**：`dlopen` + exports=104、O3 激活、无 DISPLAY、
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
无依赖的 `.so`；同时发现 arm64 缺 `libuuid` 的 `DT_NEEDED`（需额外预加载）。Stage 3c
把 `HOME`/`XDG_*` 收敛到 `<数据根>/home`：Bugly 的 `crash_files` 落在受管目录，
用户 `$HOME` 零写入，快速登录与优雅退出不受影响（§9.12）。Stage 3d 用合成扁平安装验证
`/opt/QQ` 布局：`/proc/<pid>/maps` 确认加载本机 wrapper、数据根未生成 `qq-files/`、登录与
退出正常（§9.13）。Stage 3e 盘点 X11 消费方（`packages/**/*.ts` 0 命中）并在有 `DISPLAY`
时用 strace 确认不建 X 连接（附录 C）；Stage 4 图片（64×64 PNG）与语音（WAV → silk）发送、
`get_image` / `get_record` 回取与撤回全部通过，Stage 4f 视频（1s H.264 mp4）在 adapter
补首帧缩略图后发送成功、缩略图按视频 md5 落盘、撤回通过（附录 D）；2026-11-10 补测
他人消息实时入站通过（真 CLI + OB11 WS + 第二账号，附录 D.1）；arm64 qemu 下
`initWithDeskTopConfig` 返回 `true`、MMKV 建库在数据根、`login.connect()` 触发
`onLoginConnected`、`getLoginList` 正常返回（附录 E.1）；工程化补齐发布包 stub 与双重
守卫、nightly smoke、清单 Linux 条目自动维护、非 x64 解包工具回退（§8）。

**待决/待验证**：

- X11 运行期功能：**当前不是缺口**——本仓没有截图 / 剪贴板消费方（附录 C 有 grep 证据），
  启动/登录链路在有 `DISPLAY` 时也不建立 X 连接（strace 实测）；将来接入截图类能力时
  再按附录 C 的清单补验证。
- 消息**发送 + 撤回已实测通过**（§9.10），**图片 + 语音 + 视频也已实测通过**（附录 D），
  **他人消息实时入站也已实测通过**（附录 D.1）；未覆盖文件上传（协议侧无
  `upload_group_file` 动作，`file` 段翻译到 xml 元素也尚未实现）。
- arm64：符号与解包**已静态核验**（§9.11），加载链路、引擎初始化与登录握手**已运行期
  验证**（qemu，附录 E.1）；**真机登录 / 收发未验证**。stub 的 arm64 产物尚未进私有
  `native/`、清单也还没有 arm64 条目、loader 还没 preload `libuuid`——三件事按既定策略
  等真机验证后一起做（附录 E.2）。
- arm64 需要额外预加载系统 `libuuid.so.1`（`uuid_generate` / `uuid_unparse` 是
  lazy UND 且无 `DT_NEEDED`），x64 靠 `DT_NEEDED` 自动解析。
- ~~Linux 本地 `/opt/QQ` 扁平安装探测（当前只认 `versions/` 缓存布局）~~
  **已实现（Stage 3d，2026-11-09，loader 0.7.0）**：`NAPUTO_QQ_DIR` > `/opt/QQ`，校验
  ELF + `resources/app/package.json` 版本，命中即用本机安装（§9.13）。
- ~~公开 CI 无法检私有 submodule，真 smoke 放哪里（release / self-hosted / 已发布包）~~
  **已定并上线（2026-11-10，loader 0.7.1 + #82）**：公开 CI 消费**已发布**的
  `@napuketto/loader` tarball——`files` 补上 `native/build/linux-x64` 后 tarball 自带
  Linux stub，Gate 门禁不跑真 smoke（含 190MB deb 下载，不宜上 PR 门禁），改为 nightly
  + 手动触发的工作流。首跑就抓到已发布包的 `catalog:` 依赖泄漏（用户侧必装不上），
  已由发布链修复，见 [release.md](../guides/release.md) §5。
- 是否用 dummy `libbugly.so` 去掉 krb5 / gnutls / gcrypt 依赖（可减依赖，但有行为风险，
  暂不建议）。
- ~~Bugly 固定写 `$HOME/.config/QQ/crash_files/`，需要 `HOME`/`XDG_*` 收敛方案~~
  **已修（Stage 3c，2026-11-09）**：受管 `HOME` = `<数据根>/home`，实测用户目录零写入
  （§9.12）。

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
| Bugly 副作用 | 写 `$HOME/.config/QQ/crash_files/`，不受 `desktopGlobalPath` 控制；Stage 3c 起收敛到 `<数据根>/home/.config/QQ/crash_files/` |
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

## 附录 C：X11 消费方盘点与有 DISPLAY 的冒烟（Stage 3e，2026-11-09）

**结论 1：本仓当前没有 X11 消费方。** 在 `packages/**/*.ts` 里搜
`ScreenCapture|screenCapture|clipboard|Clipboard|getScreen|screenshot|Screenshot`
命中 **0**——kernel 未注册截图 / 剪贴板一类 QQ 原生 API，OneBot 11 / Satori 侧也没有对应
动作。也就是说“X11 运行期功能”在现有 API 面上**无从触发**，不是漏测。

**结论 2：有 DISPLAY 时也不建立 X 连接。** 在 WSL2（WSLg 已起，`/tmp/.X11-unix/X0` 存在）
里用真 CLI + 真 x64 ELF `wrapper.node`、`DISPLAY=:0` 跑：

```bash
DISPLAY=:0 strace -f -e trace=connect -o /tmp/x11.log node apps/cli/dist/index.mjs
grep X11-unix /tmp/x11.log   # 无输出 = 全程没连 X server
```

| 项 | 结果 |
|---|---|
| `wrapper 装配完成` | 通过（`version=3.2.35-54395`） |
| 快速登录 | 成功 |
| X11 连接（`connect` 到 `/tmp/.X11-unix/*`） | **0 次** |
| 崩溃日志 | 无新增（只有 Bugly 读旧 `rqd_record.eup` 的固有告警） |
| SIGTERM 退出 | `code=0` |

即：启动 / 登录 / 消息链路在有 X 和无 X 的环境下行为一致，不需要 `Xvfb` 也能跑（这一点比
NapCat 的 launcher 简单——那边要靠 Xvfb 哄 Electron 主进程，我们根本不跑 Electron）。

**结论 3：将来接入截图 / 剪贴板时要补的验证清单**（现在不做，避免无消费方的空转）：

1. 真实 `DISPLAY` 与 `Xvfb` 两种环境下的行为差异；
2. `libX11` / `libxcb` / `libXext` 是随包（deb 里有 `libEGL.so` 等）还是系统依赖；
3. 容器场景的 `xauth` / `XAUTHORITY` 与 `/tmp/.X11-unix` 挂载；
4. 无 X 环境下这些 API 的可读降级错误（不能崩宿主）。

## 附录 D：富媒体发送实测（Stage 4，2026-11-09）

环境同 Stage 3/3d：WSL2 + 真 x64 ELF `wrapper.node`（`/tmp/opt-qq` 扁平布局）+ 真 CLI
（OneBot 11 HTTP），群 `1101729931`，发送后 `get_*` 取回、再 `delete_msg` 撤回。

| 媒体 | 发送 | 取回（媒体落盘） | 撤回 |
|---|---|---|---|
| 文本（对照） | `retcode 0` | — | ✅ |
| 图片 64×64 PNG（210 字节） | `retcode 0` | `get_image`：`file_size=210`、`file_name=BEE3…C24BE.png`、`file=<数据根>/…/nt_data/Pic/2026-11/Ori/bee354a1c2c8ff1b5d3d056712fc24be.png`（md5 与文件名一致） | ✅ |
| 语音 WAV（24kHz / mono / 16-bit / 0.6s） | `retcode 0` | `get_record`：`file_size=2461`、`file_name=voice.silk`、`file=…/nt_data/Ptt/2026-11/Ori/e4627f2ee64867430bf01673cffb9372.silk`；历史消息里即是该 `record` 段 | ✅ |
| 视频 1s 64×64 H.264 mp4（2026-11-10 补，Stage 4f） | `retcode 0` | `get_msg`：`videoElement` 落盘 `…/nt_data/Video/2026-11/Ori/e604326d06d76e473ff817c0ea36495b.mp4`；缩略图 `…/Video/2026-11/Thumb/e604326d06d76e473ff817c0ea36495b_0.png`（文件名用**视频 md5**，符合 kernel 契约） | ✅ |

链路与 Windows 一致：`md5 → getRichMediaFilePathForGuild → util.copyFile → 完整
picElement / pttElement / videoElement → sendMsg`；语音的非 silk 输入由 **adapter** 层
`ensureSilk`（`@napuketto/media`）转码，视频缺缩略图时由 **adapter** 层
`prepareVideoElements` 抽首帧 + 补时长/尺寸（同样走 `@napuketto/media` 的 ffmpeg），
kernel 只收「文件齐全」的路径。宿主退出 `code=0`，服务端无异常日志。

**踩坑（重要，别误判成平台缺陷）**：Stage 4 首轮用一段手写 base64 的“1×1 PNG”测试，
`send_msg` 稳定返回 `sendStatus=0`，一度以为是 Linux 缺能力；换成程序生成、**结构合法**的
PNG（正确的 IHDR/IDAT CRC 与 IEND）后**立即成功**。→ 排障顺序应是「先校验素材是否合法
（PNG 签名/IHDR/IEND、silk `#!SILK_V3` 头），再怀疑平台」。

**视频的第二个坑（2026-11-10）**：只给 `file` 的 OB11 `video` 段恒回 `sendStatus=0`，
与「非法图片」同一种沉默失败。根因不在 Linux，而在字段成套性——kernel 只在 canonical 带
`thumbPath` 时才写 `thumbMd5 / thumbSize / thumbPath(Map) / thumbWidth / thumbHeight`，
且 `fileTime`（秒）来自 `durationSec`。修复在协议层（adapter `prepareVideoElements`）：
抽取首帧写入系统临时目录 → 补 `thumbPath / width / height / durationSec`，发送后清理；
抽帧失败抛可读 `MediaError`。补首帧后视频 `retcode 0`、群里可播放、缩略图按视频 md5 落盘。

**未覆盖**：

- **文件**：OneBot 11 侧没有 `upload_group_file` 动作（实测返回 `未知动作`），`file` 段
  翻译到 xml 元素时明确报「发送元素 xml 暂不支持（P2-2 探测后补）」；kernel 的
  `prepareFileElement` 是预留实现，等协议动作落地再测。**2026-11-10 已把三条候选通道
  摸清**（BDH `uploadFile` / `BatchUpload` / `FlashTransfer`）——`getGroupService` 无群文件
  NAPI 入口，BatchUpload 已真实打到服务端但回 `170019002`，详见
  [kernel design §14](../../packages/kernel/docs/design.md)。这与平台无关（Windows 同样未实现），
  不属于 Linux 原生链路独有的缺口。
- 大批量 / 大体积图片（如 4MB+ 照片）未压测；视频只测了 1s / 64×64 / H.264。

### D.1 他人消息实时入站（2026-11-10 补测）

环境同上（WSL2 + 真 x64 ELF `wrapper.node` + 真 CLI，`NAPUTO_LINUX_NATIVE=1`，
数据根 `/tmp/ntqq2`）。单协议配置只有 `[accounts.onebot11]`：HTTP 39001 / WS 39002，
`heartbeatInterval=5000`；双协议对照另追加 `[accounts.satori]` + WS 39003。

| 步骤 | 结果 |
|---|---|
| 第二账号 `3054108135`（Oppenheymu）在群 `1101729931` 发「测试」 | kernel `Msg/onRecvMsg` 收到（loader「接收 <- 群聊」日志） |
| OB11 WS（39002）事件 | ✅ `{"time":<当前 Unix 秒>,"self_id":1569227406,"post_type":"message","message_id":N,"message":[{"type":"text","data":{"text":"测试"}}],"raw_message":"测试","message_type":"group","group_id":1101729931,"user_id":3054108135,...}` |
| 自然群流量（群 `521584745`，2659 人） | 文本 / 图片 / `reply` 段均正常广播：`user_id` 为真实 QQ 号、`time` 为当前时间 |
| 协议隔离 | 只配 OB11 时 WS 全程只有 `post_type:"meta_event"` 心跳，无 `{"op":0,...}` 串台 |
| 双协议同时启用（OB11 39002 + Satori 39003） | ✅ 同一条「隔离测试 2」：OB11 端口收到 `post_type:"message"` 信封、Satori 端口收到 `{"op":0,"body":{"type":"message-created",...}}` 信封；两端口 crosstalk=0 |

**发现并修复（adapter，详见 `packages/adapter/docs/design.md` §10）**：

1. **元素变体 `null` 形状**：Linux 3.2.x 原生对象把未命中的元素变体**显式置
   `null`**（`"grayTipElement":null`、`"fileElement":null` …，Windows 省略这些
   字段）。OB11 的 `hasGrayTip` / `hasFileElement` 用 `!== undefined` 判定，于是
   每条普通消息都被误判成 grayTip、转入 notice 分支后静默丢弃——这才是「实时入站
   收不到」的真因（插桩实测 `groupMemberRole` 566ms 正常返回，不是原生调用挂起）。
   Satori 的 `hasSatoriGrayTip`（`g === undefined`）同源，`null.subElementType`
   抛错被事件通道吞掉，`message-created` 同样不广播。修复：空值判定改 `!= null`。
2. **`msgTime` 单位**：Linux 是**秒**字符串（`1794307394`），Windows 是毫秒
   （`1700000000000`）；OB11 统一 `/1000` 会让 Linux 事件时间退化成 1970。已按
   量级归一（`toUnixSeconds`）。

**同轮收口的入站字段差异（2026-11-10，详见 adapter design §10.1）**：

- `sender.nickname` 为空 → Linux 把显示名放 `sendMemberName`，`sendNickName` 是
  空串；OB11 事件与 `get_msg`/历史消息统一回退（昵称非空仍优先，Windows 不变）。
- 图片段 `file` 为空 → Linux `picElement` 既无 `picPath` 也无 `picUrl`，原图在
  `sourcePath`（其他字段见 adapter design §10.1 的 dump）；kernel 取值链补
  `sourcePath`。
- milky 的同类 `!== undefined` 元素嗅探一并收敛为 `!= null`。

## 附录 E：arm64 运行期验证（qemu 模拟，Stage 3b 补充）

在 Docker Desktop 的 `linux/arm64` 容器（qemu 用户态模拟，`uname -m` = `aarch64`）里跑
通了真 `dlopen`，静态核验的结论在运行期成立：

| 步骤 | 结果 |
|---|---|
| 容器架构 | `aarch64`（qemu 模拟，非真机） |
| arm64 node | `v24.16.0`（官方 `node-v24.16.0-linux-arm64`，qemu 下正常） |
| 官方 arm64 `wrapper.node` | 147,183,032 字节，ELF |
| arm64 stub | 本机交叉编译产物 69,424 字节（同 `stub-linux.cc` 源码） |
| 预加载 | `stub:libgnutls.so.30:libuuid.so.1`（**三个都要**：gnutls 是 libbugly 隐藏依赖，libuuid 是 arm64 缺 `DT_NEEDED` 的那条） |
| 系统依赖 | `libx11-6`（arm64 wrapper 的 `DT_NEEDED` 里有 X11；缺了直接 `libX11.so.6: cannot open shared object file`）、`libx11-xcb1` / `libxext6` / `libxcb1` / `libgnutls30t64` / `libuuid1` |
| dlopen 结果 | **`exports=104 engine=true`**，进程正常退出 |

结论与边界：

- **arm64 加载链路已运行期验证**（stub + gnutls + libuuid 三件套齐了就能 dlopen）；
  `libuuid` 预加载从静态推断变成实测必需——只 preload stub + gnutls 时 dlopen 能过，
  但首次 `uuid_generate` 会报 symbol lookup error。
- **引擎初始化与登录握手也已验证**（见 E.1）：`initWithDeskTopConfig` 返回 `true`、
  MMKV 在数据根下建库、`login.connect()` 触发 `onLoginConnected`、`getLoginList`
  返回 `{"result":0,"LocalLoginInfoList":[]}`（全新数据目录 + 未登录的预期结果）。
- **仍未验证**：arm64 上的**实际登录**（快速登录/扫码，需要账号）、session READY、
  消息收发；也未在真机（Apple Silicon / 鲲鹏 / 树莓派）上跑过。
- **因此仍未登记**：arm64 stub 没进私有 `native/`、清单没有 arm64 条目、loader 的
  `linuxPreload` 也还没加 `libuuid`——这三件事在真机验证后一起做（否则等于给用户
  一个必然 `symbol lookup error` 的下载入口）。

### E.1 引擎初始化 + 登录握手（2026-11-10）

同一套 qemu 容器里再往前推一步（不涉及账号，只验证原生引擎与登录系统的初始化路径）：

```bash
# 预加载三件套 + arm64 node，跑探针脚本：
#   process.dlopen(wrapper) → Engine.initWithDeskTopConfig({...KLINUX 配置...})
#   → login.initConfig({commonPath: <data>/nt_qq/global, appid: 537403759})
#   → login.connect() → 15s 后 getLoginList()
LD_PRELOAD="/stub/libnapuketto_stub.so:$GNUTLS:$UUID" DATA=/data WRAPPER=/qq/wrapper.node \
    node /login.cjs
```

| 步骤 | 结果 |
|---|---|
| `process.dlopen` | `exports=104` |
| `Engine.initWithDeskTopConfig`（`platform_type=5` / `qua=V1_LNX_NQ_3.2.35_54395_GW_B`） | 返回 **`true`** |
| MMKV 初始化 | `root dir: /data/nt_qq/global/nt_data/mmkv`（库文件正常落盘） |
| `login.initConfig` | 无异常 |
| `login.connect()` → `onLoginConnected` | **回调触发**（登录系统连接建立） |
| `getLoginList()` | **`{"result":0,"LocalLoginInfoList":[]}`** |
| 进程退出 | `RC=0`（探针主动 exit） |

容器里同时装了 `libnss3` / `libnspr4` / `libgbm1`（未单独验证是否必需，属于 Qt/Electron
体系的常规依赖，先备着）。

**仍未做**：真正的登录（快速登录需要票据、扫码需要人）、session READY、服务面调用与
消息收发——这些在 qemu 下还会被 ~10x 的模拟开销放大，留给真机。

### E.2 arm64 交付前还缺什么（清单，2026-11-10 复核）

按“真机验证后一起做”的既定策略，把 arm64 从“能跑”推到“能发”还需要下面五项（第 4 项
已于 2026-11-10 修掉，其余四项待真机）：

| # | 缺什么 | 现状 / 证据 |
|---|---|---|
| 1 | arm64 stub 进私有 `native/` + loader 包 `files` | 目前只有 `native/build/linux-x64` 入包；arm64 产物是本机交叉编译的未跟踪文件 |
| 2 | loader 的 `linuxPreload` 加 `libuuid` | 现在只 preload `stub:gnutls`；arm64 缺 `libuuid.so.1` 的 `DT_NEEDED`，首次 `uuid_generate` 会 symbol lookup error（E.1 里靠手工三件套绕过） |
| 3 | 清单 arm64 条目 | `qq-releases.json` 只有 x64 linux 条目；清单自动化目前钉死 `LINUX_MAINTAINED_ARCHES = ["x64"]`（等真机后加 `"arm64"`） |
| 4 | ~~内置 `7zz` 只有 x86-64~~ **已修** | `assets/7zip/7zz` 是 x64 ELF（`e_machine=0x3e`），arm64 上 `cannot execute`。loader 0.7.2 起按架构分流：非 x64 跳过内置/缓存/官网（三者都是 x64 产物），回退系统 `7zz` / `7z`，缺失时抛可读错误（`NAPUTO_7Z_PATH` 可显式指定） |
| 5 | 真机端到端 | 登录（快速/扫码）、session READY、消息收发、优雅退出，全部未在 arm64 真机跑过 |

> 第 4 项是 2026-11-10 复核时新增的：之前只想到「arm64 缺 libuuid」，没注意解包工具链本身
> 也是 x64 二进制——arm64 首跑前必须先解决，否则连 `ensureQqFiles` 都过不去。现已由
> loader 0.7.2 的架构分流修掉；剩余四项仍按真机策略一起做。


