/**
 * index.ts：IPC 协议层出口（self-host 子进程侧）。
 */
export {
    callIpcAction,
    createIpcActions,
    type IpcActionHandler,
    type IpcApiContext,
    type IpcPeer,
    registerLoginRefreshAction,
} from "./ipc-actions.js";
export { attachIpcServices, createIpcActionsForCore } from "./ipc-bootstrap.js";
export { decodeIpcMessage, encodeIpcMessage } from "./ipc-codec.js";
export {
    attachOb11IpcBridge,
    type Ob11BridgeDeps,
    type Ob11BridgeEnv,
} from "./ipc-ob11.js";
export {
    enableIpc,
    lastIpcStatusPhase,
    replayStatus,
    sendEvent,
    sendLog,
    sendLogin,
    sendPing,
    sendPong,
    sendQr,
    sendResult,
    sendStatus,
    shouldSendGenericBootFailed,
} from "./ipc-sender.js";
export {
    handleControl,
    type IpcLoginControlPayload,
    type IpcServerOptions,
    startIpcServer,
} from "./ipc-server.js";
export {
    IPC_VERSION,
    type IpcActionMessage,
    type IpcActionPayload,
    type IpcBootPhase,
    type IpcControlMessage,
    type IpcControlPayload,
    type IpcEventMessage,
    type IpcEventPayload,
    type IpcLoginMessage,
    type IpcLoginPayload,
    type IpcLogLevel,
    type IpcLogMessage,
    type IpcLogPayload,
    type IpcMessage,
    type IpcPingMessage,
    type IpcPongMessage,
    type IpcQrMessage,
    type IpcResultMessage,
    type IpcResultPayload,
    type IpcStatusMessage,
    type IpcStatusPayload,
} from "./ipc-types.js";
export { toJsonSafe } from "./json-safe.js";
export { isNativeNoiseLine } from "./native-noise.js";
