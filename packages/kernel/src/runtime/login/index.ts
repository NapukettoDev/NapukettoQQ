/**
 * kernel 登录域公共出口
 *
 * 登录生命周期（lifecycle / msf-connection / quick-login）+ 扫码登录器（login / qr-flow）。
 * wait.ts 为域内私有工具，不对外暴露。
 */
export type { LoginAccountInfo, LoginResult, QuickLoginOptions } from "./lifecycle.js";
export {
    initAndStartSession,
    listLoginAccounts,
    quickLogin,
    waitForNetworkConnection,
    waitSessionReady,
} from "./lifecycle.js";
export type { LoginListItem, LoginState, QrCodeData, SelfInfo } from "./login.js";
export { QrLoginSession } from "./login.js";
