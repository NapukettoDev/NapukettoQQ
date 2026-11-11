# Linux 原生宿主实测与探针

> 本文件存放 Linux 原生 ELF 宿主的探针命令、裸输出与字段样本，仅供深水区排查，
> **不是 API 契约**；机制与操作看 [linux-native-host.md](linux-native-host.md)。
> 只保留符号名、模块名与命令输出，严禁写入任何逆向地址（相对偏移 / 绝对地址）。

## 探针与复现命令

### 取包与解包

基线：官方 Linux QQ `3.2.35`（QQNT `9.9.37`）amd64 / arm64 deb。

```bash
# 下载配置（x64 / arm64 / loongarch / mips64el 各有字段）
curl -s https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js
curl -sL https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/linuxConfig.js

# x64 deb：/qqntv2/ 必须小写，大写 /QQNTV2/ 会被边缘 WAF 403
curl -L -o linuxqq.deb \
  https://qqdl.gtimg.cn/qqfile/qqntv2/9.9.37/release/816b3c79/QQ_3.2.35_261103_amd64_01.deb

# 三层解包：deb(ar) → data.tar.xz → data.tar → opt/QQ/resources/app
7z x linuxqq.deb -oqq
7z x qq/data.tar.xz -oqq/root
7z x qq/root/data.tar -oqq/root/app
```

实测尺寸：

```text
deb             188,287,504   QQ_3.2.35_261103_amd64_01.deb
deb             208,717,176   QQ_3.2.35_261103_arm64_01.deb
data.tar        ~642MB        中间产物，解完即删
wrapper.node    152,431,496   x64
major.node      111,947,856   x64
wrapper.node    147,183,032   arm64
major.node      112,209,336   arm64

7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac  amd64 deb sha256
5f93ea62347dd772c7be4115413c95d2a60d189f3dd81bc194834bd4d7343cf2  arm64 deb sha256
```

### 符号与依赖静态探测

```bash
# 全部 undefined 全局符号（按名去重）
readelf --dyn-syms --wide wrapper.node \
  | awk '$7=="UND" && $5=="GLOBAL"{print $8}' | sort -u

# UND 记录总数（含弱符号与局部）
readelf --dyn-syms --wide wrapper.node | awk '$7=="UND"' | wc -l

# 直接 DT_NEEDED 与 GLIBC 版本需求
readelf -d --wide wrapper.node | grep NEEDED
readelf --version-info --wide wrapper.node | grep 'Name: GLIBC_'

# 静态导出（GLOBAL DEFINED）
readelf --dyn-syms --wide wrapper.node | awk '$7!="UND" && $5=="GLOBAL"' | wc -l

# Node 侧对照（官方或发行版构建才导出符号）
readelf --dyn-syms --wide node | grep -c 'napi_'
readelf --dyn-syms --wide node | grep -c 'uv_'
```

`ldd` 只能看已声明的依赖，看不到 `libbugly` 的 gnutls；必须真 `dlopen` 才算验过：

```bash
ldd qq/root/opt/QQ/resources/app/wrapper.node | grep 'not found'   # 无输出 ≠ 可加载
```

### 无 DISPLAY 加载探针

```bash
# Ubuntu 24.04 依赖（Debian 12 的 gnutls 包名是 libgnutls30）
apt-get install -y libx11-6 libx11-xcb1 libxext6 libuuid1 libstdc++6 zlib1g \
  libgssapi-krb5-2 libgcrypt20 libgnutls30t64

# gnutls 必须一起 preload：libbugly 的 gnutls_free 是 GLOB_DAT，加载期就要解析
W=$PWD/qq/root/opt/QQ/resources/app/wrapper.node
LD_PRELOAD=$PWD/libnapuketto_stub.so:/usr/lib/x86_64-linux-gnu/libgnutls.so.30 \
  node -e 'const m={exports:{}};process.dlopen(m,process.env.W);
            console.log(Object.keys(m.exports).length);'
```

预期 `104`，且至少含 `NodeIQQNTWrapperEngine` / `NodeIKernelLoginService` /
`NodeIO3MiscService`。

常见反例：

```text
# 只 preload stub
libbugly.so: undefined symbol: gnutls_free
# stub 不导出 PerfTrace：只告警，不阻塞
loadSymbolFromShell: dlsym failed PerfTrace
```

### 最小 stub 与产物核验

```cpp
// stub-linux.cc：不需要 node 头文件
struct napi_module;
extern "C" void napi_module_register(struct napi_module*);

extern "C" void qq_magic_napi_register(struct napi_module* mod) {
    napi_module_register(mod);
}

namespace v8 { class Isolate; }
namespace node {
bool IsEnvironmentStopping(v8::Isolate*) { return false; }
}

extern "C" void PerfTrace(void) {}
```

```bash
g++ -shared -fPIC -O2 stub-linux.cc -o libnapuketto_stub.so

# 产物面：3 个导出、无 DT_NEEDED、唯一 UND 是 node 提供的 napi_module_register
readelf --dyn-syms --wide libnapuketto_stub.so | grep -v UND
readelf -d --wide libnapuketto_stub.so | grep NEEDED   # 无输出

# arm64 交叉编译（产物不进公共仓库）
ARCH=arm64 CXX=aarch64-linux-gnu-g++ bash stub/build-linux.sh
readelf --dyn-syms --wide build/linux-arm64/libnapuketto_stub.so | grep -v UND

# nm 等价写法：只打印符号名（不打印地址列）
nm -D --defined-only -f just-symbols libnapuketto_stub.so
```

stub 导出面（未剥离符号表样本）：

```text
PerfTrace
qq_magic_napi_register
_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE
```

坚持 `process.dlopen` 加载 stub 时必须补 dummy 自注册，否则 `Module did not self-register`：

```cpp
#include <node_api.h>
NAPI_MODULE_INIT() { return exports; }
```

### 引擎初始化与登录握手探针

x64 基线（无 DISPLAY，`LD_PRELOAD=stub:libgnutls.so.30`）的装配参数：

```text
engine: platform_type=5, app_type=4, app_version=3.2.35-54395,
        qua=V1_LNX_NQ_3.2.35_54395_GW_B, desktopGlobalPath=<data>/nt_qq/global
login:  appid=537403759, platVer=Linux <release>, clientVer=3.2.35-54395,
        commonPath=<data>/nt_qq/global, externalVersion=false
```

arm64 全链路探针（qemu 容器，不涉及账号）：

```bash
# 容器：linux/arm64（qemu 用户态模拟，uname -m = aarch64）
LD_PRELOAD="/stub/libnapuketto_stub.so:$GNUTLS:$UUID" \
  DATA=/data WRAPPER=/qq/wrapper.node node /login.cjs
# login.cjs 顺序：process.dlopen(wrapper) → Engine.initWithDeskTopConfig({...KLINUX...})
#   → login.initConfig({commonPath: <data>/nt_qq/global, appid: 537403759})
#   → login.connect() → 15s 后 getLoginList()
```

### X11 消费方盘点

```bash
# 仓内是否有截图 / 剪贴板消费方
grep -rnE 'ScreenCapture|screenCapture|clipboard|Clipboard|getScreen|screenshot|Screenshot' \
  packages --include='*.ts'     # 期望：0 命中

# 有 DISPLAY 时是否真的连 X server（WSLg 起后 /tmp/.X11-unix/X0 存在）
DISPLAY=:0 strace -f -e trace=connect -o /tmp/x11.log node apps/cli/dist/index.mjs
grep X11-unix /tmp/x11.log      # 无输出 = 全程没连
```

### Wine 退役验收

默认链路（不设任何 Wine / 开关变量）必须可用：

```bash
NAPUTO_LINUX_STUB=/tmp/libnapuketto_stub.so \
NAPUTO_QQ_FILES=/tmp/e2e-cache/qq-files/3.2.35-54395 \
NAPKETTO_DATA=/tmp/ntqq2 NAPKETTO_CONFIG=<ob11 配置> \
  node apps/cli/dist/index.mjs

# 预期：HTTP 就绪 15–16s；get_status online=true；send_group_msg 历史回读一致；
#       upload_group_file retcode=0 且返回 fileSetId；子进程是 <系统 node> self-host.cjs
# 子进程形态与环境（无 wine 包装层，无 NAPUTO_LINUX_NATIVE / NAPUTO_WINE）
tr '\0' '\n' < /proc/<pid>/environ | grep -E 'LD_PRELOAD|HOME|LINUX_NATIVE|WINE'
grep -E 'libnapuketto_stub|wrapper.node|wine' /proc/<pid>/maps
```

## 字段样本与边界表现

### 符号面样本（x64 3.2.35）

`wrapper.node` 共 641 条 UND 记录、640 个唯一名：

| 类别 | 计数 |
|---|---|
| `napi_*` | 41 |
| `uv_*` | 53 |
| v8 mangled | 1 |
| node mangled | 1 |
| 其余系统库 | 余量 |

node 侧真正缺的只有两条（`GLOBAL UND`，`JUMP_SLOT`）：

```text
qq_magic_napi_register
_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE
```

Node v24.16.0 官方 linux-x64 的导出量级：

```text
napi_* 145   uv_* 318   v8 1558   node::* 5774
```

41 + 53 + 1（v8）全部命中；自己编译且 `-fvisibility=hidden` 的 node 不保证。

不要被这些符号误导：

```text
WEAK UND   OPENSSL_memory_alloc / OPENSSL_memory_free / OPENSSL_memory_get_size
WEAK UND   sdallocx / __gcov_dump / __gcov_flush
GLOBAL UND _ZN2nt9wifiphoto…（36 个随包 .so / .node 里都没有定义）
```

`WEAK UND` 的 `GLOB_DAT` 解析为 0，不阻塞加载；`wifiphoto` 在 `RTLD_LAZY` 下同样不阻塞，
被调用才会 symbol lookup error（文件桥功能，宿主不触碰）。

### 各发行版依赖实测

`wrapper.node` 直接 `DT_NEEDED`：

```text
libpthread.so.0  libvips-cpp.so.42  libX11.so.6  libX11-xcb.so.1
libuuid.so.1     libbugly.so        libz.so.1    libXext.so.6
librt.so.1       libm.so.6          libgcc_s.so.1  libc.so.6
ld-linux-x86-64.so.2
```

传递依赖：

- `libbugly.so` → `libcrbase.so`、`libunwind-x86_64.so.8`、`libgssapi-krb5.so.2`、`libssh2.so.1`
- `libssh2.so.1` → `libgcrypt.so.20`
- `libvips-cpp.so.42` → 只依赖 `libstdc++` 与 glibc 系（随包自包含，不拉 glib）

隐藏依赖：`libbugly.so` 引用 71 个 gnutls 符号但没有 `DT_NEEDED` 声明，其中
`gnutls_free` 是 `GLOB_DAT`（加载期必须解析）。

- Ubuntu 24.04：`libgnutls30t64`，路径 `/usr/lib/x86_64-linux-gnu/libgnutls.so.30`。
- Debian 12：`libgnutls30`，路径同上。
- arm64 任一发行版：`libgnutls30t64`，路径 `/usr/lib/aarch64-linux-gnu/libgnutls.so.30`。

容器最小集合（Debian / Ubuntu）：

```text
libx11-6 libx11-xcb1 libxext6 libxcb1 libuuid1
libgssapi-krb5-2 libgcrypt20 libgnutls30 libstdc++6 zlib1g
```

glibc：`wrapper.node` 最高需要 `GLIBC_2.17`，Node v24 最高 `GLIBC_2.28`，实际下限由
Node 决定（约 Debian 10 / Ubuntu 20.04 起）；musl（Alpine）不支持。

arm64 与 x64 静态对照（同版本 deb）：

| 项 | x64 | arm64 |
|---|---|---|
| wrapper 字节 | 152,431,496 | 147,183,032 |
| UND 记录 / 唯一名 | 641 / 640 | 656 / 655 |
| `napi_*` / `uv_*` / v8 / node | 41 / 53 / 1 / 1 | 41 / 53 / 1 / 1 |
| 静态导出 | 381 | 385 |
| `libbugly` gnutls UND | 71 | 71 |
| 系统 uuid 声明 | 有 `DT_NEEDED` | 无（需手工 preload） |
| 解包 / 提取耗时 | 5.5s / 65ms | 6.6s / 67ms |
| 提取文件 / 字节 | — | 20 / 288,021,818 |

arm64 多出的 15 条 UND 是 glibc 2.17 版本后缀与 aarch64 辅助符号（`__addtf3` /
`__multf3` / `__clear_cache` / `__getauxval` 等），来自系统 libc / libgcc，不是新缺口。

### 加载与登录链路样本

无 DISPLAY 的 x64 基线：

- `dlopen(wrapper.node)` → exports = 104，`NodeIQQNTWrapperEngine` /
  `NodeIKernelLoginService` / `NodeIO3MiscService` 均在；`addO3MiscListener` 成功。
- `engine.initWithDeskTopConfig` → KLINUX + qua，进程存活。
- `login.initConfig` + `getLoginList` → `{"result":0,"LocalLoginInfoList":[]}`。
- MMKV 落 `<data>/nt_qq/global/nt_data/mmkv`。

登录与 session：

- QR 登录：`onQRCodeSessionUserScaned` → `onQRCodeLoginSucceed`。
- 二维码过期：`onQRCodeSessionFailed [1,3]`，重新 `getQRCodePicture()` 可刷新，无需重启。
- 快速登录：`getLoginList` 返回 1 条 `isQuickLogin:true`；`quickLoginWithUin` 的 `result`
  为 `"0"`、`errMsg` 为空串。
- session 创建顺序：`StartupSessionWrapper.create()` + `getNTWrapperSession("nt_1")` 早于
  engine init。
- init 完成：`onOpentelemetryInit {is_init:true}` 与 `onSessionInitComplete 0` 都触发。
- READY：`getMsgService()` 非空，7 个核心 service 均非空。
- 资料自检：`getUserDetailInfoByUin()` → `result:0`，能读到 self 昵称 / uid。

边界：快速登录也会触发 `onQRCodeLoginSucceed`（`mainAccount` 为空），成功判定以
`quickLoginWithUin` 的 `errMsg` 为准；`startupSession.start()` 后 `onMSFStatusChange [1,0]`、
`onNTSessionCreate 0` 先到，READY 仍以 `getMsgService` 非空为准。

### 数据根与 HOME 收敛

- strace：Bugly 只 `access` / `mkdir $HOME/.config/QQ/crash_files`，不读 `XDG_CONFIG_HOME`。
- Bugly 日志：`InitBuglyManager path: <数据根>/home/.config/QQ/crash_files/`。
- 用户 `$HOME` 零写入（`find -newer` 标记为空）；受管目录由原生层自建，umask 后 `750`。
- `commonPath`：`<数据根>/nt_qq/global`。

### 无 DISPLAY、有 DISPLAY 与 X11

- 无 DISPLAY：dlopen / engine init / getLoginList 通过。
- `DISPLAY=:0`：装配与快速登录成功，`connect` 到 `/tmp/.X11-unix/*` 0 次。
- 仓内消费方：`packages/**/*.ts` 搜截图 / 剪贴板关键词 0 命中。
- SIGTERM：code=0。

### 富媒体与撤回

环境：真 x64 ELF wrapper + 真 CLI（OneBot 11 HTTP），发送后用 `get_*` 取回、再 `delete_msg`。

- 图片 64×64 PNG（210 字节）：发送 retcode 0；`get_image` 回 `file_size=210`、文件名是
  md5；撤回通过。
- 语音 WAV 24kHz / mono / 0.6s：发送 retcode 0；`get_record` 回 `voice.silk`、
  `file_size=2461`；撤回通过。
- 视频 1s 64×64 H.264 mp4：发送 retcode 0；`videoElement` 落 Ori 目录，缩略图按视频 md5
  落 Thumb；撤回通过。

落盘路径形态（`<数据根>` 下）：

```text
nt_data/Pic/<年-月>/Ori/<图片 md5>.png
nt_data/Ptt/<年-月>/Ori/<语音 md5>.silk
nt_data/Video/<年-月>/Ori/<视频 md5>.mp4
nt_data/Video/<年-月>/Thumb/<视频 md5>_0.png
```

消息 id：发送返回 / 历史 / `get_msg` / `delete_msg` 为同一个 id；Linux wrapper 落库的 `msgId`
与 `generateMsgUniqueId()` 不同，kernel 以 `confirmSend` 命中的 `RawMessage.msgId` 为准。
自身消息不发 `onRecvMsg`（与 Windows 一致）。

素材合法性边界：手写 base64 的「1×1 PNG」稳定 `sendStatus=0`，换成结构合法 PNG
（正确 IHDR / IDAT CRC + IEND）后立即成功；只给 `file` 的 OB11 `video` 段同样恒
`sendStatus=0`，补 `thumbPath` / 尺寸 / 时长后成功（adapter `prepareVideoElements`）。

### 他人消息入站

真 CLI + OB11 WS，第二账号在群内发文本，收到的信封（`time` 为当前 Unix 秒）：

```json
{"time":1794307394,"self_id":1569227406,"post_type":"message","message_id":42,
 "message":[{"type":"text","data":{"text":"测试"}}],"raw_message":"测试",
 "message_type":"group","group_id":1101729931,"user_id":3054108135}
```

自然群流量（2659 人）的文本 / 图片 / `reply` 段均正常广播，`user_id` 为真实 QQ 号。
双协议同时启用（OB11 WS + Satori WS）时同一条消息各收各的信封，crosstalk = 0。

入站字段差异（Linux 3.2.x）：

- 未命中元素变体：Windows 省略字段，Linux 显式 `null`（`"grayTipElement":null` …）。
- `msgTime`：Windows 毫秒，Linux 秒字符串（`1794307394`）。
- 显示名：Windows 在 `sendNickName`，Linux 在 `sendMemberName`（`sendNickName` 为空串）。
- 图片路径：Windows 用 `picPath` / `picUrl`，Linux 原图在 `sourcePath`。

空值判定必须用 `!= null`：`!== undefined` 会把普通消息误判成 grayTip 后丢弃；
Satori 侧 `null.subElementType` 抛错会被事件通道吞掉。

### arm64 qemu 运行期

- 容器架构 `aarch64`（qemu 用户态，非真机）；arm64 node 为 v24.16.0 官方 linux-arm64。
- arm64 stub 69,424 字节（同 `stub-linux.cc` 源码交叉编译）。
- 预加载 `stub:libgnutls.so.30:libuuid.so.1`（三个都要）。
- `dlopen` → `exports=104 engine=true`，进程正常退出。
- `initWithDeskTopConfig` 返回 `true`；MMKV `root dir: /data/nt_qq/global/nt_data/mmkv`。
- `login.connect()` → `onLoginConnected` 触发；`getLoginList()` →
  `{"result":0,"LocalLoginInfoList":[]}`；进程 RC=0。

只 preload stub + gnutls 时 dlopen 能过，但首次 `uuid_generate` 报 symbol lookup error。
容器另装 `libnss3` / `libnspr4` / `libgbm1`（未单独验证是否必需）。

### arm64 交付缺口

- stub 未进私有 `native/`：只有 `build/linux-x64` 入包，arm64 产物是本机交叉编译的未跟踪文件。
- `linuxPreload` 缺 `libuuid`：源码只拼 `stub:gnutls`，arm64 靠手工三件套绕过。
- 清单无 arm64 条目：`LINUX_MAINTAINED_ARCHES = ["x64"]`。
- 内置 `7zz` 只有 x86-64（`e_machine=0x3e`），arm64 上 `cannot execute`；非 x64 回退系统 7-Zip。
- 真机端到端：登录（快速 / 扫码）、session READY、收发未在真机跑过。
