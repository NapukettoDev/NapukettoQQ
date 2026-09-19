# 调查交接：自建宿主图片发送失败（rich media transfer failed）

> **归档说明（2026-09-20）**：本调查已完结（图片/语音发送均已修复并落地 kernel），问题主线见 §5.5-§5.7；归档备查，细节勿再当作现状。

> **状态**：✅ **图片发送已修复（2026-08-11 晚，elementType=2 重大发现）**——真正的根因是
> **PIC 元素 elementType 应为 2（PIC），之前所有实验和 kernel 发送路径误用 1（TEXT）**！
> NapCat 式完整流程（elementType=2 + md5 + getRichMediaFilePathForGuild + util.copyFile
> + 完整 picElement）落地 kernel 后，自建宿主图片发送实测成功（sendStatus=2，真实 fileUuid）。
> 之前的 FlashTransferUploadManager 未初始化结论（§5.4）在 elementType 错误前提下得出，
> 已证伪——**根本不是 Init 问题，是 elementType 用错了**。
> 文本修复见 §5.5；图片修复见 §5.6。
> **交接给**：新对话（先读 §5.5 + §5.6）。
> **日期**：2026-08-11。

## 1. 问题背景

用户环境：koishi + koishi-plugin-adapter-napuketto + 自建宿主（标准 Node + stub QQNT.dll + wrapper.node）。

现象：redposter 等插件发图片，daemon 日志：

```
[I] redposter 已缓存海报图片 e12-697.jpg（339437 字节）
[W] session IpcError: 动作 msg.sendMessage 失败: sendMsg 失败: rich media transfer failed
```

文本发送正常、接收图片正常，唯独**发送图片/富媒体失败**。

## 2. 已实证结论（勿重复探索）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **路径格式无关**：反斜杠/正斜杠/带 fileName 全失败 | 诊断脚本 IPC 直发三种形态全 `rich media transfer failed` |
| 2 | **临时目录缺失无关**：全盘创建 `upload_temp`/`download_temp`/`OriTemp`/`ThumbTemp` 后仍失败 | 同上 |
| 3 | **账号冲突无关**：关闭真 QQ 客户端后仍失败 | 同上 |
| 4 | `NodeQQNTWrapperUtil.setUserDataSaveDirectory` **NAPI 方法不存在**（二进制有 C++ 符号但非 NAPI 导出） | `util.get()` 方法面枚举，`initUserDataSaveDirectory` 诊断输出「方法缺失」 |
| 5 | `getPicTmpPath()` 正常返回上传临时目录：`nt_data\Pic\1970-01\OriTemp` / `ThumbTemp` 等 | IPC 诊断 action 实测返回 12 个目录路径 |
| 6 | **`1970-01` 是 Unix 时间戳 0 的日期** → 上传管理器**时间基准未初始化**（正常应为当前年月如 `2026-08`） | getPicTmpPath 返回值 |
| 7 | `getFlashTransferService()` 返回完整服务（含 `createFlashTransferUploadTask`/`createMergeShareTask`/`getFileSetList` 等），但 **sendMsg 内部不走它** | IPC 探测 flashService 方法面 |
| 8 | **根因：sendMsg 内部的上传链路（`FlashFileUploadService` C++ 内部类）未初始化** | 见下方 wrapper.node 日志证据 |
| 9 | **⚠️ Ghidra 项目里加载的是旧版 wrapper.node**（`.text` 段大小与磁盘 9.9.33 不符），**Ghidra 地址不能用于磁盘二进制** | 磁盘 PE 解析对比（见 §5 顶部） |
| 10 | 上传链路机制已定位（磁盘 9.9.33 真实地址）：元素发送器 `FUN_1812e7388` → result+0x20 错误标记 → "rich media transfer failed"；`FlashTransferUploadManager::Init`（`FUN_181931084`）创建 FlashFileUploadService，由 FlashTransferService 虚方法 `FUN_180a33e20` 驱动 | 见 §5 逆向进展表（2026-08-10） |

## 3. wrapper.node 二进制关键证据（字符串上下文）

wrapper.node 路径：`<项目/工作目录>\QQNT\versions\9.9.33-51802\resources\app\wrapper.node`（114MB）。

### 3.1 上传链路日志（sendMsg 内部）

```
RemoteAction MsgSender file[{}] call sendMsg msg_id={} listener_id={} path={}
CreateTempDir Fail. error:{} path={}
Start Upload. transfer_id:{} biz_type:{} path={}
GetSha1ByFilePath: file_handle is invalid, path={}
```

### 3.2 上传管理器未初始化（防御日志 = null）

```
FlashFileUploadService::GetThumbPath this is null
FlashFileUploadService::BatchStartUploadTask this is null
FlashFileUploadService::RemoveFileSetSpeedMonitor this is null
BatchUploadService::CancelUploadSession task_runner is null
BatchUploadService::BatchStartUploadTask task_runner is null
```

### 3.3 传输内核 sink 为空

```
transfer_kernel_sink_ is empty, session_id={} target_uin={} result={}
```

### 3.4 上传前置流程（缩略图 → 哈希 → 上传）

```
ProcessTask create thumb Err, fileset_id:{}, task_id:{}, task_size:{}, err:{}
CalcOrigFileSha1 failed, ret:{}, file_size:{}, err:{}
FlashFileUploadMgr::CheckAndUploadOrigFile orig task is enable send
CreateFlashUploadTask name:{} totalFileCount:{} totalFileSize:{}
```

### 3.5 关键 NAPI 方法（wrapper.node exports）

- `NodeIKernelRichMediaService`：`getPicTmpPath`/`getRichMeidaTmpPath`/`getPttTmpPath`/`getVideoTmpPath`/`getFileTmpPath`/`getTransferingTmpPath`（均 0 参数，返回逗号分隔的多目录路径）
- `NodeIKernelFlashTransferService`：`startFileSetUpload`/`stopFileSetUpload`/`pauseFileSetUpload`/`resumeFileSetUpload`/`getFileSetIdByCode`/`checkUploadPathValid`
- `NodeIKernelBatchTransferService`：`batchTransferUpload`
- `NodeIBatchUploadManager`、`NodeIKernelBatchUploadService`

### 3.6 exports 全部 98 个 key

（含 `NodeIQQNTWrapperEngine`、`NodeIQQNTWrapperSession`、`NodeIKernelLoginService`、`NodeIKernelMsgService`、`NodeIKernelRichMediaService`、`NodeIKernelFlashTransferService`、`NodeIKernelBatchTransferService`、`NodeIBatchUploadManager`、`NodeIKernelBatchUploadService`、`NodeIKernelRemoteFileService`、`NodeIKernelFileBridgeHostService`、`NodeQQNTWrapperUtil`、`NodeIO3MiscService` 等；完整列表见前次会话 `.tmp-exports.txt` 输出，或重跑枚举脚本。）

## 4. 已排除的修复方向（勿再试）

1. ~~路径正斜杠规范化~~（`apps/koishi-plugin-adapter` 的 `normalizeMediaPath`，commit `82eb968`，已提交但**无效于本问题**——路径无关）
2. ~~`NodeQQNTWrapperUtil.setUserDataSaveDirectory`~~（NAPI 方法不存在）
3. ~~手工创建临时目录~~（`OriTemp`/`ThumbTemp`/`upload_temp`/`download_temp` 全建了仍失败）

## 5. 下一步：Ghidra 逆向计划

**目标**：定位 `FlashFileUploadService`（或等价的上传管理器）的**初始化入口**，找到「QQ 前端启动时调用、自建宿主漏掉」的那个函数。

### ⚠️ 2026-08-10 逆向进展（关键：Ghidra 里是旧版 wrapper.node！）

> **重大发现（本次会话）**：**Ghidra 项目（NapukettoWrapper.rep）加载的 wrapper.node 与磁盘
> `9.9.33-51802` 版本不一致**——Ghidra 的 `.text` 段为 `180001000-1839563ff`（约 60MB），
> 磁盘真实 `.text` 为 `180001000-183e70b2d`（约 65MB，`VSz=0x3e6fb2d`）。**Ghidra 里的所有
> 地址（字符串/函数/vtable）都不能直接映射到磁盘二进制**，之前会话的逆向结论（FUN_1825f05a4
> 等）是旧版上的，仅供理解类结构，不能用于 patch 或定位。
>
> 因此本次会话**直接在磁盘二进制上做 PE 解析 + 字节搜索 + capstone 反汇编**，获得以下**9.9.33 真实地址**：

| # | 事实（磁盘 9.9.33-51802 实证） | 证据 |
|---|---|---|
| 1 | `rich media transfer failed` 字符串真实 VA = `0x1847E8AA2`（off `0x47e7aa2`） | 字节搜索 + PE VA 映射（之前记录的 `0x184202053` 是 Ghidra 旧版地址，勿用） |
| 2 | **抛出点 = `FUN_1812e7388`（元素发送器，sendMsg 富媒体链路的子函数）**，两处引用：指令 VA `0x1812e7717` / `0x1812e77b6` | RIP-relative LEA 引用扫描（修正版算法） |
| 3 | **失败分支条件**：`0x1812e77a8: cmp qword ptr [rax + 0x20], 0; je 0x1812e77db` —— 即**某 result 对象的 `+0x20` 字段非 0**（错误码/错误标记）→ 打日志 "rich media transfer failed" 并调 `0x180028384`（错误处理） | capstone 反汇编 `0x1812e7400-0x1812e7800` |
| 4 | `FUN_1812e7388` 内部：遍历消息元素（`r15d` = 元素类型 1/2/3），从 `[rbp+0x118]`（r9 参数，指向 service 对象）取 cpp_impl，经 vtable 槽 `0x80`/`0xa0`/`0x20` 虚调用处理各类型元素 | 同上反汇编 |
| 5 | **`FlashTransferUploadManager::Init` = `FUN_181931084`**（引用日志字符串 "FlashTransferUploadManager Init" @ VA `0x1846721ED`，off `0x46711ed`） | 引用扫描：`0x181931152` LEA |
| 6 | Init 关键路径：从 `[rcx+0x60]` 取 manager → 检查 `[rsi+0x90]` 为空时调 `FUN_18193159A` 工厂创建（第 17 步 `0x1819312d3`）→ 再调 `FUN_182a516bc`（FlashFileUploadService 区域函数）初始化 | 反汇编 `0x181930f52-0x1819313c2` |
| 7 | **驱动 UploadManager::Init 的上层 = `FUN_180a33e20`**（flash_transfer_service.cc 的虚方法，vtable[0] 槽 @ VA `0x183f72300`），在 `0x180a33ebf` 处 CALL `FUN_181931084`；Init 传入 this+0x70/0x80/0x138 三个路径/配置参数 | 反汇编 `0x180a33e20-0x180a34000` + CALL 扫描 |
| 8 | `FUN_180a33e20` 无直接 CALL 引用 → 是**虚函数**（经 vtable 调用），说明它在 QQ 前端由**某个 session/service 生命周期回调**触发（如 session init 完成 / 登录后初始化）——这正是自建宿主漏掉的环节 | CALL 扫描（E8 模式）为空 |
| 9 | `FUN_180a331e0`（flash_transfer_service 初始化包装）被 `FUN_180a20578` 调用（调用点 `0x180a205d0`）；`FUN_180a20578` 从 service 对象字段（+0x58/+0x78/+0x80/+0x48/+0x50）取配置传给初始化 | 反汇编 + CALL 扫描 |
| 10 | `FlashFileUploadService` 方法区 = `0x182a5xxxx`（`AllocDedicatedThread sucess` 引用 @ `0x182a5375d`；`GetThumbPath this is null` @ `0x182a55c64`；`BatchStartUploadTask this is null` @ `0x182a55536`） | 引用扫描（修正算法） |

**推论（上传链路未初始化的机制）**：
- sendMsg 内部（`FUN_1812e7388` 元素发送器）处理 PIC 元素时，依赖 `FlashFileUploadService`（其方法区在 `0x182a5xxxx`），但该服务实例为 null（wrapper 日志 `this is null` 实证）。
- `FlashFileUploadService` 由 `FlashTransferUploadManager::Init`（`FUN_181931084`）创建；而 Init 由 `FUN_180a33e20`（FlashTransferService 虚方法）驱动。
- **自建宿主漏掉的 = 触发 `FUN_180a33e20` 的那个 QQ 前端生命周期调用**（最可能是 session/service 初始化完成回调）。
- NAPI 层 `getFlashTransferService()` 有效 ≠ 内部 UploadManager 已初始化（调查文档 §2 事实 7/8 差异的来源：NAPI 服务对象与 C++ 内部上传链是两套）。

### 5.1 需要反编译定位的问题（更新）

1. **~~sendMsg 收到 PIC 元素后的内部路径~~** ✅ 已定位：`FUN_1812e7388` 元素发送器（磁盘 VA），PIC 元素经 vtable 槽 `0x80`/`0xa0` 虚调用处理；失败时 result+0x20 置错误码 → "rich media transfer failed"。
2. **`FlashFileUploadService`/`FlashTransferUploadManager` 的初始化函数** ✅ 已定位：Init = `FUN_181931084`，驱动者 = `FUN_180a33e20`（FlashTransferService 虚方法）。**待办**：找到 `FUN_180a33e20` 的虚调用触发点（谁在 session 生命周期里调它）。
3. `transfer_kernel_sink_` 的赋值点：磁盘上字符串未找到（Ghidra 旧版有），可跳过或改用其他证据。
4. `1970-01` 时间基准：Init 传入的路径参数（this+0x70/0x80/0x138）决定了上传目录，自建宿主路径未走 Init → 时间基准为 Unix 0。
5. **`rich media transfer failed` 字符串的引用** ✅ 已定位（见上表 #1-3）。

### 5.2 Ghidra 使用建议（修正）

- **⚠️ 先确认 Ghidra 加载的是不是 9.9.33-51802 的 wrapper.node**：比较 `.text` 段大小（9.9.33 = `180001000-183e70b2d`；旧版 ≈ `180001000-1839563ff`）。不一致则 **Ghidra 地址全部作废**，改用磁盘二进制 + Python（PE 解析 + 字节搜索 + capstone 反汇编）直接分析（本次会话已搭好工具链，脚本见 `%TEMP%\*.py`：`find_refs_fixed.py` 修正版 RIP-relative 扫描 / `disasm_*.py` capstone 反汇编）。
- 若要在 Ghidra 里重做：重新导入磁盘 9.9.33 的 wrapper.node 并重跑 auto-analysis，再按 §5.1 新结论验证。
- wrapper.node 有符号表（RTTI/导出名），`im_core@nt` 命名空间下函数名可读（但 RTTI 追踪到 vtable 的 COL 布局与 MSVC 标准不完全一致，参考价值有限）。

### 5.3 验证方法（找到候选初始化函数后）

自建宿主引导流程在 `packages/loader/src/host/core/self-host.ts`（dlopen → O3MiscService 激活 → bootstrap）。候选修复点：`bootstrapWithCore`（`bootstrap-core.ts`）里 `attachWrapper` 后、登录前，补调初始化 NAPI（如 `session.getFlashTransferService()` 的某个 init 方法，或 exports 上某类的初始化）。

**2026-08-10 新增候选动作（按可行性排序，验证时从第 1 个开始）**：

1. **调用 `getFlashTransferService()` 拿到服务后，直接触发其方法面里的「会话/初始化类」方法**（如 `addFileSetSimpleStatusListener`/`setFlashTransferDir`/`setFileSetDownloadDir` 等有 side-effect 的 NAPI——任选一个调用，观察 wrapper 日志是否出现 `FlashTransferUploadManager Init` 或 `AllocDedicatedThread sucess`；若出现说明该调用顺带驱动了 `FUN_180a33e20`→Init 链路）。
2. **反汇编 `FUN_180a33e20`（磁盘 VA）确认它是不是 Init 的唯一起点**，并检查 `session` 方法面上是否有能触发它的 NAPI（如 session.init 后的某个回调注册）。
3. 观察真 QQ 环境对照：真 QQ 前端登录后 wrapper 日志会打印哪些上传初始化日志（`FlashTransferUploadManager Init` / `AllocDedicatedThread sucess`），自建宿主缺哪些 → 缺的就是要补调的。
4. 若 NAPI 层面没有触发点，则需在 `FUN_180a33e20` 的反汇编中找到它依赖的具体对象（session/service 字段），在自建宿主 bootstrap 里构造等价调用。

验证用诊断脚本：spawn self-host（IPC 模式）→ 登录 → 发图 → 观察是否成功。

### 5.4 2026-08-11 验证结论（NAPI 层候选全部排除）

**诊断脚手架**（本轮重建，见 §8）：IPC 动作表新增 `diag.flashCall` / `diag.sessionCall` / `diag.engineCall` / `diag.richMediaCall`
（任意方法按名+参数数组调用，对象经 `callDiagnosticMethod` 复用）+ `diag.richMediaTmpPaths`（原样保留）。自建宿主
日志同步：`%TEMP%\diag-richmedia\diag*.mjs`（spawn IPC 模式 → 登录 → 逐方法调用 → 每步 rawOut 快照落盘）。

**⚠️ 关键坑（本轮修复）**：**QQ 原生日志（MMKV 等）不带 `\n`，与 stdout 的 JSON 行粘在一起**，
`readline`/`split("\n")` 解析会丢 JSON → 误判「方法调用挂起」（diag3/diag4 的 15s 超时是解析 bug，不是 NAPI 卡死）。
修复：按 `{"v":1` 起点 + 花括号深度提取 JSON（`extractIpcMessages`），容忍前缀噪声。

**完整验证记录（全部未触发 `FlashTransferUploadManager Init` / `AllocDedicatedThread sucess`）**：

| # | 候选触发 | 结果 |
|---|---|---|
| 1 | flash 服务方法面（`setFlashTransferDir`(0,dir)→result:0 / `setFileSetDownloadDir`→权限错误 / `addFileSetSimpleStatusListener`(0,cb)→ok / `resumeAllUnfinishedTasks`→ok / `startFileSetUpload`→ok / `getFileSetIdByCode`→100000 加载失败） | ❌ Init 未出现；发图仍 `rich media transfer failed` |
| 2 | `session.onLine(0/1/""/{}/...)` | ❌ NAPI 要求 1 参且对象，报 `Cannot convert undefined or null to object`（参数结构未知）；未触发 |
| 3 | `engine.initLog({})` / `setLogLevel(1)` / `readyToShow()`（argc 0）/ `getDeviceInfo()`（返回全空 deviceInfo） | ❌ Init 未出现 |
| 4 | `richMediaService.uploadRMFileWithoutMsg(路径)`→ok / `onlyUploadFile`（argc 2 未知） | ❌ 无任何上传日志（raw 快照仅 MMKV），静默失败——同样依赖未初始化的上传链 |

**逆向深化（2026-08-11，磁盘 9.9.33 真实地址）**：

| # | 结论 | 证据 |
|---|---|---|
| A | **uploader vtable = `0x183f722d8`**（不是 0x183f72300）：槽位 = 构造 `0x180a33d4a` / 复制构造 `0x180a33d7e` / 分配 `0x180a33d98` / 两个 engine 区函数 `0x18006ecae`/`0x18006ecb8` / **槽 5（+0x28）= `FUN_180a33e20`（Init）**（@ `0x183f72300`）。这是**模块描述符数组**而非 C++ vtable | vtable 引用扫描（4 处：Setup 装表 `0x180a214b9` + 3 处构造） |
| B | **`FUN_181931084`（FlashTransferUploadManager::Init）唯一调用者 = `FUN_180a33e20`**（`0x180a33ebf`）；而 `FUN_180a33e20` **无任何 wrapper.node 内代码调用**（E8/FF15/mov/数据段指针全空）→ 触发点**在 wrapper.node 外部**（QQ 前端生命周期） | 全 .text E8/FF15 + 数据段指针扫描 |
| C | `setFlashTransferDir` → `FlashTransferService::SetFlashTransferDir`（`0x180a206b2`，日志 "SetFlashTransferDir"）→ `SetupUploadAndDownloadManager`（`0x180a21344`，日志 "setup uploader/downloader"）→ 创建 uploader 对象（`0x180a2147a` 分配 0x38 + 装 vtable）存 service+0x20 → 初始化 `0x1809c7e30` → **把任务 Post 到 NT 逻辑线程**（`0x1809c7ffe: call [rax]` 线程 vtable[0]） | 反汇编调用链 |
| D | **NT 逻辑线程获取函数 = `0x1809bdae8`**（TEB `gs:[0x58]` + 线程局部存储，794 个调用者）；线程对象 `0x1866c46b8` 懒初始化（构造 `0x1809bce28`，唯一调用者 `0x1809bdb44`）。自建宿主未打 "NO NT Thread 111" 日志 → 线程对象存在，**但线程循环可能未运行 → Post 的任务永不执行 → Init 永不触发** | 反汇编 + 日志对照 |
| E | **模块描述符数组（0x183f722d8）无数据段持有者、无遍历代码**——是栈上临时构造对象，Init 只能被「加载数组+call 槽 5」的代码调用，而该代码不在 wrapper.node 内 | 数据段指针扫描（全 0） |

**最终推论（NAPI 层不可修复）**：触发 `FUN_180a33e20` 的调用在 QQ 前端 renderer/QQNT.dll 侧（生命周期回调），
自建宿主（标准 Node + wrapper.node）**无法通过任何 NAPI 方法触发**。修复方向只剩：

1. **C++ 载具层（loader native）直接调 Init**：构造 flash 模块对象并调用 `FUN_180a33e20`（或等价），
   或启动/喂 NT 逻辑线程让已 Post 的任务执行。属「允许逆向手段」的载具层职责，但需 C++ ABI 布局。
2. **真 QQ 对照**（§5.3 候选 3）：启动真 QQ 观察 Init 日志时机与触发序列，确认前端到底调了什么（信息量大，需用户配合登录）。
3. **替代上传路径**：`uploadRMFileWithoutMsg` 同样依赖未初始化的上传链（已证），需找**不依赖 FlashTransferUploadManager**
   的上传接口（如 batchTransferService / 群文件上传链路），改 kernel 发送路径（先上传拿 fileUuid → 构造 uuid 型 PIC 元素）。

### 5.5 2026-08-11 重大发现：文本发送已修复（NapCat 式调用）

**调研 NapCat 新版源码（`<项目/工作目录>\NapCatQQ-main`）发现关键差异**——**sendMsg 调用方式不对**！

| | NapCat 方式（实测有效） | 我们旧 kernel 方式（实测失败） |
|---|---|---|
| sendMsg 第一参 | **`'0'`**（固定值） | msgId |
| msgId 位置 | **`peer.guildId = msgId`** | 第一参 |
| 成功判定 | **等 `onMsgInfoListUpdate` 事件 `sendStatus===2`**（NapCat `sendMsg` 不看返回值） | 看返回 `result===0` |
| 监听时机 | **先注册事件再调 sendMsg**（事件可能早于返回触发） | 调完才等 |

**实证（diag16/diag20，2026-08-11）**：
- 旧方式：`sendMsg(msgId, peer, ...)` → 文本也返回 `result=5`（**文本之前也失败**，并非「只有图片失败」）
- NapCat 式：`sendMsg('0', peer+guildId, ...)` + 先注册 `onMsgInfoListUpdate` 再发送 → **文本 `result=0` + 事件 `sendStatus=2` 成功**
- **boot 日志实证**：`接收 <- 群聊 [群<测试群号>] [用户<测试QQ号>]： napuketto-fixed-...`——文本真实发到群里！

**修复落地（kernel）**：
1. `MsgListener` 补 `onMsgInfoListUpdate`（发送状态更新事件）
2. `MsgBridge` 注册该回调 → emit `Msg/onMsgInfoListUpdate`
3. `MsgApi` 构造加 `channel` 参数；`sendMessage` 改为 NapCat 式：
   - msgId 塞 `peer.guildId`，sendMsg 第一参 `'0'`
   - **先** `channel.on("Msg/onMsgInfoListUpdate")` 注册确认监听，**再** sendMsg
   - 事件 `sendStatus===2/3` 成功 resolve；`===0` 失败 reject；超时兜底
4. `RawMessage` 补 `sendStatus` 字段
5. kernel-services 传 channel 给 MsgApi

**图片仍失败（sendStatus=0）**：图片发送依赖 `FlashTransferUploadManager` 初始化（§5.4 根因），
NapCat 式调用让错误从模糊的 `rich media transfer failed` 变为清晰的 `sendStatus=0`，但未解决初始化。
NapCat 纯 Node 模式同样未处理此问题（其 sendMsg 也直接调 msgService，无 flash 初始化）——
**NapCat 靠注入 QQ 前端（完整环境）绕开**，纯 Node 模式图片大概率同样失败。

**NapCat 式图片流程（已完整复刻验证，仍失败）**：`getRichMediaFilePathForGuild`（返回纯文件名）
→ `util.copyFile`（原生，QQ 内部解析位置）→ picElement 填 `md5HexStr`+`sourcePath`+`fileUuid:''`
→ NapCat 式 sendMsg。**结论：文件放置路径不是根因，FlashTransferUploadManager 未初始化才是。**

### 5.6 2026-08-11 重大发现：图片发送已修复（elementType=2 + NapCat 式完整流程）

**真正的根因：PIC 元素 `elementType` 应为 `2`（PIC），之前一直误用 `1`（TEXT）！**

NapCat 源码 `ElementType` 枚举（`packages/napcat-core/types/msg.ts`）：

```typescript
enum ElementType {
  UNKNOWN = 0, TEXT = 1, PIC = 2, FILE = 3, PTT = 4, VIDEO = 5, ...
}
```

- **kernel `toSendElements` image 分支**：`elementType: ElementType.PIC` 已经是 2 ✅（此分支没写错）
- **但历史诊断脚本 diag18/31/33 全用 `elementType: 1`**（错误）→ 得出「FlashFileUploadManager 未初始化」的错误结论
- **diag35 改成 `elementType=2` + 真实 fileUuid**：错误从 `result=5`（参数错）变成 `result=-1: "rich media transfer failed"`——发送器**正确进入富媒体逻辑**（之前根本没走对分支）

**验证序列（diag36，elementType=2 + NapCat 式完整流程）**：

1. `getRichMediaFilePathForGuild({md5HexStr, fileName, elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: ""})` → 返回纯文件名
2. `util.copyFile(path, relPath)`（原生，放 Ori 目录）
3. sendMsg：`['0', peer+guildId, [{elementType: 2, elementId: "", picElement: {md5HexStr, fileSize, fileName, sourcePath: relPath, original: true, picType: 1000, picSubType: 0, fileUuid: "", ...}}]]`
4. **结果：sendMsg `result=0` + 事件 `sendStatus=2` + 真实 `fileUuid` 生成 + `sourcePath` 指向 `Pic\2026-08\Ori\`（时间基准正确！）**

**kernel 落地（commit 待定）**：
1. `PicElement` 类型补发送用完整字段（md5HexStr/fileSize/original/picSubType/fileUuid/fileSubId/thumbFileSize/summary）
2. `NodeIKernelMsgService` 补 `getRichMediaFilePathForGuild`
3. `MsgApi` 构造加 `util` 参数（copyFile 用）；`sendMessage` 图片元素走 NapCat 式预处理（md5 → getRichMediaFilePathForGuild → util.copyFile → 完整 picElement，elementType=2）
4. loader `kernel-services` 传 util 给 MsgApi；`types.ts` 构造签名加 util

**意义**：FlashTransferUploadManager 未初始化结论（§5.4）被证伪——发送器在 elementType=2 + 完整字段时能正常上传（时间基准目录自动建 `2026-08`）。**富媒体发送核心链路全部打通**，无需 C++ 载具层逆向。

### 5.7 2026-08-12 语音（PTT）发送已修复（完整 pttElement + NapCat 式预处理）

**现象（用户线上）**：发语音 → koishi 日志 `IpcError: 动作 msg.sendMessage 失败: Cannot convert undefined or null to object` → 约 15s 后 loader 子进程退出 → supervisor 自动重启（日志出现 idle → booting → ready 循环）。

**根因**：kernel `toSendElements` voice 分支只构造 `{ elementType: 4, pttElement: { filePath } }`——缺 `md5HexStr/fileSize/duration` 等字段。wrapper 内部转换 pttElement 时对 undefined 字段做对象操作 → 抛 `Cannot convert undefined or null to object` → 原生状态损坏 → 进程崩溃。与图片修复前同类问题（§5.6），图片是 elementType 错，语音是字段不全。

**修复（kernel `MsgApi.preparePttElement`，与 prepareImageElement 同构）**：
1. `statFile`/`hashFile`（node:fs/crypto）→ fileSize + md5
2. `getRichMediaFilePathForGuild({md5HexStr, fileName, elementType: 4(PTT), elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: ""})` → 相对路径
3. `util.copyFile(path, relPath)` 放置文件
4. 完整 pttElement：`fileName / filePath / md5HexStr / fileSize / duration(文件大小÷1024÷3 估算) / formatType:1 / voiceType:1 / voiceChangeType:0 / canConvert2Text:true / waveAmplitudes:[0,18,9,23,16,17,16,15,44,17,24,20,14,15,17] / fileSubId:"" / playState:1 / autoConvertText:0 / storeID:0 / otherBusinessInfo:{aiVoiceType:0}`
5. 重构：PIC/PTT 共用 `placeMediaFile(path, elementType, md5, fileName)`

**实证（diag 脚本直测，未动 koishi）**：
- 发送返回 `ok:true` + msgId `7747252779790436789`
- 拉群消息确认：`sendStatus:2`、`transferStatus:2`、真实 `fileUuid`（`EhS167QftZ7yY5RxqxmMPNEYkifNYBiK9hsg-woox...`）、`duration:148`、群「<测试群>」
- 进程 25s 未崩溃（旧 bug 约 15s 崩）

**关键事实**：**非 silk 输入（ogg）可直接发送**——wrapper 内部把 ogg 转码为 amr 落盘 `Ptt\2026-08\Ori\{md5}.amr` 并上传，**无需外部 silk 转换**（NapCat 强制转 silk 是产品兼容性选择，非协议必需）。

**其他发现**：
- asar 扫描（`application.asar`，172 个 JS）：前端**无** `FlashTransferUploadManager`/`pttElement`/`silk` 代码——PTT 发送全链路在 C++ 内部，前端只调 NAPI 服务
- `FlashTransferService` 方法面（90+）：`createFlashTransferUploadTask`/`startFileSetUpload`/`sendFlashTransferMsg` 等，**无 Init 方法**（Init 是 C++ 内部懒初始化）
- `RichMediaService` 有 `uploadRMFileWithoutMsg`/`onlyUploadFile` 备选上传路径（本轮未用）
- **diag 脚本教训**：`launchSelfHost` 的 `stdio` 必须是 `["pipe","pipe","pipe"]`——stdin 用 `"ignore"` 时 `child.stdin` 为 null，action 静默丢弃，现象是「action 超时/挂起」假象

**待办**：视频（VIDEO=5，需缩略图 thumbPath/thumbMd5/fileTime）+ 文件（FILE=3，fileElement）发送按同模式补；视频缩略图可用 ffmpeg 或 wrapper 内部生成。

## 6. 环境信息（诊断复现用）

- QQ 版本：`9.9.33-51802`（`<项目/工作目录>\QQNT\versions\9.9.33-51802`）
- wrapper.node：`<项目/工作目录>\QQNT\versions\9.9.33-51802\resources\app\wrapper.node`
- stub 目录：`<项目/工作目录>\NapukettoQQ\packages\loader\native\build\stub-test-env`
- 登录账号：`<测试QQ号>`（`<uid>`）
- 测试目标群：`<测试群号>`（chatType=2）
- 测试图片：`<项目/工作目录>\koishi-dev\data\redseries\redposter\e12-697.jpg`（145871 字节合法 JPEG）
- QQ 数据根：`<用户目录>\Documents\Tencent Files\nt_qq\global`
- 账号数据目录：`<用户目录>\Documents\Tencent Files\nt_qq\global\<测试QQ号>\nt_qq`
- boot 日志：`<项目/工作目录>\NapukettoQQ\.napuketto\<测试QQ号>\napuketto-boot.log`

## 6.5 逆向工具链（2026-08-10 会话搭建，`%TEMP%` 下脚本可复用）

- **MCP 服务器**：Ghidra 本体在 `<项目/工作目录>\ReversingTools\ghidra_12.1.2_PUBLIC`（GUI 已开，`javaw` 进程），HTTP bridge 在 `127.0.0.1:8080`（GhidraMCP 插件）；外部 MCP 服务器 = `<项目/工作目录>\ReversingTools\GhidraMCP-1-4\GhidraMCP-release-1-4\bridge_mcp_ghidra.py`（`python bridge_mcp_ghidra.py --transport sse --mcp-port 8081`），VS Code `.vscode/mcp.json` 连 `http://127.0.0.1:8081/sse`。
- **磁盘二进制分析（本次主力，Ghidra 版本不对时用这个）**：Python + `capstone` + 手写 PE 解析（`%TEMP%\peinfo.py` / `find_refs_fixed.py` 等）。**关键坑**：① `SizeOfOptionalHeader` 从 COFF header 偏移 20 读（`pe_off+20`），不是固定 240；② Ghidra MCP 返回的地址是**十六进制字符串**（无 `0x` 前缀），且与磁盘 VA 可能不一致（版本差异）；③ RIP-relative 引用扫描必须区分 REX 前缀（`48 8D modrm disp32`，7 字节）与无前缀（`8D modrm disp32`，6 字节），两者都扫；④ PE section 的 RVA 是相对 image base（`0x180000000`）的。

## 7. 代码改动状态（交接时）

- **主仓库干净**：kernel/loader 无未提交改动（诊断用的 IPC action 已回滚）
- 仅剩发包版本变更（CHANGELOG/package.json，正常）
- koishi 适配器 submodule：`82eb968`（normalizeMediaPath，已提交，对本体问题无效但保留无害）
- `.changeset/kernel-fallow-health-20260809.md` 已恢复（之前被误删）
- fallow 的 kernel 重构已提交（db34393），未触碰

## 8. 诊断脚本（交接后重建用）

前次会话的诊断脚本已清理（`.tmp-*`）。重建方法：

1. 给 `packages/loader/src/host/ipc/ipc-actions.ts` 的 `IpcApiContext` 加 `session?: unknown`，`createIpcActions` 加 `diag.richMediaTmpPaths` action（枚举 `getPicTmpPath` 等 + `getFlashTransferService` 方法面）
2. `kernel-services.ts` 的 `KernelServices` 加 `session` 字段并填充
3. `ipc-bootstrap.ts` 注入 `session`
4. `pnpm --filter @napuketto/loader build`
5. 写 Node 脚本 spawn self-host（IPC 模式，环境变量见 §6），JSON 行协议发 `diag.richMediaTmpPaths` 与 `msg.sendMessage`

关键环境变量：`NAPUTO_CFG_DIR`（账号数据目录）、`NAPUTO_WRAPPER_PATH`、`NAPUTO_KERNEL_ENTRY`、`NAPUTO_QUICK_UIN`、`NAPUTO_SELF_HOST=1`、`NAPUTO_IPC=1`、PATH 前置 stub + resources/app。
