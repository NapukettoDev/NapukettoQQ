/**
 * index.ts：IPC 协议层出口（self-host 子进程侧）。
 */
export {
    callIpcAction,
    createIpcActions,
    type IpcActionHandler,
    type IpcActionOptions,
    type IpcApiContext,
    type IpcPeer,
    registerLoginRefreshAction,
} from "./ipc-actions.js";
export { attachIpcServices, createIpcActionsForCore } from "./ipc-bootstrap.js";
export { decodeIpcMessage, encodeIpcMessage } from "./ipc-codec.js";
export {
    DIAGNOSTIC_ACTION_NAMES,
    type IpcDiagnosticContext,
    registerDiagnosticActions,
} from "./ipc-diagnostics.js";
export {
    attachOb11IpcBridge,
    type Ob11BridgeDeps,
    type Ob11BridgeEnv,
} from "./ipc-ob11.js";
export {
    enableIpc,
    flushIpc,
    lastIpcStatusPhase,
    readReadySelf,
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
    DEFAULT_MAX_IPC_LINE_BYTES,
    DEFAULT_MAX_PENDING_REQUESTS,
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
    type IpcFriend,
    IpcFriendSchema,
    type IpcGroupRequest,
    IpcGroupRequestSchema,
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
    type IpcRespondToGroupRequestParams,
    IpcRespondToGroupRequestParamsSchema,
    type IpcResultMessage,
    type IpcResultPayload,
    IpcResultPayloadSchema,
    type IpcStatusMessage,
    type IpcStatusPayload,
    IpcStatusPayloadSchema,
    /** @deprecated 请使用 `IpcActionPayloadSchema` */
    ipcActionPayloadSchema,
    /** @deprecated 请使用 `IpcBootPhaseSchema` */
    ipcBootPhaseSchema,
    /** @deprecated 请使用 `IpcControlPayloadSchema` */
    ipcControlPayloadSchema,
    /** @deprecated 请使用 `IpcEventPayloadSchema` */
    ipcEventPayloadSchema,
    /** @deprecated 请使用 `IpcLoginPayloadSchema` */
    ipcLoginPayloadSchema,
    /** @deprecated 请使用 `IpcLogLevelSchema` */
    ipcLogLevelSchema,
    /** @deprecated 请使用 `IpcLogPayloadSchema` */
    ipcLogPayloadSchema,
    /** @deprecated 请使用 `IpcMessageSchema` */
    ipcMessageSchema,
    /** @deprecated 请使用 `IpcResultPayloadSchema` */
    ipcResultPayloadSchema,
    /** @deprecated 请使用 `IpcStatusPayloadSchema` */
    ipcStatusPayloadSchema,
} from "./ipc-types.js";
export { toJsonSafe } from "./json-safe.js";
export { isNativeNoiseLine } from "./native-noise.js";
