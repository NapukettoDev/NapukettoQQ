# @napuketto/loader 实测样本

> 存放动态库加载、stub 校验、安装包解包、实例锁与 IPC 的探针命令和原始样本，仅供深水区
> 排查，不是 API 契约；不含任何 RVA/Offset 或绝对地址。机制见 [design.md](design.md)，
> Linux 选型见 [decisions.md](../../../docs/architecture/decisions.md)。

## 探针与复现命令

### 动态库加载

Windows：PATH 必须先 stub 目录、再 `wrapper.node` 同目录（后者放 `*.dll` 依赖）。

```powershell
$stub = "packages/loader/native/build/stub-test-env"
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
readelf --dyn-syms --wide packages/loader/native/build/linux-x64/libnapuketto_stub.so | grep -v UND
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
{"pid":32100,"startedAt":1760000000000,"cmdline":"node …/dist/host/self-host.cjs"}
```

| 锁状态 | 判定 | 行为 |
|---|---|---|
| 不存在 / 损坏 / `pid` 非法 | 可启动 | 写入新锁 |
| `process.kill(pid, 0)` 失败 | 残留 | 接管 |
| 存活且 cmdline 一致 | 占用 | 拒绝启动（返回占用 PID） |
| 存活但 cmdline 查不到或不一致 | PID 复用 | 接管 |
| 旧锁无 `cmdline` | 无法校验 | 保守判占用 |

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
stub QQNT.dll 就绪：…\native\build\stub-test-env
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
