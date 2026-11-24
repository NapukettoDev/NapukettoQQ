/**
 * env.ts：引导进程环境变量访问层（2026-08-07 阶段 2）。
 *
 * 根 tsconfig 开启 noPropertyAccessFromIndexSignature——process.env 是索引签名
 * 类型（Record<string, string | undefined>），点访问会报 TS4111；且 useNamingConvention
 * 不允许 typeMember 用 CONSTANT_CASE。故改为「对象字面量快照」：
 *  - 对象字面量成员允许 CONSTANT_CASE（biome 配置），键是字面量 → env.XXX 点访问合法
 *  - 快照语义：引导进程内环境变量不变（launcher spawn 前注入完毕），取一次即可
 *
 * 前缀唯一（2026-11）：只读规范前缀 `NAPUKETTO_*`，不做旧拼写别名兼容，属性名与环境
 * 变量名一一对应。唯一例外是闭源 stub 硬编码的原生契约键 `NAPUTO_MEDIA_PATCH_STATUS`
 * （禁止改名）。
 */
const env = {
    /** kernel 入口（.mjs，bootstrap 动态 import）。 */
    NAPUKETTO_KERNEL_ENTRY: process.env["NAPUKETTO_KERNEL_ENTRY"],
    /** QQ 版本号（appid 解析 / 协议装配用）。 */
    NAPUKETTO_QQ_VERSION: process.env["NAPUKETTO_QQ_VERSION"],
    /** 配置目录（数据根，日志 / 协议配置兜底）。 */
    NAPUKETTO_CFG_DIR: process.env["NAPUKETTO_CFG_DIR"],
    /** wrapper.node 绝对路径（dlopen 目标）。 */
    NAPUKETTO_WRAPPER_PATH: process.env["NAPUKETTO_WRAPPER_PATH"],
    /** adapter 包入口（协议装配用）。 */
    NAPUKETTO_ADAPTER_ENTRY: process.env["NAPUKETTO_ADAPTER_ENTRY"],
    /** network 包入口（协议装配用）。 */
    NAPUKETTO_NETWORK_ENTRY: process.env["NAPUKETTO_NETWORK_ENTRY"],
    /** 自建宿主标记（=1：标准 node + stub 引导，launcher 注入）。 */
    NAPUKETTO_SELF_HOST: process.env["NAPUKETTO_SELF_HOST"],
    /** stub QQNT.dll 目录（launcher 注入，self-host 诊断用）。 */
    NAPUKETTO_STUB_DIR: process.env["NAPUKETTO_STUB_DIR"],
    /** 强制指定快速登录账号（防风控账号挂起）。 */
    NAPUKETTO_QUICK_UIN: process.env["NAPUKETTO_QUICK_UIN"],
    /** 强制扫码登录（=1：跳过快速登录直接 QR；koishi 面板「扫码登录」重启路径，一次性）。 */
    NAPUKETTO_QR_ONLY: process.env["NAPUKETTO_QR_ONLY"],
    /** 显式 IPC 诊断动作开关（=1/true；默认关闭，仅本地调试）。 */
    NAPUKETTO_DIAG: process.env["NAPUKETTO_DIAG"],
    /** 收发消息冒烟自检开关（=1 触发）。 */
    NAPUKETTO_SMOKE: process.env["NAPUKETTO_SMOKE"],
    /** IPC 子进程模式（=1：koishi 插件驱动——stdout 走 JSON 行协议，stdin 收 action/control）。 */
    NAPUKETTO_IPC: process.env["NAPUKETTO_IPC"],
    /** 冒烟目标 peer（c2c:<uin> / group:<uin>，缺省发给自己）。 */
    NAPUKETTO_SMOKE_PEER: process.env["NAPUKETTO_SMOKE_PEER"],
    /** 运行时探测开关（=1 触发 probeRuntime）。 */
    NAPUKETTO_PROBE: process.env["NAPUKETTO_PROBE"],
    /** listener 录制器开关（=1 触发 startListenerRecording，先于探测挂起——批次三前置）。 */
    NAPUKETTO_LISTENER_RECORD: process.env["NAPUKETTO_LISTENER_RECORD"],
    /** 全局 TOML 配置显式路径（优先级最高）。 */
    NAPUKETTO_CONFIG: process.env["NAPUKETTO_CONFIG"],
    /** 内联主配置 JSON 文本（嵌入式宿主注入；优先级高于 NAPUKETTO_CONFIG 文件，2026-10-25）。 */
    NAPUKETTO_CONFIG_JSON: process.env["NAPUKETTO_CONFIG_JSON"],
    /** 数据根（kernel 数据目录，cleanCache 用）。 */
    NAPUKETTO_DATA: process.env["NAPUKETTO_DATA"],
    /** 数据根（launcher 注入，停止哨兵目录解析用）。 */
    NAPUKETTO_DATA_ROOT: process.env["NAPUKETTO_DATA_ROOT"],
    /**
     * 入站图片自动下载补丁状态文件路径（launcher 注入；stub 后台线程写 JSON，2026-11-14）。
     * 原生二进制硬编码读 `NAPUTO_MEDIA_PATCH_STATUS`：属性名与环境变量名一致，
     * 不设新前缀别名（闭源 native 契约零破坏）。
     */
    NAPUTO_MEDIA_PATCH_STATUS: process.env["NAPUTO_MEDIA_PATCH_STATUS"],
};

/**
 * 布尔环境变量解析（唯一口径）：`"1"` / `"true"` → true，其余值（含 `"0"` /
 * `"false"` / 未设置）→ false。避免散落 `env.XXX === "1"` 导致 `NAPUKETTO_XXX=true` 失效。
 */
export function isEnvEnabled(val: string | undefined): boolean {
    return val === "1" || val === "true";
}

/**
 * 读取并消费一次性扫码标记（`NAPUKETTO_QR_ONLY`）。
 *
 * 该标记只对本次登录生效：读取后立即从 `process.env` 删除，避免后续软重登、
 * 重试或同一宿主内其他代码再次读到，也减少该标记在原生子进程环境中的停留时间。
 */
export function consumeQrOnlyMarker(): boolean {
    const enabled = isEnvEnabled(env.NAPUKETTO_QR_ONLY);
    delete process.env["NAPUKETTO_QR_ONLY"];
    return enabled;
}

export { env };
