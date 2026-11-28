# @napuketto/loader 实测样本

> 存放动态库加载、stub 校验、安装包解包、实例锁与 IPC 的探针命令和原始样本，仅供深水区
> 排查，不是 API 契约；不含任何 RVA/Offset 或绝对地址。机制见 [design.md](design.md)，
> Linux 选型见 [decisions.md](../../../docs/architecture/decisions.md)。

## 探针与复现命令

### 动态库加载

Windows：PATH 必须先 stub 目录、再 `wrapper.node` 同目录（后者放 `*.dll` 依赖）。

```powershell
$stub = "packages/loader/native/prebuilt/win32-x64"
$app  = "$env:LOCALAPPDATA\Programs\Tencent\QQNT\versions\9.9.33-52230\resources\app"
$env:PATH = "$stub;$app;$env:PATH"
$env:NAPUTO_STUB_DIR = $stub
$env:W = "$app\wrapper.node"
node -e "const m={exports:{}};process.dlopen(m,process.env.W);console.log(Object.keys(m.exports).length)"
```

输出即 exports 个数（Windows 9.9.33 基线 98）。

Linux：stub 与 gnutls 一起预加载，其余宿主符号由官方 node 全局符号表解析。

```bash
W=$PWD/qq/root/opt/QQ/resources/app/wrapper.node
LD_PRELOAD=$PWD/libnapuketto_stub.so:/usr/lib/x86_64-linux-gnu/libgnutls.so.30 \
  node -e 'const m={exports:{}};process.dlopen(m,process.env.W);console.log(Object.keys(m.exports).length)'
ldconfig -p | grep libgnutls.so.30; readelf -d wrapper.node | grep NEEDED
readelf --dyn-syms --wide packages/loader/native/prebuilt/linux-x64/libnapuketto_stub.so | grep -v UND
```

不同发行版的 gnutls 落点（`ldd` 看不出该隐藏依赖；`$LIBDIR` = `/usr/lib/<arch>-linux-gnu`）：

| 发行版 | gnutls 包名 | 落点 |
|---|---|---|
| Ubuntu 24.04 | `libgnutls30t64` | `$LIBDIR/libgnutls.so.30` |
| Debian 12 | `libgnutls30` | 同上 |
| Ubuntu/Debian arm64 | `libgnutls30(t64)` | `$LIBDIR/libgnutls.so.30` |
| Alpine（musl） | — | 不支持（glibc 基线） |

```text
libbugly.so: undefined symbol: gnutls_free      # 只 preload stub，漏了 gnutls
loadSymbolFromShell: dlsym failed PerfTrace     # stub 未导出 PerfTrace（不阻塞）
Module did not self-register                    # process.dlopen 加载普通 .so
invalid ELF header                              # 指向 /mnt/c 的 Windows PE wrapper
```

`wrapper.node` 直接 `DT_NEEDED`：`libvips-cpp.so.42` / `libX11.so.6` / `libX11-xcb.so.1` /
`libuuid.so.1` / `libbugly.so` / `libz` / `libXext` / `libc`；`libbugly` 另有约 70 个 gnutls
未定义符号但无 `DT_NEEDED`。

stub 校验：Linux 导出 3 个符号（`qq_magic_napi_register`、
`_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE`、`PerfTrace`），无 `DT_NEEDED`；
Windows stub 是 PE 转发器，无同名符号表可查，只校验 `QQNT.dll` 存在。

### 安装包解包与 7-Zip

```powershell
7z x QQ_9.9.33_260813_x64_01.exe -oout -y
Get-ChildItem out/Files/versions/9.9.33-52230/resources/app -Filter *.node
```

```bash
7zz x QQ_3.2.35_261103_amd64_01.deb -od0 -y
7zz x d0/data.tar.xz -od1 -y
7zz x d1/data.tar -od2 -y
readelf -h assets/7zip/7zz | grep Machine    # Advanced Micro Devices X86-64
```

- Windows exe 是 NSIS 自解压：完整版 `7z` 可解（`Files/` 即安装根），standalone `7za`
  不支持 NSIS，报错退出；只提 `resources/app` 顶层 `*.node` / `*.dll`。
- Linux deb 三层解包无需 `dpkg-deb`；`data.tar`（约 642MB）等中间产物解完即删。基线耗时：
  解包约 5.5s、提取约 65ms。
- 内置 `7zz` 是 x86-64 ELF，arm64 上 exec 直接 `cannot execute`；Linux 非 x64 只用系统
  `7zz` / `7z`，`NAPUTO_7Z_PATH` 可显式指定。

### 实例锁校验

```bash
node --input-type=module -e '
import { checkInstanceLock, acquireInstanceLock } from "@napuketto/loader";
const dir = process.argv[1];
console.log(JSON.stringify(checkInstanceLock(dir)));
console.log(acquireInstanceLock(dir));
' "<账号数据目录>"
```

```text
{"occupied":false,"pid":null,"lockPath":"…/instance.lock"}   ← 无锁/残留已清
true
{"occupied":true,"pid":32100,"lockPath":"…/instance.lock"}   ← 被占用
false
```

cmdline 交叉核验：Windows `(Get-CimInstance Win32_Process -Filter 'ProcessId=32100').CommandLine`，
Linux `tr '\0' ' ' < /proc/32100/cmdline`。

### 平台探测与非 Node 宿主

```powershell
(Get-Process -Id $PID).Path     # node.exe 或 bun.exe
where.exe node
node --version
$env:NAPUTO_WIN_NODE_PATH = "C:\Program Files\nodejs\node.exe"; $env:NAPUTO_WIN_NODE_VERSION = "v24.16.0"
```

- Bun 等非 Node 宿主 `execPath` 是 `bun.exe`，stub 的转发目标是真 `node.exe`。
- 解析顺序：`NAPUTO_WIN_NODE_PATH` > 系统 `where node`（离线）> `<数据根>/runtime/win-node/<版本>/node.exe`。

## 字段样本与边界表现

### dlopen 结果

- Windows 9.9.33：exports 98，含 `NodeIKernelLoginService`。
- Linux 3.2.35 / 9.9.37：exports 104，含 `NodeIKernelLoginService`、`NodeIQQNTWrapperEngine`、
  `NodeIO3MiscService`。
- `engine.initWithDeskTopConfig` 返回 true（KLINUX + `V1_LNX_NQ_3.2.35_54395_GW_B`）；
  `getLoginList` → `{"result":0,"LocalLoginInfoList":[]}`；`addO3MiscListener` 激活事件分发。

### 尺寸与 CDN 边界

- Windows x64 安装包 `Content-Length` 330,446,512；`resources/app` 顶层 `*.node` + `*.dll`
  提取量约 235 MB。
- Linux x64 deb 188,287,504；`wrapper.node` 152,431,496 / `major.node` 111,947,856。
- Linux arm64 deb 208,717,176；`wrapper.node` 147,183,032 / `major.node` 112,209,336。

```text
HTTP/1.1 403 Forbidden        # 清单原样 URL，路径段 /QQNTV2/ 大写
Content-Length: 0 ｜ Server: Lego Server ｜ X-Cache-Lookup: Return Directly
HTTP/1.1 200 OK               # 仅把该段改成小写 /qqntv2/；Range 请求 206，首字节 MZ
Content-Length: 330446512
```

### 缓存布局

```text
<数据根>/qq-files/<版本>/versions/<版本>/resources/app/
├── wrapper.node / major.node
├── *.dll（Windows）｜ *.so / *.so.N（Linux）
├── pub.key / cacert.pem / package.json / application.json（仅 Linux）
└── sharp-lib/（仅 Linux，wrapper RUNPATH 含 $ORIGIN/sharp-lib）
<数据根>/runtime/win-node/<版本>/node.exe     # Windows 非 Node 宿主的 node
<数据根>/home/.config/QQ/crash_files/         # Linux 受管 HOME 下的 Bugly 落点
```

### 实例锁文件与判定

```json
{"pid":32100,"startedAt":1760000000000,"cmdline":"node …/dist/host/self-host.cjs","owner":"12345678-1234-1234-1234-123456789abc"}
```

| 锁状态 | 判定 | 行为 |
|---|---|---|
| 不存在 / 空文件 / 损坏 / `pid` 非法 | 可启动 | 预检只读，成功获取时写入新锁 |
| `process.kill(pid, 0)` 返回 `ESRCH` | 残留 | 接管 |
| `process.kill(pid, 0)` 返回 `EPERM` | 仍可能存活 | 保留占用 |
| 存活且 cmdline 一致 | 占用 | 拒绝启动（返回占用 PID） |
| 存活但 cmdline 已确认不一致 | PID 复用 | 接管 |
| 存活但 cmdline 查不到 | 无法校验 | 保留占用 |
| 旧锁无 `cmdline` | 无法校验 | 保守判占用 |

#### 实例锁回归测试

- Windows x64、NTFS、Node 24.16.0。定向测试 7 例通过。受控 Node 子进程通过 IPC 应答
  同步获取和释放，通过退出事件确认持有者停机。测试检查锁文件原文、所有者 PID、令牌和后续获取结果。
- 旧退出回调通过 `registerLockCleanup` 捕获第一代令牌。同一进程释放后重新获取，再退出，
  第二代文件原样保留，另一个进程可接管。临时去掉释放时的令牌比较后，目标用例在读取
  第二代文件时收到 `ENOENT`。逐字节恢复实现后，7 例定向测试再次通过。
- 残留变更目录由测试写入，标记引用实际启动并退出的子进程。活进程标记和未知条目均阻止获取，
  剩下已退出进程的标记及其临时记录时可以接管。测试未在真实变更窗口内中断进程，未复现系统 PID 复用。

### IPC 消息样本与编码边界

```json
{"v":1,"type":"status","payload":{"phase":"ready"}}
{"v":1,"type":"login","payload":{"state":"logged_in","selfInfo":{"uin":"……","uid":"u_……","nick":"……"}}}
{"v":1,"type":"qr","payload":{"pngBase64":"iVBORw0KGgo…","qrcodeUrl":"https://…"}}
{"v":1,"type":"ping"}
{"v":1,"type":"action","id":7,"payload":{"action":"msg.sendMessage","params":{"chatType":2,"peerUid":"…"}}}
{"v":1,"type":"result","id":8,"payload":{"ok":false,"error":{"code":"INVALID_PARAM","message":"缺 peerUid"}}}
{"v":1,"type":"control","payload":{"command":"login","qr":true}}
{"v":1,"type":"event","payload":{"service":"Msg","name":"onRecvMsg","args":[]}}
```

- 非法行 `{"v":1,"type":"nope"}`、`{"v":999,"type":"ping"}`、`[1,2,3]` 解码为 `null`：丢弃但
  留日志 `[ipc] 忽略无法解析的 stdin 行: …`；`control status` 重播最近一条 status；心跳 15s。
- `Map{0 → "/tmp/thumb.jpg"}` 直出 `{}`，`toJsonSafe` 后 `{"0":"/tmp/thumb.jpg"}`；`Set` 直出
  `{}`，规整后数组；环引用字段直出整条抛错，规整后丢该分支；`Date` / `Buffer` 原样。

### 原生噪音与启动日志

```text
<MMKV> … ｜ loadSymbolFromShell: dlsym failed PerfTrace ｜ [1105/213001.123:ERROR:quic_session.cc(88)] …
stub QQNT.dll 就绪：…\native\prebuilt\win32-x64
当前宿主非 node（bun.exe），解析 Windows 版 node.exe…
下载 QQ 官方安装包 3.2.35-54395（约 180MB）…
QQ 原生文件就绪：缓存版本 3.2.35-54395
```

### 错误文案与退出码

| 场景 | 表现 |
|---|---|
| stub 缺失 | spawn 前报「未找到」 |
| gnutls / node 缺失 | `libgnutls.so.30` / `node` 未找到 |
| PE wrapper 误用于 Linux | 报「不是 ELF」 |
| 数据目录被占用 | exit 1 + IPC failed |
| 配置校验失败 | exit 78（EX_CONFIG） |
| 请求式关停 | exit 0 |


## self-host 断管、统一关停与身份恢复（任务 03）

基线 `5f6e166` 的工作区版本为 loader 0.10.9、kernel 0.16.4、adapter 0.19.0、network 0.5.0。
Koishi 下游 #46/#47 的锁定版本为 loader 0.10.9、kernel 0.16.4、adapter 0.18.22、network 0.4.5。

| 审计编号 | 本次证据及既有上游修复 |
| --- | --- |
| H-04 | loader `bootstrap-core.ts` 在释放 kernel 缓存与监听器前调用 OB11 `unsubscribeOnly` 或协议 `stop`。#162 / `d7ede96` 的媒体缓存定时器与租约已在 adapter 0.18.18 发布。 |
| M-01 上游 | `assemble-protocols.ts` 启动的协议在统一关停时都会尝试停止。匹配 pong、缓冲上限和重连仍由 #163 / `2169832` 的 network 0.4.5、adapter 0.18.19 提供。 |
| M-02、M-05 上游 | `ipc/server.ts`、`ipc/sender.ts`、`self-host.ts`、`shutdown.ts` 验证 stdin EOF、stdout 写失败、stop/restart、发生在登录或在途动作时的断开、stdout 协议帧，以及按字节限行和在途动作拒绝。 |
| M-03 上游 | 配置错误继续通过同一编排退出 78。`ConfigBase` 并发保存沿用 #161 / `893bbdd`（kernel 0.16.2），仅保证同一实例内顺序与原子替换。 |
| L-02 上游 | `instance-lock.ts` 用同目录变更互斥和所有权令牌验证三进程争锁、空锁、强杀残留、旧记录、读不到命令行及同 PID 所有权变化。 |
| I-01 B | `ipc/types.ts`、`ipc/sender.ts`、`bootstrap-core.ts`、`relogin.ts` 验证 ready 重播、自身身份补查、软重登，新一代装配前返回 `INVALID_STATE`。事件晚于 ready 的既有修复在 #168 / `9fbaee1`（loader 0.10.7）。 |
| F-06 关停接线 | `shutdown.ts`、`protocols.ts`、`ipc/ob11-bridge.ts` 覆盖协议进程控制、限时阶段、桥和监听器释放。HTTP/SSE/WS 停服由 #158 / `2ff0da0`（network 0.4.4、adapter 0.18.14）提供。应用/守护退出和树杀保留 #149 / `147e1f9` 的 loader 0.10.5 契约。 |

### 验证与剩余条件

- Windows Node 24.16.0：`pnpm --filter @napuketto/loader build` 通过。
  `pnpm test:quiet packages/loader` 525 通过、5 跳过。
  `pnpm check && pnpm test:quiet` 通过，3591 通过、14 跳过。
  `pnpm exec fallow audit --base origin/main` 通过，无新增门禁发现。
- Linux x86_64 WSL Node 24.16.0：将 loader CJS 产物、锁定的 zod 和测试夹具复制到
  Linux 本地文件系统执行 `node --test --test-reporter=tap self-host-process.integration.mjs`。
  8 个子进程用例通过，覆盖双向断管、控制退出、应用退出、初期身份未知、软重登及并发锁回收。
- 原生待验：需要 Windows/Linux 的真实 stub、受支持 QQ NT 及隔离测试账号，复核
  动态加载后的 O3 时序、native 锁释放、立即重启和真实 stdout fd 1 的写入。
  QQ 原生代码可绕过 Node 流直接写入 fd 1。IPC 消费方仍须兼容原生噪音并支持状态恢复；
  本次标准 Node 测试验证宿主 JS 的 stdout 只有协议帧，未覆盖原生直写或阻塞。

### 下游 02、04、20

- **02**：已有 IPC v1 帧结构沿用，上游在途与行上限与 #46 的 256 和 16 MiB 对齐。
  本次版本在超限时回同 ID 的 `IPC_BUSY`。帧上限计算包含 CR、排除 LF。EOF 的未完成尾帧
  丢弃。stop/restart 无 ACK，以子进程退出作为完成信号，重启仍由父进程决定。
- **04**：0.10.9 支持 ready 后发 `login.getSelf` 获取 `{uin, uid, nickname}`，并支持
  `control status` 重播 status。当前 #47 可继续使用补查路径。新版本用一个
  `status(ready).selfInfo` 原子携带 `{uin, uid, nick}`。旧解析器会忽略此新增字段，
  依赖升级后使用 loader 导出的 schema，再按当前子进程及装配状态校验异步补查结果。
- **20**：新行为随本次 loader minor changeset 发布，按当前基线预计为 0.11.0。
  `^0.10.9` 不覆盖 0.11.0，发布后同步依赖范围与锁文件。原生引导原语自 kernel
  0.12.3 提供，下游当前锁定 0.16.4 已满足。升级同一账号目录前先停止旧宿主；
  原生模块同步卡死时保留父进程强杀兜底。

## 宿主诊断、环境与 PID 校验（H-01 / H-06 / L-03）

- `buildLaunchEnv` 白名单单测在 `src/boot/__tests__/launch-env.test.ts`：win32 与 linux
  模拟输入分别验证凭据/`NODE_OPTIONS`/`LD_PRELOAD` 不透传，代理/证书/日志/控制标记透传，
  `NAPUKETTO_*` 优先并清除旧拼写，`qrOnly:false` 清一次性扫码标记，typed `log`/flags 覆盖
  `extraEnv`，Windows `Path`/`PATH` 去重。
- 诊断动作注册启停见 `src/host/ipc/__tests__/actions-branches.test.ts`，
  诊断动作内部行为（allowlist / 参数边界 / 反射面）见 `diagnostics.test.ts`：默认动作表无
  `diag.*`；`diagnostics:true` 才注册；反射调用只在
  allowlist 内成功，`richMediaTmpPaths` 只读且不触发 setter。
- PID：`isValidPid` 覆盖 0 / 负数 / 小数 / NaN / 超上限；`readCmdlineForPid` 对非法值直接
  返回 null 且不发起 PowerShell / `/proc` 查询；cli `runtime.json` 的 `selfHostPid` 非法时
  整条记录判非法（`apps/cli/src/runtime/__tests__/state.test.ts`）。合法 PID 的 signal 0
  存活探测保留。
- 剩余条件：未在真实 koishi 驱动上验证诊断关闭时前端收到 `NOT_FOUND` 的提示路径；未实测
  Windows 组策略/代理客户端注入的额外变量。Bugly 外传仍为未证实报告主张，未做抓包复核。
- **`getRichMeidaTmpPath` 拼写复核（2026-11-25）**：QQNT `9.9.37-54395` 的
  `resources/app/wrapper.node` 中 `getRichMeidaTmpPath` 出现 5 次（含
  `GetAllRichMeidaTmpPath` 日志串），`getRichMediaTmpPath` 出现 0 次——该拼写是原生侧
  既有命名而非 loader 笔误，故 `diag.richMediaTmpPaths` 保持原名。复核命令：
  `findstr /M /C:"getRichMeidaTmpPath" wrapper.node`（正拼写命令无输出）。登录态探针
  （`NAPUKETTO_PROBE=1`）仍需真实账号环境，本次未执行。


## F-05 与 I-01 原生边界

- PR #130（`fdd3834`）引入 kernel 的 `dlopenWrapper`。任务 03 PR #177
  （`ed7c959`）已有 loader 委托加载、关停和 IPC 状态恢复。任务 08 PR #180
  （`cde973b`）已约束诊断启用与环境继承。当前自建宿主入口由
  `packages/kernel/src/runtime/self-host.ts` 提供，原生反射诊断由 kernel 的
  `native/probe/host-diagnostics.ts` 执行。loader 保留诊断开关、IPC 动作名和帧格式。
- Windows x64 与 Linux x64（WSL）的 Node 24.16.0 使用临时数据根、合成账号及
  `tests/host/bootstrap/fixtures/wrapper.c` 编译出的独立 PE／ELF addon。
  通过 `HOST_TEST_ADDON=<测试 addon> node --test --test-reporter=dot packages/loader/tests/host/bootstrap/self-host-process.integration.mjs`
  运行，两平台各通过 6 项。正常顺序为加载 → O3 注册 → 创建启动会话 → engine 初始化 →
  登录 → session.init → startup.start → 消息监听 → 上报在线状态 → 其余业务监听 → IPC ready →
  stop → 监听释放与退出。
  另验证了关闭／启用 IPC 诊断、旧 kernel 缺少入口、缺失 O3 后退出、部分监听注册失败的
  回滚，以及显式探测后的群服务方法名落盘。
- 合成 addon 实际经过 Node 原生加载，登录和监听副作用由夹具提供。官方 wrapper 与私有
  stub 的配套加载、真实快速登录／扫码、O3 底层释放、立即重启和 native fd 1 输出仍需
  匹配的两平台组件及授权测试账号。真实群操作的证据条件见 kernel 文档。

## F-08、F-09、F-12 与 I-01 C／D 上游验收

基线为主仓 `59e29f2`、原生 gitlink `68827c0061df50f223b6b9429ce5618ae42bc1ba`。
沿用 #164（`f7fb4fb`）的 7-Zip 校验和已锁定的 Actions，以及 #213（`7834465`）的
kernel 原生宿主入口。已发布基线为 loader 0.19.0 和 CLI 0.10.2。

| 编号 | 当前行为与检查 | 实测结果 |
| --- | --- | --- |
| F-08 | [pack-loader.ts](../../../tooling/release/pack-loader.ts) 与 [release.yml](../../../.github/workflows/release.yml) 打包、核对 gitlink 和 tarball 内 stub 字节，发布任务收到归档后按 prepare 的 job output 核对 SHA-256。若 rebase 后重构建，重新打包并复核。 | 真实 loader 归档包含双平台 stub、宿主入口和发行清单。定向测试验证临时 Git 仓中的改变字节、漏件、私有源码排除和失败时旧归档保留。真实归档对回环 registry 执行 `npm publish --dry-run --ignore-scripts --no-provenance`，退出 0，回环只收到 GET。 |
| F-09 | [Dockerfile](../../../docker/Dockerfile)、[install-cli.sh](../../../docker/install-cli.sh) 与 [image.yml](../../../.github/workflows/image.yml) 按指定 CLI 版本和 SRI 下载并安装，Docker 前端、Node 24.16.0、Debian 与 FFmpeg 都按固定 OCI 摘要解析。 | 本地 `docker buildx build --platform linux/amd64 --load` 构建 CLI 0.10.2 的 full／slim，运行得到 Node 24.16.0、CLI 0.10.2，full 内 FFmpeg 9.0.2。省略参数或传入错误 SRI 的 builder 构建退出非零。 |
| F-12 | [open-config.ts](../../../apps/create/src/open-config.ts) 用固定 Windows 启动器脚本和环境变量传路径，macOS／Linux 分别把路径作为一个参数传给系统打开程序。 | `pnpm test:quiet apps/create/tests/open-config.test.ts` 覆盖空格、Unicode、字面量 `%PATH%` 和合法特殊字符，真实子进程读取到了临时配置。系统 Windows 启动器缺文件、子进程非零和 POSIX 打开程序启动失败均有覆盖。 |
| I-01 C／D 上游 | 所有公开包和根清单最低 Node.js 24.11.0。CI 在 Linux 以最低版本构建并加载合成 ELF addon，Windows 24.x 构建并运行合成宿主。库入口测试通过真实 Node 子进程检查 ESM import 和 CommonJS require。 | 锁定的 tsdown 0.23.7 要求 Node 22 系列至少 22.18.0 或 Node 24 系列至少 24.11.0。Windows Node 22.12.0 的源码构建在加载 tsdown 配置时失败。Node 24.11.0 与 24.16.0 的定向构建通过。 |

### 构建、导入和自建宿主

- 构建命令为 `pnpm --filter '@napuketto/cli...' --filter create-napuketto build`。
  Node 24.11.0 构建的产物在 22.12.0 通过了 kernel／adapter 的 ESM import 与 CommonJS
  require，以及 CLI `--version`、脚手架 `--help`。该结果覆盖所列入口，仓库支持范围以
  [Node 契约](../../../docs/architecture/runtime.md#nodejs-版本契约)为准。
- Windows x64 和 Linux x64（WSL）分别编译 `tests/host/bootstrap/fixtures/wrapper.c`，
  用 `HOST_TEST_ADDON=<合成 addon> node --test --test-reporter=dot packages/loader/tests/host/bootstrap/self-host-process.integration.mjs`
  验证。Node 22.12.0、24.11.0、24.16.0 在两个平台均各通过 6 项。夹具经 Node 原生加载，
  登录与会话行为使用合成账号及测试实现。
- 发布证据使用 `node tooling/release/pack-loader.ts <临时目录>`，定向门禁用
  `pnpm test:quiet tooling/release/__tests__/pack-loader.test.ts apps/create/tests/open-config.test.ts tooling/package-exports.test.ts`，
  82 项通过。最终 `pnpm check && pnpm exec fallow architecture --boundaries && pnpm test:quiet`
  通过，1085 项通过、3 项跳过。锁文件以 `pnpm install --frozen-lockfile --ignore-scripts` 复核。

### 来源、签名与独立重建

- 公共 registry 中 loader 0.19.0 用 `npm audit signatures` 验证 registry 签名和 npm
  attestations。签名声明把 tarball 的 SHA-512 绑定到
  `NapukettoDev/Napuketto/.github/workflows/release.yml` 的 main 触发提交 `7834465`。
  私有原生提交由 GitHub 报告签名有效。原生构件的独立签名和编译声明仍缺证据。Windows
  `Get-AuthenticodeSignature` 返回 `NotSigned`，Linux 未找到独立分离签名。
- 从锁定提交做 `git archive`，解到临时目录再分别构建，原始构件和 QQ 安装目录均未改写。

| 目标 | 本地重建命令与工具链 | 归档 stub SHA-256 | 重建 SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `cmake -G Ninja -S <源码> -B <输出> -DCMAKE_CXX_COMPILER=<x64 llvm-mingw> -DCMAKE_BUILD_TYPE=Release`、`cmake --build <输出>`，CMake 4.3.2、Clang 22.1.8 | `2a5d1483809ce63de89191a08196c1177a2c7047776bb424f91386b7d0f44052` | `a574bf61e89fff9c345a197edbf7fe8378f65a71eaf914c1fdc04c67ffb273c9` |
| Linux x64 | `bash tools/build-linux.sh`，GCC 13.3.0（Ubuntu 24.04）、GNU ld 2.42 | `675eb9449aefb796d6a73f616b5913520340cb66bda10498446fd8cf686b70ca` | `5c8f4f5e7993ff0f3a25caa5c81b6d23d6da8e1cd19efc59214e87c3c6d04b08` |

两个平台能独立编译，字节复现均未通过。原始编译方仍需补齐精确工具链、构建参数与环境，
以及由包外受信身份签署的原生构件证明。真实 QQ wrapper 与 stub 的联合加载、登录及发布后
registry／GHCR 复验分别等待授权双平台 QQ 测试环境、账号和正常发布流程。

### 交接任务 19／20

按当前基线计算，Changesets 的候选版本为 kernel 0.20.0、loader 0.20.0、adapter 0.27.0、
network 0.7.0、media 0.6.0、CLI 0.11.0、create-napuketto 0.5.0。消费这些版本的环境
最低 Node.js 24.11.0。发布后以实际的 npm 版本及各包 `engines.node` 为准，再更新下游
依赖和部署说明。保留现有 CommonJS 库入口与宿主 IPC 契约。
