/**
 * NapukettoCore 的装配 / 登录选项（纯类型声明，从 `core.ts` 拆出）
 *
 * 由 `core.ts` 重新导出，包门面导出坐标不变。
 */
import type { LogFormat, LogLevel, PathOptions, TimestampMode } from "../infra/index.js";
import type { LoginProgress } from "./login/qr-flow.js";

/** 装配选项（paths + logger）。 */
export interface NapukettoCoreOptions {
    /** 数据根 / 账号（透传给 PathWrapper，见 ADR-016）。 */
    paths?: PathOptions | undefined;
    /** 日志级别，默认 info。 */
    logLevel?: LogLevel | undefined;
    /** 文件日志路径；不传则默认 `logs/napuketto.log`（父目录自动创建）。 */
    logFile?: string | undefined;
    /** 文件目的地级别（可低于控制台级别；缺省同 logLevel）。 */
    logFileLevel?: LogLevel | undefined;
    /** 是否输出 console，默认 true。 */
    consoleLog?: boolean | undefined;
    /** 控制台格式（缺省按 TTY 自动：TTY pretty / pipe single-line）。 */
    logFormat?: LogFormat | undefined;
    /** 时间戳渲染模式，默认 local。 */
    logTimestamp?: TimestampMode | undefined;
    /** 控制台颜色（缺省自动）。 */
    logColorize?: boolean | undefined;
    /** 账号标注（记录结构化 account 字段；快速登录目标账号，登录前已知时传入）。 */
    account?: string | undefined;
}

/** login 参数。 */
export interface CoreLoginOptions {
    /**
     * appid（登录握手）。**可选**：未传时自动从 wrapperPath 同目录 major.node
     * 解析（`resolveAppidQua`）；wrapperPath 缺省回退 `NAPUKETTO_WRAPPER_PATH` /
     * `NAPUKETTO_WRAPPER_PATH` 环境变量。仍无法解析则抛 INVALID_PARAM。
     */
    appid?: string | undefined;
    /** session.init 超时（毫秒），默认 15s。 */
    initTimeoutMs?: number | undefined;
    /** 指定快速登录账号（缺省遍历历史列表）。 */
    quickUin?: string | undefined;
    /**
     * 单步快速登录超时（毫秒，T3 软重登挂起兜底），默认 20s。服务端已有同账号
     * 会话时底层 quickLoginWithUin/getLoginList 永久挂起，超时按登录失败抛出
     * （qrFallback 可接）。底层 promise 无法取消：超时后悬挂丢弃。
     */
    quickLoginTimeoutMs?: number | undefined;
    /** 快速登录失败时回退 QR 登录（二维码写账号 cache/qr 临时目录），默认 false。 */
    qrFallback?: boolean | undefined;
    /** 强制扫码：跳过快速登录，直接走 QR 登录（koishi 强制扫码 / 切账号）。默认 false。 */
    qrOnly?: boolean | undefined;
    /**
     * QR 二维码图片保存路径（显式指定时由调用方接管生命周期；默认
     * `<账号目录>/cache/qr/qrcode.png`，登录结束删除）。
     */
    qrCodePath?: string | undefined;
    /** 登录进度回调（QR 阶段：二维码数据 + 状态变化）。子进程 IPC 模式转发用。 */
    onLoginProgress?: ((progress: LoginProgress) => void) | undefined;
    /**
     * 登录成功后自动完成 Session 激活闭环（accountPath → machineGuid →
     * buildSessionConfig → initAndStartSession → waitSessionReady）。
     * 默认 false：保持 loader 现有「手动 activateSession」流程 100% 兼容。
     */
    activateSession?: boolean | undefined;
}
