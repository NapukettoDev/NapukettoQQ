import type { LogFormat, LogLevel, PathOptions, TimestampMode } from "../infra/index.js";
import type { LoginProgress } from "./login/qr-flow.js";

export interface NapukettoCoreOptions {
    paths?: PathOptions | undefined;
    /** 日志级别，默认 info。 */
    logLevel?: LogLevel | undefined;
    /** 默认写入 `logs/napuketto.log`，自动创建父目录。 */
    logFile?: string | undefined;
    /** 默认同 `logLevel`。 */
    logFileLevel?: LogLevel | undefined;
    /** 默认开启。 */
    consoleLog?: boolean | undefined;
    /** 默认在 TTY 使用 `pretty`，其余使用 `single-line`。 */
    logFormat?: LogFormat | undefined;
    /** 默认 `local`。 */
    logTimestamp?: TimestampMode | undefined;
    /** 默认仅在 TTY 使用 `pretty` 时着色。 */
    logColorize?: boolean | undefined;
    /** 写入日志的 `account` 字段。 */
    account?: string | undefined;
}

export interface CoreLoginOptions {
    /**
     * 缺省从 wrapper 同目录的 `major.node` 解析，wrapper 路径可回退到环境变量
     * `NAPUKETTO_WRAPPER_PATH`。解析失败抛 `INVALID_PARAM`。
     */
    appid?: string | undefined;
    /** 自动激活时的 `session.init` 超时（毫秒），默认 15 秒。 */
    initTimeoutMs?: number | undefined;
    /** 缺省优先选列表中首个可快速登录的账号，其次选列表首项。 */
    quickUin?: string | undefined;
    /** 单步超时（毫秒），默认 20 秒。超时按登录失败处理，原生调用无法取消。 */
    quickLoginTimeoutMs?: number | undefined;
    /** 快速登录失败时改用扫码，默认关闭。 */
    qrFallback?: boolean | undefined;
    /** 跳过快速登录，直接扫码。默认关闭。 */
    qrOnly?: boolean | undefined;
    /** 默认写入账号目录的 `cache/qr/qrcode.png`，登录结束删除。显式路径由调用方清理。 */
    qrCodePath?: string | undefined;
    /** 接收扫码流程的二维码数据和状态变化。 */
    onLoginProgress?: ((progress: LoginProgress) => void) | undefined;
    /** 登录成功后自动激活会话。默认由调用方手动激活。 */
    activateSession?: boolean | undefined;
}
