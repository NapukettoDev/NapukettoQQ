# @napuketto/loader 设计（v2：跨平台 + 无本机 QQ 运行）

> **状态**：设计稿（2026-08-12）。配套主仓库 `docs/architecture/overview.md` / `docs/architecture/runtime.md`。
> 设计先行——本文件定稿后再实现，实现顺序见 §7。
>
> **用户拍板（2026-08-12，含技术栈逐条确认）**：
> 1. **绝不内置腾讯二进制**——wrapper.node / QQNT.dll / 官方安装包都不得进入 npm 包、Docker 镜像或任何发布产物；文件必须在用户机器上运行时获取。
> 2. **只接受自建宿主**（node + stub + dlopen wrapper.node），不接受「跑完整 QQ NT」。原始方案是 Linux 用 wine 跑 Windows 版 node.exe；**2026-11-14 已改为原生 ELF 并删除 Wine**（ADR-027，见 §3）。
> 3. **架构事实确认**：整个业务栈（kernel + adapter + network + cli）都在自建宿主进程内，对外只暴露**无状态的标准 OneBot11/Satori 网络协议端口（localhost）**——高内聚低耦合，符合云原生微服务理念。（原文前提「都在 wine 内跑 Windows node.exe」已废止。）
> 4. ~~**wine 版本 = wine-stable**~~ **已废止（ADR-027）**：Wine 退役，Linux 只依赖系统 `node` + `libgnutls30` 等运行库。
> 5. ~~**路径映射确认**（`toWinePath`）~~ **已删除（ADR-027）**：不再有 `Z:\` 视角，`buildLaunchEnv` 两平台共用、零路径转换。
> 6. **版本清单自动化立项**：探测腾讯公开版本接口/官方下载页，有则 CI 自动更新，无则人肉维护 + `NAPUTO_QQ_URL` 兜底。**2026-08-13 实测：官方下载配置 JSON（SPA 数据源）可读，探测方案可行**（见 §2.2）。
> 7. **下载实现 = Node 内置 `https` + `crypto`**（无第三方依赖，轻依赖即美德）。
> 8. **解包工具 = 内置 `7za.exe`**（LGPL 可分发，Windows 纯净环境兜底）+ Linux/Docker 用系统 `p7zip-full`。
> 9. **ARM = 第一版只承诺 `linux/amd64`**，ARM（M1/M2/树莓派）列为后置 P2/P3。
> 10. ~~**DPAPI/票据持久化**~~ **已废止（ADR-027）**：没有 `WINEPREFIX`，登录票据在 `<数据根>/nt_qq`，随数据根持久化即可。
> 11. **反风控为核心风险**：P2 阶段立刻推进快速登录/扫码登录冒烟测试。~~试探腾讯风控对 wine 环境的容忍度~~ → 现已改为对**原生 Linux 宿主**的实测（快速登录 + 扫码 + 收发均已跑通）。
>
> **2026-11-14 平台路线定稿（ADR-027）**：Linux 只走**原生 ELF 自建宿主**（标准 Linux
> `node` + `.so` stub + `dlopen` 官方 Linux `wrapper.node`），Wine 分支与其代码一并删除
> （`wine.ts` / `tooling/wine/*`）。研判与实测数据见
> [`docs/architecture/linux-native-host.md`](../../../docs/architecture/linux-native-host.md)。
> 本文 §3 已按定稿重写；§6 风险表与 §8 拍板细节里残留的 Wine 语境按「已废止」保留，供追溯。
>
> **发布形态（2026-08-13 补充：对外 API 双格式）**：
> - 对外 API（`dist/index.mjs` + `dist/index.cjs`）与 kernel 同步输出 **ESM + CJS 双格式**，
>   `exports.require` 指向 `.cjs`——koishi 适配器（发布形态为 `lib/index.cjs`，koishi loader
>   用 `require()` 加载）require 本包时不再 `ERR_REQUIRE_ESM`；ESM 消费方（apps/cli）走 `import`。
> - `import.meta.url`（launcher/qq-extract/qq-releases 定位包内资产）由 rolldown 在 CJS 输出中
>   转换为 `pathToFileURL(__filename)` 等价形式，`dist/` 下相对定位行为不变。
> - `host/self-host.cjs`（CJS 单文件 bundle，子进程入口）不受影响。

---

## 1. 背景与目标

### 1.1 现状约束

- 自建宿主（路线 A）是唯一实现方式：标准 Node + stub 转发 → `process.dlopen(wrapper.node)`（Windows 用 PE `QQNT.dll`，Linux 用 `.so` + `LD_PRELOAD`）。
- 当前 `locate-qq.ts` 只支持 **Windows 本机已装 QQ** 的场景：注册表 / 常见路径 / `NAPUTO_QQ_PATH`，找不到就抛错。
- stub `QQNT.dll` 是 **PE 格式**，只能给 Windows 宿主用；Linux 侧用自研 `.so` stub（ADR-027）。

### 1.2 三个目标

| # | 目标 | 解决的问题 |
|---|---|---|
| G1 | **本机无 QQ 也能运行** | 用户机器没装 QQ NT（或装了但被卸载），无需手动安装 |
| G2 | **Linux 支持（原生 ELF 宿主）** | 服务器 / 无 GUI 环境跑机器人 |
| G3 | **Docker 镜像**（⚠️ 未实现/规划） | 一键部署，`docker run` 即用 |

### 1.3 硬约束（违反 = 错误）

1. **不内置腾讯二进制**：所有发布产物（npm 包 / Docker 镜像 / 仓库文件）不得包含
   `wrapper.node`、`QQNT.dll`、官方安装包 `.exe`、`major.node` 等腾讯文件（含压缩/编码形式）。
2. **不内置 GPL-2.0-only 实现代码**（与 MIT 不兼容，AGENTS.md 红线不变）。
3. **Linux 只走原生 ELF 方案**：标准 Linux node + `.so` stub + dlopen 官方 Linux wrapper.node，
   不跑完整 QQ 客户端。
4. **零磁盘篡改**（AGENTS.md 第 7 条不变）：只读加载，不改写任何腾讯文件。
5. 业务层优先 NAPI，逆向手段仅限 loader 载具层（不变）。

---

## 2. G1：QQ 文件来源解耦（本机无 QQ 也能跑）

### 2.1 核心思路

把「QQ 文件从哪来」从「必须本机安装」扩展为**多级来源探测 + 自动下载解包**：

```
resolveQqFiles()   ← 替代现有 resolveQqInstall() 的文件定位部分
  ├─ L0: NAPUTO_QQ_FILES 环境变量（显式指定含 versions/ 结构的目录）
  ├─ L1: 本机 QQ 安装（现有逻辑：注册表 / 常见路径 / NAPUTO_QQ_PATH）
  ├─ L2: 数据根缓存 <数据根>/qq-files/<版本>/（下载解包产物）
  └─ 全部缺失 → 自动进入「下载 → 解包 → 缓存」流程，再走 L2
```

- **版本选择策略**：L0/L1 有版本就用本机版本；否则按「版本清单」中**最新已知可用版本**下载。
- **幂等**：缓存目录已有目标版本 → 跳过下载，直接使用。
- **阶段日志（2026-08-23 WSL 事故后新增）**：`ensureQqFiles` / `launchSelfHost` 支持
  `onStage` 回调（检查缓存/下载/校验/解包/提取/win-node/spawn 各阶段提示）——此前
  首次下载 313MB 安装包全程静默，用户以为流程没生效。
- **依赖预检（2026-08-23 事故后新增；ADR-027 起改为 Linux 原生依赖）**：Linux 分支 spawn
  前校验 stub `.so` / `libgnutls.so.30` / `node`，缺失时抛可读错误（含包名指引）并挂
  child 'error' 监听兜底——此前 spawn 异步 emit 'error' 无监听者 =
  `uncaughtException` 直接崩掉整个 koishi 宿主进程。
- **tmp 唯一化**：下载临时文件带 pid+时间戳后缀，解包前校验存在性——此前固定文件名
  在多实例/重试并发时互相覆盖 + finally 清理竞态，表现「下载成功但 7z 解包报
  No such file or directory」。

### 2.2 官方安装包下载器

**链接结构（用户提供的事实）**：

```
https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/a0ce07ad/QQ_9.9.33_260730_x64_01.exe
        └─ 主域固定      └─ 版本号  └─ release  └─ 哈希(随版本变)  └─ QQ_<版本>_<构建日期>_x64_01.exe
```

**版本探测（2026-08-13 实测结论，替代 08-12 旧结论）**：

- ❌ 无公开 JSON 版本接口：`dldir1.qq.com/qqfile/qq/QQNT/version.json` 等候选均 404。
- ⚠️ 2026-08-13 实测：im.qq.com 已改版为 **Vite SPA**——HTML 壳仅 ~7KB，下载链接不再内联，
  08-12 的「两页纯 HTML 可正则」结论失效。
- ✅ **官方下载配置 JSON（SPA 运行时数据源，可直接 GET，GitOps 基础）**：
  - 主：`https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json`
    （生产；`Windows.version` + `Windows.updateDate` + `Windows.ntDownloadX64Url`）
  - 备：`https://pre.cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/pcConfig.json`（可能滞后，脚本带防降级）
  - 实测：`9.9.33` / `2026-08-13` / `QQ_9.9.33_260813_x64_01.exe`。
- **构建号不在配置里**（`9.9.33-51802` 的 `51802`）：藏在安装包内部 `versions/<版本>` 目录名，
  用内置 7-Zip 列归档（`7z l`）解析——清单 version 必须与安装包内部目录名一致（运行时
  `extractWrapperFiles` 按版本目录名定位 wrapper.node）。
- **CI 自动更新方案（GitHub Actions）**：
  - Cron Job（每日）调 `tooling/qq-releases/update-qq-releases.ts`（CI/本地共用）→ 抓配置 → 下载算 sha256
    → 解析版本目录 → 更新清单 → 发现变更自动提 PR（GitOps 免维护）。
- **⚠️ 下载 URL 必须归一化路径段大小写（2026-10-07 定位，issue #6 根因）**：
  2026-08-25 前后腾讯 CDN 边缘 WAF 新增一条 **区分大小写** 规则匹配字面量
  `/QQNTV2/` 路径段（rainbow 配置新给的 `ntDownloadX64Url` 即该形态）。命中后由边缘
  直接拒绝、**不回源**：`403` + `Content-Length: 0` + `Server: Lego Server` +
  `X-Cache-Lookup: Return Directly`。而 qqdl.gtimg.cn 的缓存/源站对路径大小写
  **不敏感**——同一 URL 仅把路径段写成小写 `/qqntv2/` 即 `200 OK`
  （实测 x64 安装包 `Content-Length: 330446512`，Range 请求 `206` 且首字节为 PE 头 `MZ`）。
  同一出口 IP、同一时刻、仅路径大小写不同的两次请求结果相反 → 成因是**路径匹配规则**，
  而非此前 workflow 注释里写的「数据中心 IP 被封」。
  故 `normalizeDownloadUrl()`（`src/qq-releases.ts`）负责把 `/QQNTV2/` 降为小写，
  在**唯一出站口** `downloadFile()` 处统一生效；清单里仍保存官方原样 URL（可追溯），
  若腾讯日后修掉该规则，小写路径依旧等价可用。
  > 历史：`QQNT` 段（9.9.33 及更早）不受该规则影响，故旧条目 URL 保持原样。

**版本清单机制（qq-releases.json）**：

- 仓库维护 `packages/loader/qq-releases.json`（**纯文本元数据，非二进制**，符合硬约束 1）：

```json
{
    "schema": 1,
    "known": [
        {
            "version": "9.9.33-51802",
            "url": "https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/a0ce07ad/QQ_9.9.33_260730_x64_01.exe",
            "sha256": "…（CI 下载后计算填入）",
            "appid": 537376818,
            "source": "official"
        }
    ]
}
```

- **清单更新方式**（三级兜底）：
  1. **CI 自动**：GitHub Actions 爬官方下载页 → 新版本自动 PR；
  2. **配置/环境变量 `NAPUTO_QQ_URL` 直接覆盖**下载地址（用户自己拿到新链接时用）；
  3. **社区 PR** 手动更新仓库内 `qq-releases.json`。
- **sha256 校验**：下载完成后校验，防链接漂移被劫持 + 防下载不完整。
  （注：`appid` 仍按现有逻辑从 `major.node` 运行时解析，清单里的 appid 仅作预知信息。）

### 2.3 解包提取

- **安装包格式**：QQ NT 官方安装包是 NSIS 自解压格式，可用完整版 7-Zip 解包（`7z x`）。
  **⚠️ 2026-08-12 实测修正：`7za` standalone 不支持 NSIS**（只支持 7z/zip/tar 等），
  必须完整版 `7z.exe` + `7z.dll`（已内置 assets/7zip，LGPL 合规）。
- **NSIS 解包布局**：解包产物在 `<extracted>/Files/`（NSIS 内部布局），`Files/` = 安装根。
- **解包工具来源**：
  - Windows：内置 `assets/7zip/7z.exe + 7z.dll`（7-Zip 官方 26.02，LGPL 可随包分发）；
  - Linux/Docker：系统 `p7zip-full`（7z 完整版）。
- **⚠️ 2026-08-12 实测修正：真实 QQNT.dll（214MB）不需要提取**——它在
  `versions/<v>/QQNT.dll`，但自建宿主中 stub QQNT.dll 已替代其宿主符号职责
  （wrapper.node 的 v8/node/napi/qq_magic 符号由 stub 转发到 node.exe）。
- **提取目标（2026-08-12 实测修正，最小集）**：resources/app **顶层全部 `*.node` + `*.dll`**
  （wrapper.node 的直接/传递/delay-load 依赖全覆盖，版本无关；跳过 wmpfsdk/avsdk 等
  大子目录，约 235MB）：

```
<数据根>/qq-files/<版本>/versions/<版本>/resources/app/
└── wrapper.node / major.node / *.dll（libvips-42 / libglib-2.0-0 / crypto / …）
```

- **提取产物校验**：`wrapper.node` 存在 + 目录结构完整（dlopen 冒烟由 launcher 启动流程天然覆盖）。

### 2.4 与现有 locate-qq.ts 的关系

- `locate-qq.ts` 保留本机探测逻辑（L1），新增：
  - `resolveQqFiles()`（多级来源统一入口，**P1 起为 async**——自动下载是异步流程）；
  - `ensureQqFiles()`（下载 + 解包 + 校验 + 缓存，幂等：缓存命中直接返回）。
- `QqInstallInfo` 扩展：`source: "local" | "cached"`，`wrapperPath` 定位逻辑复用。

### 2.5 Linux deb 管线（Stage 2，2026-11-09）

Linux 原生宿主不下载 Windows exe，改下载官方 **deb**，并在缓存里合成 Windows 同构布局
（kernel `resolveWrapperPath` / ADR-018 路径不变）：

```
<数据根>/qq-files/3.2.35-54395/versions/3.2.35-54395/resources/app/
├── wrapper.node / major.node
├── *.so / *.so.N（libbugly / libcrbase / libunwind / libssh2 …）
├── sharp-lib/**            # wrapper.node RUNPATH: $ORIGIN:$ORIGIN/sharp-lib
└── pub.key / cacert.pem / package.json / application.json
```

- **清单 schema 2**（`qq-releases.json`）：条目新增 `platform: "win32" | "linux"`（缺省
  win32，旧条目兼容）、`arch: "x64" | "arm64"`（缺省 x64）、`coreVersion`（Linux
  `3.2.35-54395` 对应 `9.9.37`；Windows 缺省 = `version`）。`version` 始终是缓存目录名 /
  `app_version`：Windows 为 `9.9.33-51802`，Linux 为客户端版本 `3.2.35-54395`。
- **版本选择**：`latestRelease(releases, { platform, arch })` 先按平台/架构过滤再取末项
  ——清单混装 exe 与 deb 后不能再直接取数组末项。
- **deb 解包（3 层，7-Zip 25.01 实测支持 Ar）**：`7zz x deb` → `data.tar.xz` →
  `7zz x data.tar.xz` → `data.tar` → `7zz x data.tar` → `opt/QQ/resources/app`。
  中间产物（`data.tar` ~600MB / `data.tar.xz` 188MB / control）解完即删。
  不再依赖 `dpkg-deb`，只用内置 `assets/7zip/7zz`。
- **提取白名单**：顶层 `*.node` / `*.so` / `*.so.N` + `pub.key` / `cacert.pem` /
  `package.json` / `application.json`；`sharp-lib/` 整体保留。跳过 `avsdk/`（50MB）、
  `resource/`、`application.asar` 等与无头 wrapper 无关的目录。
- **ELF 守卫**：Linux 平台下 `resolveFromRoot` 校验 `wrapper.node` 魔数，
  误指向 `/mnt/c` 的 Windows 安装（PE）立即报可读错误，而不是等 `dlopen` 报
  invalid ELF header。
- **下载 URL**：官方 `linuxConfig.js`（`x64DownloadUrl.deb` / `armDownloadUrl.deb`），
  同样经 `normalizeDownloadUrl` 处理 `/QQNTV2/` 大小写；基线 x64 deb
  `QQ_3.2.35_261103_amd64_01.deb`（188,287,504 字节，sha256 `7de0386…f9ac`）。
- **清单自动更新（2026-11-10 起）**：`tooling/qq-releases/update-qq-releases.ts` 除了
  Windows rainbow 配置，还会抓官方 `linuxConfig.js`，按 x64 deb 的 URL 变化自动更新
  `platform: "linux"` / `arch` / `coreVersion` / `sha256`（版本号从 deb 内
  `resources/app/package.json` 取，appid 沿用清单里已有值；URL 未变则不下载）。
  **arm64 暂不自动登记**——按既定策略要等真机验证（arm64 stub 入私有 `native/`、
  loader 预加载 libuuid、清单条目三件事一起做），真机通过后把
  `LINUX_MAINTAINED_ARCHES` 加上 `arm64` 即可（deb URL 与解析已就绪）。
- **暂未覆盖**：arm64 条目的自动登记——符号、解包与加载/引擎初始化已验（见
  `docs/architecture/linux-native-host.md` §9.11 与附录 E.1），但仍缺私有 `native/` 的
  arm64 stub 产物与真机运行，按既定策略三件事（stub 入包、preload `libuuid`、清单条目）
  等真机后一起做（附录 E.2）。解包工具链的架构问题已由 §11 修掉；本地 `/opt/QQ` 扁平安装
  已在 §3.5 实现。

---

## 3. G2：Linux 支持（原生 ELF 自建宿主，ADR-027）

### 3.1 形态

```
Linux 主机（无 QQ 安装）
  └─ 系统 node（官方 ELF 可执行）
       └─ LD_PRELOAD=<libnapuketto_stub.so>:<libgnutls.so.30>
            └─ process.dlopen(官方 Linux wrapper.node)   ← ELF，宿主符号走 node 全局符号表
                 → O3MiscService 激活 → 登录 → session READY → 协议装配
```

- 只补 3 个符号：`qq_magic_napi_register` / `node::IsEnvironmentStopping` / `PerfTrace`；
  Windows 那 98 条 PE export forwarder 在 Linux 归零（研判数据见
  [`docs/architecture/linux-native-host.md`](../../../docs/architecture/linux-native-host.md) §1）。
- **不需要**：Wine、Windows 版 `node.exe`、`WINEPREFIX` / DPAPI、`Z:\` 路径转换、PATH 前置。
- **失败提示**：stub 缺失 / gnutls 缺失 / node 缺失分别抛可读错误，不进入 spawn。

### 3.2 launcher 的平台分支

| 平台 | 宿主 | stub | 额外注入 |
|---|---|---|---|
| win32 | 本机 node（非 node 宿主如 Bun 先解析真 `node.exe`） | `QQNT.dll`（PATH 前置 + `STUB_DIR`） | — |
| linux | 系统 node（`process.execPath` 是 node 直接用，否则 `which node`） | `libnapuketto_stub.so`（`LD_PRELOAD`） | `LD_PRELOAD` / 受管 `HOME` + `XDG_*` |

- 环境变量装配（`buildLaunchEnv`）两平台共用，**不做任何路径转换**。
- `NAPUTO_LINUX_NATIVE` 已随 ADR-027 退役：Linux 恒走原生分支，设 `0` 只播报一句提示。

### 3.3 stub 与打包

- **stub**：`native/build/linux-<arch>/libnapuketto_stub.so`（私有 native 产物），
  `NAPUTO_LINUX_STUB` 可覆盖；只 3 个导出符号。
- **预加载**：`LD_PRELOAD=<stub>:<libgnutls.so.30>`。gnutls 是 `libbugly` 的无
  `DT_NEEDED` 隐藏依赖；Ubuntu 24.04 包名 `libgnutls30t64`，Debian 12 为 `libgnutls30`。
- **打包（2026-11-10 补）**：`files` 必须同时含 `native/build/stub-test-env`（Windows）
  与 `native/build/linux-x64`（Linux）——只列前者时 tarball 里没有
  `libnapuketto_stub.so`，Linux 启动会直接报「Linux stub 未找到」（0.6.0 发布包实测如此）。
  双重守卫：`release.yml` 发布前 `npm pack --dry-run` grep
  `native/build/linux-x64/libnapuketto_stub.so`；`tooling/package-exports.test.ts`
  断言 `files` 含该目录。
- **与 kernel 的衔接**：kernel 按 `process.platform` 生成 KLINUX engine/session 配置并从
  `major.node` 扫 qua；loader 只负责进程与预加载。`bootEnv` 额外带 `dataRoot`
  （`NAPUTO_DATA_ROOT`），kernel 据此把 QQ 数据根固定到 `<数据根>/nt_qq`，不再读写
  `$HOME/Documents/Tencent Files`。

### 3.4 HOME/XDG 收敛（Stage 3c，2026-11-09）

`desktopGlobalPath` 只覆盖 QQ 自己的数据，原生层仍有不经它的落盘——`libbugly` 的
`NativeCrashHandler` 无条件使用 `$HOME/.config/QQ/crash_files/`。因此把子进程 `HOME`
收敛到 `<数据根>/home`（`NAPUTO_LINUX_HOME` 可显式覆盖；无数据根时退到
`<账号目录>/home`），并把 `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
`XDG_STATE_HOME` 一并指到该目录下（`XDG_RUNTIME_DIR` 不接管：那是 dbus/会话级目录，
语义不同）。

strace 实测（2026-11-09）：Bugly 只读 `$HOME`、**不读 `XDG_CONFIG_HOME`**，所以关键变量是
`HOME`；改 `HOME` 后 `mkdir .config/QQ/crash_files` 落在受管目录，快速登录仍成功
（登录票据在 `<数据根>/nt_qq`，与 `HOME` 无关）。win32 分支不做此收敛（Windows 数据目录
已由 `desktopGlobalPath` 管住）。

实现：`src/linux-native.ts`（纯函数）+ `launcher.ts` 的 `launchLinuxNative`；
Stage 0b 已在 Linux QQ 3.2.35 / QQNT 9.9.37 上验证登录 + session READY。

### 3.5 本地 deb 安装（Stage 3d，2026-11-09）

Linux 优先识别扁平布局 `/opt/QQ`（`NAPUTO_QQ_DIR` 可覆盖）：`<根>/qq` +
`<根>/resources/app/wrapper.node`，版本号取自 `resources/app/package.json`。命中即用本机
安装，省掉 190MB deb 下载。校验 ELF 魔数（防 WSL 下误指 `/mnt/c` 的 Windows PE 安装）
与版本字段（缺失就跳过，不瞎填——版本参与登录）。

### 3.6 历史：Wine 方案（已删除，2026-11-14）

2026-08 的方案是「Wine 跑 Windows 版 `node.exe` + PE stub `QQNT.dll`」，并为此实现了
`toWinePath` / `unixPathToWinePath` / `wineBinary` / `wineCheckError` /
`buildSpawnCommand` 与两个 `tooling/wine/*` 冒烟脚本。ADR-027 删除了全部代码：Linux 的
QQ 文件获取早已按 `process.platform` 只选 deb + ELF，Wine 分支实际只对「手边有 Windows
版 QQ 安装」的 WSL 开发环境成立，而原生 ELF 路线在登录 / 收发 / 富媒体 / 文件投递上均已
实测。需要追溯时查 git 历史（关键字 `toWinePath`）。

---

## 4. G3：Docker 镜像（⚠️ 未实现/规划，全仓库无 Dockerfile）

### 4.1 镜像设计（不内置腾讯二进制）

镜像只带自研产物 + 系统运行库，`wrapper.node` 仍由运行时下载官方 Linux deb 解包获得
（ADR-019「不内置腾讯二进制」原则不变）：

```
Dockerfile.linux
  FROM node:24-slim
  RUN apt-get install -y libgnutls30 libx11-6 libxext6 libx11-xcb1 libxcb1 tar xz-utils
  COPY 自研代码（dist 产物 + stub .so）        # stub 是自研，可内置
  VOLUME /app/.napuketto                      # 数据卷：账号数据 + nt_qq + qq-files 缓存
  ENV NAPUTO_DATA=/app/.napuketto
  ENTRYPOINT ["node", "apps/cli/dist/index.mjs"]
```

**平台支持**：第一版只承诺 `linux/amd64`；arm64 待真机验证（linux-native-host 附录 E.2）。

**首次启动**：loader 自动下载官方 deb（约 180MB）→ 解包 → 缓存进数据卷；后续启动秒级。

### 4.2 使用形态

```bash
# 构建
docker build -f Dockerfile.linux -t napuketto/qq .

# 运行（数据卷持久化：QQ 文件缓存只下载一次）
docker run -d \
  -v napuketto-data:/app/.napuketto \
  -p 8080:8080 \
  napuketto/qq --config /app/.napuketto/napuketto.toml
```

- 数据卷必须挂载，否则每次重建容器都重新下载。

---

## 5. 文件与模块划分（改动集中 loader 包）

```
packages/loader/
├── qq-releases.json          # 新增：版本清单（URL + sha256 + appid，纯文本）
├── src/
│   ├── locate-qq.ts          # 改：保留 L1 本机探测；新增 resolveQqFiles/ensureQqFiles
│   ├── qq-download.ts        # 新增：官方安装包下载（https + sha256 校验 + 断点续传可选）
│   ├── qq-extract.ts         # 新增：7z 解包 + 提取 wrapper.node/QQNT.dll/major.node
│   ├── win-node.ts           # 新增：Windows 版 node.exe 获取（下载/解压/缓存/覆盖）
│   ├── launcher.ts           # 改：spawn 平台分支（win32 / linux 原生 ELF）
│   └── index.ts              # 改：导出新模块
├── Dockerfile.linux          # 新增（仓库根或 loader 包内）
├── docker/entrypoint.sh      # 新增
└── docs/design.md            # 本文件
```

**依赖**：loader 现有依赖不变（无新增运行时 npm 依赖）；`qq-download.ts` 用 Node 内置
`https`/`crypto`（sha256）实现，不引第三方（与「无内部依赖」风格一致）。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 官方链接漂移（腾讯改 URL/下线版本） | 🟡 中 | **CI 自动爬官方下载页**（§2.2）+ `NAPUTO_QQ_URL` 覆盖；错误信息明确提示去更新清单 |
| 系统库缺失（`libgnutls30` / `libx11` 等） | 🟡 中 | spawn 前校验 gnutls、缺失即抛可读错误（含发行版包名）；`dlopen` 缺库按 §3 表补 |
| **反风控环境特征（核心风险）** | 🔴 高 | 原生 Linux 宿主的注册表 / MAC / 硬盘序列号特征与 Windows 不同。对策：快速登录 / 扫码 / 收发 / 富媒体 / 文件均已在真机（WSL2 + 官方 Linux QQ）实测通过；异常时评估进程名伪装 / 环境模拟（仅限 loader 私有 native 组件） |
| 首次下载慢 / 网络被墙 | 🟡 中 | sha256 校验保证完整性；`NAPUTO_QQ_FILES` / `NAPUTO_QQ_DIR` 支持预置目录（用户手动拷贝绕过下载） |
| 镜像体积 | 🟢 低 | 镜像只装系统运行库，QQ 文件放数据卷不进镜像（§4，未实现） |
| ARM 真机未验证（后置） | 🟢 低 | 第一版只承诺 amd64；arm64 加载 / 引擎 / 登录握手已在 qemu 验证（linux-native-host 附录 E） |

---

## 7. 实现顺序（设计先行，逐模块推进）

> 每个模块完成跑一次 `pnpm check`。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** ✅ | `locate-qq.ts` 多级来源 + `resolveQqFiles`（L0/L1/L2 纯定位，不下载） | Windows 本机路径回归不破 |
| **P1** ✅ | `qq-releases.json` + `qq-download.ts` + `qq-extract.ts`（下载→校验→解包→缓存） | Windows 上删掉本机 QQ 探测也能跑起来（用缓存） |
| **P2** ✅ | `launcher.ts` 平台分支（win32 / linux 原生 ELF） | Linux 端到端：原生 node + stub `.so` → dlopen wrapper.node → 登录 → session READY（已实测，见 linux-native-host.md） |
| **P3** ⏳ | Dockerfile + entrypoint + 文档（**未实现**） | `docker run` 全链路跑通（数据卷持久化验证） |

---

## 8. 已拍板细节（2026-08-12 技术栈讨论结论）

1. ~~**wine 版本**：`wine-stable`（发行版默认）；Docker 仅 `wine64`。~~ **已废止（ADR-027）**：Wine 退役。
2. ~~**路径映射**：`toWinePath` 纯函数入 launcher（§3.2）。~~ **已删除（ADR-027）**：Linux 原生宿主无路径转换。
3. **版本探测**：已立项，实测官方下载配置 JSON（SPA 数据源）可读（§2.2）；CI Cron 自动更新清单已落地（`tooling/qq-releases/update-qq-releases.ts` + `.github/workflows/update-qq-releases.yml`）。
4. **下载实现**：Node 内置 `https` + `crypto`（sha256），无第三方依赖。
5. **解包工具**：内置 `7za.exe`（LGPL 合规可分发）+ Linux/Docker 系统 `p7zip-full`（非 x64 Linux 回退系统 7z，§11）。
6. **ARM**：第一版只承诺 `linux/amd64`，ARM 列后置 P2/P3（qemu 已验证加载 / 引擎 / 登录握手）。
7. ~~**DPAPI**：WINEPREFIX 必须随数据卷持久化。~~ **已废止（ADR-027）**：票据在 `<数据根>/nt_qq`。
8. **反风控**：P2 阶段第一优先 = 快速登录/扫码登录冒烟测试。

**遗留待实现时确认**：
1. `qq-releases.json` 放 loader 包内 vs 单独维护（先放包内，后续量大再拆）。
2. `resolveQqInstall` 的 API 兼容：保留旧签名导出，新入口 `resolveQqFiles` 并行存在，待 cli/koishi 适配器切换后再移除旧入口。

---

## 8.1 内联配置与退出码 78（2026-10-25 嵌入式契约）

主配置来源优先级全链统一：`NAPKETTO_CONFIG_JSON`（内联 JSON，与 napuketto.toml
同构）> `NAPKETTO_CONFIG`（文件）> `NAPUTO_CFG_DIR` 兜底。内联分支
（`load-config.ts` 的 `readInlineConfigDoc`）零 toml 文件读取，`cfgFile` 返回哨兵
`"<inline>"`（仅作来源标注；seed 模式本就不读盘，协议段热更新内联形态不可用），
`log-cfg.ts` 的 `[log]` 段同源。引导链对内联坏值宽松（记日志回退文件形态）——
cli 主路径已在拉起前完整校验并以 78 退出，宽松只服务绕过 cli 的直跑场景。

退出码：协议段 seed 的 zod 校验失败（`assemble-protocols.ts` 的 `parseSeed`）包装为
`ConfigError`（loader 不静态依赖 kernel，按错误名 `ConfigError` 复刻契约），
沿 `startProtocols` → `bootstrap` 重抛（唯二重抛点），`self-host.ts` 以 78
（EX_CONFIG）退出——宿主据此区分「配置未就绪」与运行时崩溃（1），supervisor
识别 78 不守护重启。

## 9. IPC 模式与 OB11 容器可选装配（2026-08-27）

`src/host/ipc/`：koishi 插件子进程模式（`NAPUTO_IPC=1`，stdout JSON 行 + stdin
action/control）。登录前启动 stdin 服务端（login.refreshQr 可达），登录后
`attachIpcServices` 把 kernel 服务动作（`msg.sendMessage` 等点分域）并入同一张
共享动作表，事件通道经 `sendEvent(service, name, args)` 透出。

**编码规整（2026-10-24）**：`JSON.stringify` 对 Map/Set 内容全丢（Map → `{}`、
Set → `[]`）——事件 args（`videoElement.thumbPath Map<0, path>`）与动作结果
（如 `uinToUid` 的 `Map<qq, uid>`）跨进程即丢，koishi 插件侧读 `thumbPath.get(0)`
直接 TypeError（线上事故）。`encodeIpcMessage`（`ipc-codec.ts`）统一先过
`toJsonSafe`（`json-safe.ts`，幂等深规整：Map → 平面对象、Set → 数组、环引用
丢分支；非普通对象原样交 stringify）再序列化；`ipc-sender.sendIpc` 也改走
`encodeIpcMessage` 单一出口。协议行前缀（`native-noise.ts` 的 `IPC_LINE_PREFIX`）
不受影响。

### 9.1 OB11 容器可选装配（ipc-ob11.ts）

**触发条件**：IPC 模式 && `NAPUTO_ADAPTER_ENTRY` + `NAPUTO_NETWORK_ENTRY` 已注入
（koishi 插件 launcher 透传；cli 协议模式不走本分支，行为零变化）。

**装配**（`attachOb11IpcBridge(actions, services)`，`attachIpcServices` 之后调用，
fail-soft——import/构造失败只 log 降级，不阻断登录链路）：

1. 动态 import `{NETWORK_ENTRY}`（EventBroadcaster）、`{ADAPTER_ENTRY}` 派生的
   `onebot11/index.mjs` / `core/index.mjs` 子路径（assemble-protocols.ts 同款
   最小接口面声明——loader 编译期零 adapter/network 静态依赖，不违反依赖方向）。
2. `ProtocolConfig` 以 `seed = ob11ConfigSchema.parse({})` 构造（缺省段），
   `load()` 直接返回内存初值——**不读不写任何配置文件**（ConfigBase seed 语义）。
3. 实例化 `NapukettoOneBot11Adapter`：九个 kernel api + self + groupCache +
   `msgChannel = services.channel` + system 最小面（appVersion 来自
   `NAPUTO_QQ_VERSION`；cleanCache 走 kernel PathWrapper；bot_exit/set_restart
   同 cli 模式 process.exit(0)，由插件 driver 重启机制接管）。
4. 调 adapter **`subscribeOnly()`**（公共方法，本特性为 adapter 唯一新增面）：
   订阅 `Msg/onRecvMsg` 维护 messageUnique + 灰色通知翻译；**不装配网络传输 /
   不起心跳 / 不广播 lifecycle**（与 `start()` 的差别仅在传输层）。
5. `adapter.registry`（公共只读）遍历全部动作名平铺合并进共享 IPC 动作表：
   handler = `(params) => act.handle(params)`——OB11 信封（status/retcode/data/
   message）与 zod 校验 + 错误码映射在 `BaseAction.handle` 内完成。动作名空间
   不冲突：kernel 动作点分命名（`msg.sendMessage`），OB11 snake_case（`send_like`）。
6. broadcaster 挂一个仅 `send` 的桥适配器 → `sendEvent("ob11", post_type,
   [事件对象])` 透出 OB11 格式事件。
7. 返回 stop 函数：broadcaster 注销 + adapter `unsubscribeOnly()`。

**可注入依赖**（`deps` 参数）：importModule / emitEvent / env / log——单测无需
真实文件与子进程。

---

## 10. 登录控制相位机与 ready 态软重登（2026-09-08 A1/A2）

`src/host/core/relogin.ts`：control login（koishi 面板「重新登录/扫码登录」→
IPC control 指令）的成功结果按**引导相位**分派，取代 2026-09-08 T2 的
「无条件 sendLogin(logged_in) + preemptRef 接管」。

### 10.1 相位机（LoginControl）

```
login-race ──竞速 settle──→ assembling ──装配成功──→ ready（软重登窗口）
     │                          │
     └────── 任一失败路径 ──────→ aborted（进程将退出）
```

| 相位 | control login 成功结果的处理 |
|---|---|
| login-race | ① **登录期抢占**：sendLogin(logged_in) + 经 preemptRef 接管初始 doLogin 竞速（T2 既有语义：快速登录风控挂起时强制扫码也能走完装配链） |
| ready | ② **软重登**：`deps.reassemble` 清理旧装配面 → 用新登录结果重跑装配链 → 重播 sendStatus(ready) + sendLogin(logged_in, 新 selfInfo) |
| assembling / aborted | ③ **忽略**（仅日志）——A1 修复：引导失败进程将退出时无条件上报 logged_in 会制造 failed→logged_in 误导序列（koishi driver 收到 logged_in 但子进程无协议装配，上线后所有请求失败）；装配进行中的并发结果同样不干扰初次装配 |

- **互斥（防重入拍板）**：control login 全程 claim/release 互斥——在途登录/
  重装配期间的新指令直接忽略（仅 boot 日志留痕，不发登录消息，面板随首个
  流程的真实状态收敛）。排队方案否决：软重登窗口短（秒级）且登录本身可长
  时间在途（等扫码），排队会让面板状态与实际流程脱节。
- 失败路径：core.login null/抛错 → sendLogin(failed)；软重登重装配失败 →
  sendStatus(failed) + process.exit(1)（旧服务已清、新服务未立，进程不可再
  用，交 koishi driver 重启循环回收）。

### 10.2 重装配（bootstrapWithCore 的 softRelogin 闭包）

清理顺序（协议消费方 → 事件转发 → kernel 层）：

1. `attachOb11IpcBridge` stop：broadcaster 注销 + `unsubscribeOnly()` +
   **OB11 动作表条目移除**（重挂前必先停旧，snake_case 与 kernel 点分命名
   不冲突）
2. `attachIpcServices` stop：三条通道 forwardChannel 退订 + **kernel 动作表
   条目移除**
3. `KernelServices.dispose()`（kernel-services.ts 新增清理面，幂等）：
   Msg/Group/Friend 三桥 `unregister()` + GroupCache `unregister()` +
   消息日志退订（setupMsgLogging 改返回退订函数）

重装配（`runAssembly`，与初次引导共用）：replaceSession（自建宿主恒 null）→
activateSession（幂等：session 已激活跳过——同账号软重登保留 session；**跨
账号 session 有效性未实测**，由 koishi 侧 checkIdentity 拒绝换账号兜底）→
waitSessionReady → sendStatus(sessioning) → startProtocols →
attachIpcServices → attachOb11IpcBridge。初次引导额外含 NAPUTO_SMOKE 冒烟
（一次性，重装配不跑）。

cli 模式（非 IPC）无 control 通道，不触达软重登；为完整性
`assembleOb11AndSatori` 改返回 ob11/satori 适配器 stop（存
`services.stopAdapters`），并修复内部 catch 吞错——装配失败现在正常抛给
startProtocols 判引导失败退出（回归 2026-09-06 的设计意图）。

### 10.3 koishi 侧配合（koishi-plugin-adapter-napuketto 独立仓）

- 决策表（login-actions.ts）：登录期 + **logged_in（ready 态）** + client
  可用 → control login（plan 携带 soft 标记）；failed / client 不可用 →
  restart 不变。
- **换账号防线**：driver 的 ready 幂等守卫使软重登完成后 onReady 不重触发，
  checkIdentity 改由登录消息面补位——logged_in 携带 selfInfo 时（driver-events
  `onLoggedIn` → bot.handleLoggedIn）复核账号一致性，不一致拒绝上线（同
  2026-08-20 生产事故防线）；同账号通过并同步昵称刷新。

## 11. 解包工具与架构（2026-11-10）

内置 `assets/7zip/7zz` 是 **x86-64 ELF**（`e_machine=0x3e`），`7z.exe` 是 x64 PE。
在 Linux arm64 上 exec 内置 7zz 会直接 `cannot execute`（arm64 容器实测），所以解包
工具的选择按架构分流：

- `bundledSevenZipSupported(platform, arch)`：Linux 仅 `x64` 用内置资产；Windows 不受
  此处限制（资产是 x64 PE，arm64 Windows 不在支持面）。
- `findSystemSevenZip(path)`：按 PATH 扫 `7zz` → `7z`（Windows 只找 `7z.exe`），
  找到即用。
- `findSevenZip()`：`NAPUTO_7Z_PATH` > 内置（适用架构）> `findSystemSevenZip()`。
- `ensureLinuxSevenZip({ arch })`：非 x64 **跳过**内置、数据根缓存与官网下载（三者都是
  x64 产物），直接用系统 7-Zip；一个都没有时抛可读错误（提示 `apt install 7zip` /
  `p7zip-full`，或用 `NAPUTO_7Z_PATH` 指定）。

即：x64 Linux 行为不变（继续用内置 7zz，零网络依赖）；arm64 等非 x64 需要系统 7-Zip。
arm64 交付前的其余缺口（stub 入包、libuuid 预加载、清单条目、真机验证）见
[`docs/architecture/linux-native-host.md`](../../../docs/architecture/linux-native-host.md) 附录 E.2。

## 12. 协议隔离：一协议一广播器（2026-11-10）

**缺陷（真机复现）**：`assemble-protocols.ts` 曾用**单个** `EventBroadcaster` 传给
OB11 / Satori / Milky 三个适配器，各协议把传输注册到同一实例 → 任一协议 `emit` 的
事件会推给**所有**协议的 HTTP/WS 客户端。表现：只配 `[accounts.onebot11]` 的账号，
OB11 的 WS（39002）在合法心跳（`post_type: meta_event`）之间收到
`{"op":0,"body":{"sn":2,"type":"message-created",...}}` 的 Satori 形态事件；反向同理。
多协议同时启用时事件流不可判型（客户端按 `post_type` / `op` 判型必踩错分支），属
**协议隔离缺陷**，不是日志噪音。

**修法**：

1. **一协议一广播器**：`ob11Broadcaster` / `satoriBroadcaster` / `milkyBroadcaster`
   各自 `new EventBroadcaster()`，只传给对应 adapter 的 `broadcaster` 选项——传输
   注册与事件发布都收在本协议内。
2. **Kurobot 无广播器**：纯客户端出向协议（连出 kurobridge-ws，无第三方接入门面、
   不发协议事件），不参与广播隔离面。
3. **Satori 段存在才装配**：`assembleSatori()`（段空返回 `null`；分支内建独立广播器
   并 start），与 kurobot / milky 同一范式（「段存在即启用、不写不启用」）；`cacheDir`
   缺省逻辑留在函数内。此前无条件装配：未配置 satori 的账号也会订阅 kernel 事件并向
   空传输广播。`satori` 变量改 `| null`，teardown 判空后 `stop()`。
4. **IPC 桥不动**：`ipc-ob11.ts` 的广播器是独立进程边界上的 OB11 事件出口
   （§9.1），与 CLI 协议装配互不相干。

**单测**（`assemble-protocols.test.ts`）：只有 `[accounts.onebot11]` 时 satori
构造器零调用、不 start；OB11 + Satori 同时启用时两者收到的 broadcaster 不是同一
实例（隔离语义）。
