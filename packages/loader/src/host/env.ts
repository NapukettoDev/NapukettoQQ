/**
 * env.ts：引导进程环境变量访问层（2026-08-07 阶段 2）。
 *
 * 根 tsconfig 开启 noPropertyAccessFromIndexSignature——process.env 是索引签名
 * 类型（Record<string, string | undefined>），点访问会报 TS4111；且 useNamingConvention
 * 不允许 typeMember 用 CONSTANT_CASE。故改为「对象字面量快照」：
 *  - 对象字面量成员允许 CONSTANT_CASE（biome 配置），键是字面量 → env.XXX 点访问合法
 *  - 快照语义：引导进程内环境变量不变（launcher spawn 前注入完毕），取一次即可
 */
const env = {
    /** kernel 入口（.mjs，bootstrap 动态 import）。 */
    NAPUTO_KERNEL_ENTRY: process.env["NAPUTO_KERNEL_ENTRY"],
    /** QQ 版本号（appid 解析 / 协议装配用）。 */
    NAPUTO_QQ_VERSION: process.env["NAPUTO_QQ_VERSION"],
    /** 配置目录（数据根，日志 / 协议配置兜底）。 */
    NAPUTO_CFG_DIR: process.env["NAPUTO_CFG_DIR"],
    /** wrapper.node 绝对路径（dlopen 目标）。 */
    NAPUTO_WRAPPER_PATH: process.env["NAPUTO_WRAPPER_PATH"],
    /** adapter 包入口（协议装配用）。 */
    NAPUTO_ADAPTER_ENTRY: process.env["NAPUTO_ADAPTER_ENTRY"],
    /** network 包入口（协议装配用）。 */
    NAPUTO_NETWORK_ENTRY: process.env["NAPUTO_NETWORK_ENTRY"],
    /** 自建宿主标记（=1：标准 node + stub 引导，launcher 注入）。 */
    NAPUTO_SELF_HOST: process.env["NAPUTO_SELF_HOST"],
    /** stub QQNT.dll 目录（launcher 注入，self-host 诊断用）。 */
    NAPUTO_STUB_DIR: process.env["NAPUTO_STUB_DIR"],
    /** 强制指定快速登录账号（防风控账号挂起）。 */
    NAPUTO_QUICK_UIN: process.env["NAPUTO_QUICK_UIN"],
    /** 强制扫码登录（=1：跳过快速登录直接 QR；koishi 面板「扫码登录」重启路径）。 */
    NAPUTO_QR_ONLY: process.env["NAPUTO_QR_ONLY"],
    /** 收发消息冒烟自检开关（=1 触发）。 */
    NAPUTO_SMOKE: process.env["NAPUTO_SMOKE"],
    /** IPC 子进程模式（=1：koishi 插件驱动——stdout 走 JSON 行协议，stdin 收 action/control）。 */
    NAPUTO_IPC: process.env["NAPUTO_IPC"],
    /** 冒烟目标 peer（c2c:<uin> / group:<uin>，缺省发给自己）。 */
    NAPUTO_SMOKE_PEER: process.env["NAPUTO_SMOKE_PEER"],
    /** 运行时探测开关（=1 触发 probeRuntime）。 */
    NAPUTO_PROBE: process.env["NAPUTO_PROBE"],
    /** listener 录制器开关（=1 触发 startListenerRecording，先于探测挂起——批次三前置）。 */
    NAPUTO_LISTENER_RECORD: process.env["NAPUTO_LISTENER_RECORD"],
    /** 全局 TOML 配置显式路径（优先级最高）。 */
    NAPKETTO_CONFIG: process.env["NAPKETTO_CONFIG"],
    /** 内联主配置 JSON 文本（嵌入式宿主注入；优先级高于 NAPKETTO_CONFIG 文件，2026-10-25）。 */
    NAPKETTO_CONFIG_JSON: process.env["NAPKETTO_CONFIG_JSON"],
    /** 数据根（kernel 数据目录，cleanCache 用）。 */
    NAPKETTO_DATA: process.env["NAPKETTO_DATA"],
    /** 数据根（launcher 注入，停止哨兵目录解析用）。 */
    NAPUTO_DATA_ROOT: process.env["NAPUTO_DATA_ROOT"],
};

export { env };
