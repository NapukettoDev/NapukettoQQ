# Linux 原生宿主（ELF + 最小 stub）

> Linux 原生宿主 = 标准 Linux `node` + `libnapuketto_stub.so` + 系统 `libgnutls.so.30`，
> `dlopen` 官方 ELF `wrapper.node`；解决 Linux 上不再需要 Wine / Windows 二进制的问题。
> 源码入口：`packages/loader/src/boot/linux-native.ts`、`launcher.ts` 的 `launchLinuxNative`。

## 为什么 Linux 不需要近百条 forwarder

Windows PE 的导入表按「模块名 + 符号名」绑定：`wrapper.node` 的 IAT 写死了 `napi_*` /
`uv_*` 来自 `QQNT.dll`，所以必须 PATH 前置自研 stub DLL 逐条转发（近百条转发 + 2 个本地实现）。

ELF 没有这个限制：`dlopen(wrapper.node)` 时未定义符号在进程全局作用域（主程序 +
`RTLD_GLOBAL` 库）按名解析。官方 Linux `node` 导出自身符号，`napi_*` / `uv_*` / v8 自动命中。

| 维度 | Windows 自建宿主 | Linux 原生宿主 |
|---|---|---|
| 目标二进制 | `wrapper.node`（PE/COFF） | `wrapper.node`（ELF64） |
| 符号绑定 | IAT 写死 `QQNT.dll` | 全局符号表按名解析 |
| `napi_*` / `uv_*` | stub 逐项转发到 `node.exe` | 无需代码，直接解析 |
| 自定义符号 | `qq_magic` + 2 个 C++ 符号 | 2 必需 + `PerfTrace` 可选 |
| 注入方式 | `PATH` 前置 `QQNT.dll` | `LD_PRELOAD` |
| 架构 | 仅 x86_64 | 官方 x64 / arm64 等四种 |

## 现行机制

- 宿主进程是标准 Linux `node`：`resolveLinuxNode` 在当前进程就是 node 时直接复用，
  否则 `which node`；Bun 等非 node 宿主因此也能启动。
- loader 装配 `LD_PRELOAD=<stub>.so:<libgnutls>.so.30`（`linuxPreload`），顺序固定：
  stub 在前、gnutls 紧随。
- `libnapuketto_stub.so` 只补 3 个符号（见下节），其余符号交给 node 的全局符号表。
- kernel 用 `process.dlopen` 加载 ELF `wrapper.node`，再初始化 engine 与 session。

`process.dlopen` 的两个行为决定了为什么用 `LD_PRELOAD` 载 stub：

- POSIX 上 `flags` 直接传给 `dlopen`，默认 `RTLD_LAZY`。**不要**为了「尽早报错」改成
  `RTLD_NOW`——`wrapper.node` 里有既无定义、也只在特定功能里才用的符号，会被提前判死。
- 普通 `.so` 若不导出 `napi_register_module_v1` / `node_register_module_vN`，Node 会
  `dlclose` 并抛 `Module did not self-register`。`LD_PRELOAD` 没有这个约束，stub 也无需
  node 头文件；备选是给 stub 加 dummy `NAPI_MODULE_INIT` 再以 `RTLD_GLOBAL` 加载。

## stub 符号面

| 符号 | 性质 | stub 实现 |
|---|---|---|
| `qq_magic_napi_register` | 必需，`GLOBAL UND` | 桥接回 `napi_module_register` |
| `node::IsEnvironmentStopping` | 必需 | 恒返回 `false` |
| `PerfTrace` | 可选，运行期 `dlsym` | 空实现，消除加载告警 |

`qq_magic_napi_register` 在 `wrapper.node` 的构造期（`.init_array`）被调用，缺失即加载失败。
`IsEnvironmentStopping` 的完整符号名是 `_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE`，
只在停止路径使用，返回 `false` 与 Windows stub 同语义。`PerfTrace` 不在静态 `UND` 表里，缺了
只打印 `loadSymbolFromShell: dlsym failed PerfTrace`。

不要被这些符号误导：

- `OPENSSL_memory_*` / `sdallocx` / `__gcov_*` 是 `WEAK UND`，ELF 解析为 0，不阻塞加载。
- `_ZN2nt9wifiphoto…` 是 `GLOBAL UND` 且随包 `.so` 里无定义；`RTLD_LAZY` 下不阻塞，
  该功能（文件桥）被调用才会 symbol lookup error，宿主不应触碰。
- stub 产物无 `DT_NEEDED`，唯一 `UND` 是 node 提供的 `napi_module_register`。

## 生产最低依赖

| 依赖 | 作用 | 缺失症状 |
|---|---|---|
| glibc ≥ 2.28 | node 与 wrapper 的运行基线 | `GLIBC_2.xx not found` |
| `libgnutls.so.30` | `libbugly` 的隐藏依赖 | `gnutls_free` 未定义 |
| `libX11` 系三件 | wrapper 直接 `DT_NEEDED` | `cannot open shared object` |
| `libuuid.so.1` | x64 由 `DT_NEEDED` 解析 | arm64 首次调用 uuid 报错 |
| `libgssapi-krb5` / `libgcrypt` | `libbugly` / `libssh2` 传递依赖 | `cannot open shared object` |

- glibc 下限由 node 决定：`wrapper.node` 最高只需 `GLIBC_2.17`，Node v24 需 `GLIBC_2.28`
  → 约 Debian 10 / Ubuntu 20.04 起；musl（Alpine）不支持。
- gnutls 必须与 stub 一起 preload：`libbugly.so` 引用 gnutls 符号却没有 `DT_NEEDED`，
  `ldd` 与依赖闭包都发现不了，只有实际 `dlopen` 才暴露。
- X11 三件指 `libX11.so.6` / `libX11-xcb.so.1` / `libXext.so.6`，只在加载期需要。
- Docker 最小集合（Debian / Ubuntu，按镜像实际校验）：

```text
libx11-6 libx11-xcb1 libxext6 libxcb1 libuuid1
libgssapi-krb5-2 libgcrypt20 libstdc++6 zlib1g
# Ubuntu 24.04 的 gnutls 是 libgnutls30t64，Debian 12 是 libgnutls30
```

## QQ 文件获取与缓存布局

Linux QQ 提供 deb / rpm / AppImage，**优先 deb**：deb 是 `ar` + `tar`，AppImage 需要 FUSE
或 `unsquashfs`（7-Zip 不支持 squashfs）。下载配置是独立的
[`linuxConfig.js`](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js)：
x64 取 `x64DownloadUrl.deb`，arm64 取 `armDownloadUrl.deb`。URL 路径段 `/QQNTV2/` 大写会被
边缘 WAF 403，小写 `/qqntv2/` 才 200（`normalizeDownloadUrl` 已归一化）。

解包是三层（`extractDebInstaller`：deb → `data.tar.xz` → `data.tar` → 文件树，中间产物解完
即删），再由 `extractLinuxWrapperFiles` 按白名单进缓存：

```text
<数据根>/qq-files/<客户端版本>/versions/<客户端版本>/resources/app/
  wrapper.node   major.node   libbugly.so   libcrbase.so
  libunwind*.so*  libssh2.so.1  sharp-lib/libvips-cpp.so.42
  pub.key  cacert.pem  package.json  application.json
```

- 缓存刻意合成 Windows 同构的 `versions/<版本>/resources/app/`，kernel 的 ADR-018 路径
  （`resolveWrapperPath`）不用为 Linux 改。
- `sharp-lib/` 必须整体保留：`wrapper.node` 的 RUNPATH 是 `$ORIGIN:$ORIGIN/sharp-lib`。
- 本机装了 QQ 时优先用安装目录（`tryResolveLinuxLocalQq`：`NAPUTO_QQ_DIR` > `/opt/QQ`，
  校验 ELF 魔数 + `resources/app/package.json` 版本），省掉近 200MB 下载。
- 内置 `7zz` 是 x86-64 ELF：非 x64 架构跳过内置资产，回退系统 `7zz` / `7z`，两者都缺时报
  可读错误（这条路径不读 `NAPUTO_7Z_PATH`，与 `findSevenZip` 的探测顺序不同）。
- 清单 schema 2 条目带 `platform` / `arch` / `coreVersion`，目前只维护 Linux x64。
  自动更新对 CDN 边缘短暂返回旧版的 `linuxConfig.js` 做防降级跳过；单架构下载 / 解包
  失败只 warn，不拖累 Windows 条目。

## 两套版本号

| 版本 | 示例 | 用途 |
|---|---|---|
| 客户端版本 | `3.2.35-54395` | 缓存目录名、`app_version` |
| QQNT 核心版本 | `9.9.37` | 下载路径、展示、清单 `coreVersion` |

`NAPUTO_QQ_VERSION` 与缓存目录名都取客户端版本；清单 `version` 同值、`coreVersion` 记核心版本。

appid 与 qua 都从 `major.node` 运行时解析（`parseAppidFromMajor` / `parseQuaFromMajor`）：
基线内嵌 `QQAppId/537403759` 与 `V1_LNX_NQ_3.2.35_54395_GW_B`。`resources/app/package.json`
里的平台 appid 映射**不是**登录 appid，不要用。engine / session 配置按平台取
`PlatformType.KLINUX`（`platform_type=5`）。

## 数据根、HOME 与无头

- `HOME` 收敛到 `<数据根>/home`（`resolveLinuxHome` + `linuxHomeEnv`，`NAPUTO_LINUX_HOME`
  可覆盖）。原因：`libbugly` 的 `NativeCrashHandler` 只认 `$HOME`，会向
  `$HOME/.config/QQ/crash_files/` 写崩溃记录，不受 `desktopGlobalPath` 控制。
- `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` 一并派到该目录；
  `XDG_RUNTIME_DIR` 刻意不接管（会话级 dbus 目录，语义与数据根不同）。
- QQ 数据固定落 `<数据根>/nt_qq`（多账号共享），不再写 `~/Documents/Tencent Files`。
- 无 `DISPLAY` 可完整跑通加载 / 引擎初始化 / 登录；本仓没有截图、剪贴板消费方，有
  `DISPLAY` 时也不建 X 连接。X11 只在加载期需要客户端库存在。

## arm64 现状

qemu（`linux/arm64` 容器）已跑通 `dlopen`（exports=104）、`initWithDeskTopConfig` 返回
`true`、MMKV 建库、`login.connect()` 触发 `onLoginConnected`、`getLoginList` 正常返回。
arm64 要三件套预加载：stub + `libgnutls.so.30` + `libuuid.so.1`。

**首版只承诺 linux/amd64。** arm64 交付还差：

| 缺口 | 现状 |
|---|---|
| arm64 stub 入包 | 仅 `linux-x64` 进 `files` |
| `linuxPreload` 加 `libuuid` | 现在只 preload stub + gnutls |
| 清单 arm64 条目 | 清单自动化只维护 x64 |
| 真机端到端 | 登录 / session READY / 收发未在真机跑过 |

## 排障顺序

先校验素材再怀疑平台：非法 PNG（CRC 错）与缺字段的 `video` 段都表现为 `sendStatus=0`
的沉默失败，`silk` 头不合法同理。

- `libX11.so.6: cannot open shared object file`：缺 X11 客户端库，装 `libx11-6` /
  `libx11-xcb1` / `libxext6`。
- `undefined symbol: gnutls_free`：`libbugly` 隐藏依赖，preload 系统 `libgnutls.so.30`。
- `dlsym failed PerfTrace`：stub 少符号，补空实现（不阻塞加载）。
- `undefined symbol: qq_magic_napi_register`：stub 未生效，查 `LD_PRELOAD` 与 stub 路径。
- `Module did not self-register`：用 `process.dlopen` 载了普通 `.so`，改用 `LD_PRELOAD`。
- `invalid ELF header`：指向了 Windows PE wrapper，换 deb 产物并走 ELF 校验。
- `cannot execute`（7z）：arm64 上跑内置 x64 `7zz`，装系统 7-Zip。

## 决策与取证

ADR-027 把本路线定为 Linux 唯一路径并退役 Wine，`NAPUTO_LINUX_NATIVE=0` 只剩一句播报
（[decisions.md](decisions.md)）。实测样本、探针命令与发行版依赖裸输出在
[linux-native-host-evidence.md](linux-native-host-evidence.md)；启动链见
[runtime.md](runtime.md)，loader 侧设计见
[loader design](../../packages/loader/docs/design.md)。

## 参考

- [QQ Linux 下载页](https://im.qq.com/linuxqq/index.shtml) 与
  [`linuxConfig.js`](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js)
  （版本号与下载 URL 的来源）
- [Node `src/node_binding.cc`](https://github.com/nodejs/node/blob/v24.16.0/src/node_binding.cc)
  （`DLOpen` 的 flags 传递与自注册规则）
- [NapCat Linux 启动器](https://github.com/NapNeko/napcat-linux-launcher)
  （对照实现：靠 Xvfb 哄 Electron，本仓不跑 Electron）
