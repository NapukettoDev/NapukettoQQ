# @napuketto/loader 设计（v2：跨平台 + 无本机 QQ 运行）

> **状态**：设计稿（2026-08-12）。配套主仓库 `docs/STATUS.md` / `docs/architecture.md`。
> 设计先行——本文件定稿后再实现，实现顺序见 §7。
>
> **用户拍板（2026-08-12，含技术栈逐条确认）**：
> 1. **绝不内置腾讯二进制**——wrapper.node / QQNT.dll / 官方安装包都不得进入 npm 包、Docker 镜像或任何发布产物；文件必须在用户机器上运行时获取。
> 2. **只接受方案 a**（wine 跑 Windows 版 node.exe + stub + dlopen wrapper.node），不接受方案 b（wine 跑完整 QQ NT）。
> 3. **架构事实确认**：整个业务栈（kernel + adapter + network + cli）都在 wine 内跑 Windows node.exe，对外只暴露**无状态的标准 OneBot11/Satori 网络协议端口（localhost）**——高内聚低耦合，符合云原生微服务理念。
> 4. **wine 版本 = wine-stable**（或发行版默认）；Docker 内仅 `wine64`（省 100MB+ 镜像体积）。不追新：QQNT 核心不依赖 wine-devel 特性，稳定优先防 regression。
> 5. **路径映射确认**：launcher 层必须做 Linux 路径 → wine `Z:\` 路径转换（`toWinePath`），写入 §3.2。
> 6. **版本清单自动化立项**：探测腾讯公开版本接口/官方下载页，有则 CI 自动更新，无则人肉维护 + `NAPUTO_QQ_URL` 兜底。**2026-08-13 实测：官方下载配置 JSON（SPA 数据源）可读，探测方案可行**（见 §2.2）。
> 7. **下载实现 = Node 内置 `https` + `crypto`**（无第三方依赖，轻依赖即美德）。
> 8. **解包工具 = 内置 `7za.exe`**（LGPL 可分发，Windows 纯净环境兜底）+ Linux/Docker 用系统 `p7zip-full`。
> 9. **ARM = 第一版只承诺 `linux/amd64`**，ARM（M1/M2/树莓派）列为后置 P2/P3。
> 10. **DPAPI/票据持久化**：wine 的 DPAPI 用随机本地密钥模拟——**wine 容器/`WINEPREFIX` 被销毁则登录状态丢失**，需提示用户持久化哪些路径（见 §6）。
> 11. **反风控为核心风险**：P2 阶段立刻推进快速登录/扫码登录冒烟测试，尽早试探腾讯风控对 wine 环境的容忍度。
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

- 自建宿主（路线 A）是唯一实现方式：标准 Node + stub QQNT.dll 转发 → `process.dlopen(wrapper.node)`。
- 当前 `locate-qq.ts` 只支持 **Windows 本机已装 QQ** 的场景：注册表 / 常见路径 / `NAPUTO_QQ_PATH`，找不到就抛错。
- stub QQNT.dll 是 **PE 格式**，Linux 加载器不认 → Linux 上必须靠 wine 的 PE 加载能力。

### 1.2 三个目标

| # | 目标 | 解决的问题 |
|---|---|---|
| G1 | **本机无 QQ 也能运行** | 用户机器没装 QQ NT（或装了但被卸载），无需手动安装 |
| G2 | **Linux 支持（方案 a）** | 服务器 / 无 GUI 环境跑机器人 |
| G3 | **Docker 镜像**（⚠️ 未实现/规划） | 一键部署，`docker run` 即用 |

### 1.3 硬约束（违反 = 错误）

1. **不内置腾讯二进制**：所有发布产物（npm 包 / Docker 镜像 / 仓库文件）不得包含
   `wrapper.node`、`QQNT.dll`、官方安装包 `.exe`、`major.node` 等腾讯文件（含压缩/编码形式）。
2. **不内置 NapCat 代码**（GPL-2.0-only 与 MIT 不兼容，AGENTS.md 红线不变）。
3. **只接受 wine 方案 a**：Linux 上 = wine 跑 Windows 版 node.exe + stub + dlopen wrapper.node，
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
- **依赖预检（2026-08-23 事故后新增）**：Linux 分支 spawn 前预检 wine
  （`spawnSync wine --version`），缺失时抛可读错误（含 `apt install` 指引）并挂
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
  - Cron Job（每日）调 `scripts/qq-releases/update-qq-releases.ts`（CI/本地共用）→ 抓配置 → 下载算 sha256
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

---

## 3. G2：Linux 支持（方案 a：wine + Windows node.exe）

### 3.1 形态

```
Linux 主机（无 QQ 安装）
  └─ wine（系统包，模拟 Windows PE 加载）
       └─ Windows 版 node.exe（从 nodejs.org 官方下载，非腾讯二进制）
            └─ 标准 Node 自建宿主链路（与 Windows 完全一致）：
               PATH 前置 stub 目录 + wrapper.node 目录
               → process.dlopen(wrapper.node)
               → O3MiscService 激活 → 登录 → session READY → 协议装配
```

- **Windows 版 node.exe 来源**：`https://nodejs.org/dist/<版本>/node-v<版本>-win-x64.zip`（Node 官方，非腾讯）。
  与腾讯二进制不同——这是**开源软件官方发行版**，但为保守起见同样**不内置**，运行时自动下载到
  `<数据根>/runtime/win-node/`（可被 `NAPUTO_WIN_NODE_PATH` 覆盖）。
  > ⚠️ **升级 Windows node 需手动改常量**：`win-node.ts` 的 `DEFAULT_WIN_NODE_VERSION`（当前
  > `v24.16.0`）为兜底版本（`NAPUTO_WIN_NODE_VERSION` 可覆盖）。nodejs.org/dist 保留历史版本
  > 不会 404，但 pin 死旧 patch 收不到安全更新——升级 node 时记得同步 bump 该常量。
- **wine 来源**：Linux 用户用系统包管理器安装（`apt install wine` 等）；Docker 镜像内预装（G3）。

### 3.2 launcher 的平台分支

```ts
// launcher.ts：spawn 命令平台分支
const nodeBin = process.platform === "win32"
    ? process.execPath                                    // Windows：本机 node
    : await ensureWinNode();                              // Linux：wine + win node.exe
// spawn 参数：
//   win32: [selfHostPath]
//   linux: ["wine", winNodePath, selfHostPath]
```

- PATH 装配逻辑**不变**（stub 目录 + wrapper.node 目录前置），wine 会把这些目录当作 Windows PATH 解析。
- 环境变量透传逻辑不变（`buildLaunchEnv` 复用）。

**路径映射（toWinePath，2026-08-12 拍板确认）**：

Windows 版 node.exe 在 wine 内把整个 Linux 根目录挂载在 `Z:\`。`process.dlopen` 收到的是 wine 视角的 Windows 路径，而现有代码里 `wrapperPath` / stub 目录 / cfgDir 都是 Linux 路径。launcher 层必须做转换：

```ts
// launcher.ts 内部：Linux 路径 → wine Z:\ 路径
function toWinePath(linuxPath: string): string {
    // 例：/app/.napuketto/qq-files/9.9.33/wrapper.node → Z:\app\.napuketto\qq-files\9.9.33\wrapper.node
    // 注意反斜杠转义 + 去除前导 /；wine 自动把 Z:\ 映射到 Linux 根目录
    return "Z:\\" + linuxPath.replaceAll("/", "\\").replace(/^\\/, "");
}
```

- **用途**：`NAPUTO_WRAPPER_PATH` / `NAPUTO_CFG_DIR` / stub 目录 / self-host.cjs 路径等**所有传给 wine 子进程的环境变量与参数**都要过 `toWinePath`。
- **实现位置**：launcher.ts（高内聚，单独纯函数可单测）。

### 3.3 关键验证点（2026-08-12 WSL2 实测，全绿）

| 验证点 | 结果 | 实测记录 |
|---|---|---|---|
| wine 跑 Windows node.exe | ✅ **通过** | `wine node.exe -e "..."` → `win-node-ok x64 v24.16.0`（process.arch=x64 证明 PE 二进制） |
| stub QQNT.dll PE Export Forwarding 生效 | ✅ **通过** | wine 下 dlopen wrapper.node → **98 exports**（NodeIQQNTWrapperEngine / NodeIKernelLoginService 全在） |
| wine 下 dlopen wrapper.node | ✅ **通过** | `const m={exports:{}}; process.dlopen(m, wrapper.node)` → 98 exports |
| 登录 + session READY | ⏳ 待测（Step 2：完整 self-host 登录冒烟） | 需要账号 + 快速登录/扫码 |
| 无头 | ✅ 自建宿主本就不依赖 UI | wine 无窗口跑 |

**⚠️ 实测坑（必须记住）**：wine 读 **DrvFS（/mnt/c）会 "File not found"**（文件在 Linux 侧 `ls` 正常，但 wine `dir` 看不到）——
**QQ 文件必须放 ext4 文件系统**（WSL 原生 `~/...`）。验证过程：复制到 `~/.qqfiles/`（ext4）后 wine 正常读取。
这正是设计里「数据根/qq-files 缓存」放 Linux 原生路径的实证。**Docker 场景无此问题**（容器内天然 ext4）。

**dlopen 参数形态（实测）**：`const m = { exports: {} }; process.dlopen(m, wrapper.node)`——
直接传 `{ exports: {} }` 字面量会报 `Cannot convert undefined or null to object`（wrapper 需要 module 对象载体）。

> 若冒烟发现某个环节 wine 不支持（理论风险低），回退手段：该环节改用 wine 的
> `winedbg`/调试工具定位；不切换方案 b（用户拍板）。

---

## 4. G3：Docker 镜像

### 4.1 镜像设计（不内置腾讯二进制）—— ⚠️ 未实现/规划（全仓库无 Dockerfile / docker/ 目录）

```
Dockerfile.linux
  FROM node:22-slim（仅 wine64，不装 wine32，省 100MB+）
  RUN apt-get install -y wine64 p7zip-full   # wine64 + 解包工具（wine-stable）
  COPY 自研代码（dist 产物 + stub QQNT.dll）   # 注意：stub 是自研，可内置
  COPY entrypoint.sh
  VOLUME /app/.napuketto                       # 数据卷：账号数据 + qq-files 缓存 + win-node
  VOLUME /app/.wine                           # WINEPREFIX（DPAPI 票据持久化，见 §6）
  ENV NAPUTO_DATA=/app/.napuketto
  ENV WINEPREFIX=/app/.wine
  ENTRYPOINT ["/app/entrypoint.sh"]
```

**平台支持（2026-08-12 拍板）**：第一版只承诺 `linux/amd64`；ARM（M1/M2 Mac、树莓派）需 QEMU 用户态模拟，性能损耗大且易段错误，列为后置 P2/P3。

**entrypoint.sh 职责**（首次启动自动准备，无腾讯二进制进镜像）：

```
1. 确保 Windows 版 node.exe（下载 nodejs.org 官方 zip → 解压到数据卷）
2. 确保 QQ 文件缓存（按版本清单下载官方安装包 → 7z 解包 → 提取 wrapper.node 等）
3. 确保 WINEPREFIX 初始化（wineboot；DPAPI 密钥生成并持久化在数据卷）
4. 执行 self-host（wine node.exe …）
```

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

- 首次启动较慢（下载 QQ 安装包 + win-node），后续启动秒级。
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
│   ├── launcher.ts           # 改：spawn 平台分支（win32 / wine）
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
| wine 下某个环节不兼容（理论低） | 🟡 低 | §3.3 冒烟验证点前置；不切换方案 b（用户拍板） |
| **DPAPI 票据丢失**（隐形炸弹） | 🟡 中 | wine 的 `CryptProtectData` 用随机本地密钥模拟——**wine 容器 / WINEPREFIX 被销毁则登录状态必然丢失**。对策：① Docker 挂载 `WINEPREFIX` 数据卷（§4.1）；② 文档明确告知用户需持久化哪些路径（`.wine` / `.napuketto`）；③ 快速登录票据存 kernel 数据根，同样随数据卷持久化 |
| **反风控环境特征（核心风险）** | 🔴 高 | wine 内注册表结构 / MAC / 硬盘序列号特征单一。对策：**P2 阶段立刻做快速登录/扫码登录冒烟测试**，尽早试探腾讯风控对 wine 的容忍度；失败则评估进程名伪装/环境模拟（loader 载具层） |
| v8 JIT + wine 兼容 | 🟢 低 | Electron 体系跑 wine 已有先例（VS Code/Discord）；只要 wrapper.node 不重度依赖未公开 Windows API 即可 |
| 首次下载慢 / 网络被墙 | 🟡 中 | sha256 校验保证完整性；`NAPUTO_QQ_FILES` 支持预置目录（用户手动拷贝绕过下载） |
| 镜像体积大（wine ~1GB） | 🟢 低 | `node:22-slim` + `wine64`（省 100MB+）；QQ 文件放数据卷不进镜像 |
| ARM 模拟性能（后置） | 🟢 低 | 第一版只承诺 amd64；ARM 列为 P2/P3 |

---

## 7. 实现顺序（设计先行，逐模块推进）

> 每个模块完成跑一次 `pnpm check`。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** ✅ | `locate-qq.ts` 多级来源 + `resolveQqFiles`（L0/L1/L2 纯定位，不下载） | Windows 本机路径回归不破 |
| **P1** ✅ | `qq-releases.json` + `qq-download.ts` + `qq-extract.ts`（下载→校验→解包→缓存） | Windows 上删掉本机 QQ 探测也能跑起来（用缓存） |
| **P2** ✅ | `win-node.ts` + `launcher.ts` 平台分支 | Linux 冒烟：wine node.exe → dlopen wrapper.node（登录 + session READY 待测） |
| **P3** ⏳ | Dockerfile + entrypoint + 文档（**未实现**） | `docker run` 全链路跑通（数据卷持久化验证） |

---

## 8. 已拍板细节（2026-08-12 技术栈讨论结论）

1. **wine 版本**：`wine-stable`（发行版默认）；Docker 仅 `wine64`。
2. **路径映射**：`toWinePath` 纯函数入 launcher（§3.2），所有传给 wine 子进程的路径过转换。
3. **版本探测**：已立项，实测官方下载配置 JSON（SPA 数据源）可读（§2.2）；CI Cron 自动更新清单已落地（`scripts/qq-releases/update-qq-releases.ts` + `.github/workflows/update-qq-releases.yml`）。
4. **下载实现**：Node 内置 `https` + `crypto`（sha256），无第三方依赖。
5. **解包工具**：内置 `7za.exe`（LGPL 合规可分发）+ Linux/Docker 系统 `p7zip-full`。
6. **ARM**：第一版只承诺 `linux/amd64`，ARM 列后置 P2/P3。
7. **DPAPI**：WINEPREFIX 必须随数据卷持久化（§4.1/§6），文档明确持久化路径。
8. **反风控**：P2 阶段第一优先 = 快速登录/扫码登录冒烟测试。

**遗留待实现时确认**：
1. `qq-releases.json` 放 loader 包内 vs 单独维护（先放包内，后续量大再拆）。
2. `resolveQqInstall` 的 API 兼容：保留旧签名导出，新入口 `resolveQqFiles` 并行存在，待 cli/koishi 适配器切换后再移除旧入口。

---

## 9. IPC 模式与 OB11 容器可选装配（2026-08-27）

`src/host/ipc/`：koishi 插件子进程模式（`NAPUTO_IPC=1`，stdout JSON 行 + stdin
action/control）。登录前启动 stdin 服务端（login.refreshQr 可达），登录后
`attachIpcServices` 把 kernel 服务动作（`msg.sendMessage` 等点分域）并入同一张
共享动作表，事件通道经 `sendEvent(service, name, args)` 透出。

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

### 10.3 koishi 侧配合（apps/koishi-plugin-adapter）

- 决策表（login-actions.ts）：登录期 + **logged_in（ready 态）** + client
  可用 → control login（plan 携带 soft 标记）；failed / client 不可用 →
  restart 不变。
- **换账号防线**：driver 的 ready 幂等守卫使软重登完成后 onReady 不重触发，
  checkIdentity 改由登录消息面补位——logged_in 携带 selfInfo 时（driver-events
  `onLoggedIn` → bot.handleLoggedIn）复核账号一致性，不一致拒绝上线（同
  2026-08-20 生产事故防线）；同账号通过并同步昵称刷新。
