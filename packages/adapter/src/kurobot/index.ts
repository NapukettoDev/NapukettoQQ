/**
 * kurobot 协议适配器（KuroBot MVP-3，2026-09-13）
 * 公共面：镜像协议 schema + 配置 schema + 连接层 + 适配器。
 */

export type { KurobotAdapterOptions, KurobotMsgApi } from "./adapter.js";
export { NapukettoKurobotAdapter } from "./adapter.js";
export type { KurobotConfig } from "./config.js";
export { kurobotConfigDefaults, kurobotConfigSchema } from "./config.js";
export type {
    ConnectionEndedReason,
    KurobotConnectionOptions,
    KurobotHello,
    KurobotLogger,
    ServerEventMessage,
} from "./connection.js";
export { KurobotConnection } from "./connection.js";
export type {
    BindingsUpdatedBody,
    CommandBody,
    CommandFrame,
    CommandResultBody,
    DeathBody,
    GameChatBody,
    HelloAckBody,
    HelloBody,
    JoinBody,
    LeaveBody,
    PlatformChatBody,
    QueryResultBody,
    StatusBody,
} from "./schema.js";
export {
    bindingsUpdatedFrame,
    commandFrame,
    commandResultFrame,
    deathFrame,
    encodeFrame,
    gameChatFrame,
    helloAckFrame,
    helloFrame,
    isProtocolVersionCompatible,
    joinFrame,
    leaveFrame,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    pingFrame,
    platformChatFrame,
    pongFrame,
    queryFrame,
    queryResultFrame,
    statusFrame,
    WS_SUBPROTOCOL,
    wireFrameSchema,
} from "./schema.js";
export {
    degradeElements,
    degradeMessage,
    MAX_GROUP_TEXT_LENGTH,
    renderCommandResult,
    renderDeathText,
    renderTemplate,
    resolveSenderName,
    truncateForGroup,
} from "./translate.js";
