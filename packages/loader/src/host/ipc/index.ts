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
    IpcActionPayloadSchema,
    type IpcBootPhase,
    IpcBootPhaseSchema,
    type IpcControlMessage,
    type IpcControlPayload,
    IpcControlPayloadSchema,
    type IpcEventMessage,
    type IpcEventPayload,
    IpcEventPayloadSchema,
    type IpcLoginMessage,
    type IpcLoginPayload,
    IpcLoginPayloadSchema,
    type IpcLogLevel,
    IpcLogLevelSchema,
    type IpcLogMessage,
    type IpcLogPayload,
    IpcLogPayloadSchema,
    type IpcMessage,
    IpcMessageSchema,
    type IpcPingMessage,
    type IpcPongMessage,
    type IpcQrMessage,
    type IpcResultMessage,
    type IpcResultPayload,
    IpcResultPayloadSchema,
    type IpcStatusMessage,
    type IpcStatusPayload,
    IpcStatusPayloadSchema,
    ipcActionPayloadSchema,
    ipcBootPhaseSchema,
    ipcControlPayloadSchema,
    ipcEventPayloadSchema,
    ipcLoginPayloadSchema,
    ipcLogLevelSchema,
    ipcLogPayloadSchema,
    ipcMessageSchema,
    ipcResultPayloadSchema,
    ipcStatusPayloadSchema,
} from "./ipc-types.js";
export { toJsonSafe } from "./json-safe.js";
export { isNativeNoiseLine } from "./native-noise.js";
