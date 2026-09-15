/**
 * kurobridge-ws 协议 schema（镜像实现，任务书 KUROBOT-PROMPT §1.2 决策一）
 *
 * **SSOT: KuroBridge bridge/protocol**（`C:\Dev\MC-Ecosystem\KuroAdapter\bridge\protocol\src\`），
 * 镜像基线 **0.4.x**（KuroAdapter ADR-030 品牌改名：kurobot-ws.v1 → kurobridge-ws.v1，
 * PROTOCOL_VERSION 0.4.0；帧形状与 0.3.1 逐字段一致，仅品牌字符串与版本号变更）。
 * `@kuro-bridge/protocol` 已发 npm，本仓暂维持镜像（golden 帧对表测试锁漂移：
 * connection.test.ts / schema.test.ts），将来可切换为真依赖。
 *
 * 只镜像 WS 对端可见的消息集（meta / frame / messages/ws）；IPC 侧消息
 * （ready/broadcast/execute_command 等，Java↔Node 内部通道）不镜像。
 * 帧格式：`{header: {type, id?}, body}`（单行 JSON 文本帧）；事件帧无 id，
 * 请求/响应帧 id 必填（UUID 关联）；解析后 transform 为扁平消息 `{type, id?, body}`。
 */
import { z } from "zod";

// ---- 协议元信息（镜像 meta.ts）----

export const PROTOCOL_NAME = "kurobridge-ws" as const;

/** 语义化版本（主版本相同即兼容，ADR-026：0.2.x/0.3.0 服务端均接受 0.3.1 hello）。 */
export const PROTOCOL_VERSION = "0.4.0" as const;

/** WS 子协议（握手期校验，服务端 handleProtocols 不带即拒连）。 */
export const WS_SUBPROTOCOL = "kurobridge-ws.v1" as const;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseMajor(version: string): number | null {
    const match = VERSION_PATTERN.exec(version);
    if (match === null) {
        return null;
    }
    const major = Number.parseInt(match[1] as string, 10);
    return Number.isNaN(major) ? null : major;
}

/** 协议版本兼容判定（镜像 meta.ts 同名函数）：主版本号相同即兼容。 */
export function isProtocolVersionCompatible(peerVersion: string, serverVersion: string): boolean {
    const peer = parseMajor(peerVersion);
    const server = parseMajor(serverVersion);
    return peer !== null && server !== null && peer === server;
}

// ---- 帧格式（镜像 frame.ts）----

const TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const frameHeaderSchema = z.object({
    type: z.string().regex(TYPE_PATTERN),
    id: z.uuid().optional(),
});

export type FrameHeader = z.infer<typeof frameHeaderSchema>;

/**
 * 通用线格式帧（两段式解析的第一段）：只约束帧骨架（type 受 snake_case、
 * id 存在时须 UUID、body 任意），供收帧侧「先取 type、再分发到具体 schema」。
 */
export const wireFrameSchema = z.object({
    header: frameHeaderSchema,
    body: z.unknown(),
});

export type WireFrame = z.infer<typeof wireFrameSchema>;

/** 扁平事件消息 */
export interface EventMessage<T extends string, B> {
    type: T;
    body: B;
}

/** 扁平请求/响应消息（UUID 关联） */
export interface RequestMessage<T extends string, B> {
    type: T;
    id: string;
    body: B;
}

/** 事件帧（单向通知，携带 id 即校验失败） */
export function eventFrameSchema<const T extends string, B extends z.ZodType>(type: T, body: B) {
    return z
        .object({
            header: z.strictObject({ type: z.literal(type) }),
            body,
        })
        .transform((frame) => {
            // zod v4 对泛型成员的对象输出推断不足（body 键丢失），此处用结构断言收拢
            const wire = frame as { header: { type: T }; body: z.output<B> };
            return { type: wire.header.type, body: wire.body } satisfies EventMessage<
                T,
                z.output<B>
            >;
        });
}

/** 请求/响应帧（id 必填） */
export function requestFrameSchema<const T extends string, B extends z.ZodType>(type: T, body: B) {
    return z
        .object({
            header: frameHeaderSchema.extend({ type: z.literal(type), id: z.uuid() }),
            body,
        })
        .transform((frame) => {
            const wire = frame as { header: { type: T; id: string }; body: z.output<B> };
            return {
                type: wire.header.type,
                id: wire.header.id,
                body: wire.body,
            } satisfies RequestMessage<T, z.output<B>>;
        });
}

/** 出帧：扁平消息 → 线格式 JSON 文本（单行，可直接走 WS 文本帧） */
export function encodeFrame(message: { type: string; body: unknown; id?: string }): string {
    const header: { type: string; id?: string } = { type: message.type };
    if (message.id !== undefined) {
        header.id = message.id;
    }
    return JSON.stringify({ header, body: message.body });
}

/** 请求-响应的通用结果体 */
export const resultBodySchema = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type ResultBody = z.infer<typeof resultBodySchema>;

/** 请求-响应的命令结果体（ok 分支可选 `output`：命令输出行；与 query/命令链共用）。 */
export const commandResultBodySchema = z.union([
    z.object({ ok: z.literal(true), output: z.array(z.string()).optional() }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type CommandResultBody = z.infer<typeof commandResultBodySchema>;

// ---- Peer → Server（镜像 messages/ws.ts）----

const helloBodySchema = z.object({
    peerId: z.string().min(1),
    platform: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** 鉴权 token（服务端配置非空 token 时未带/带错 → hello_ack ok:false + close 1008）。 */
    token: z.string().optional(),
    /** 对端自报身份（0.3.1，MVP-3：建议 `名称/版本`，服务端仅日志辨识）。 */
    client: z.string().optional(),
});

/** 对端注册（请求，服务端必须回同 id 的 hello_ack）。 */
export const helloFrame = requestFrameSchema("hello", helloBodySchema);
export type HelloBody = z.infer<typeof helloBodySchema>;
export type HelloFrame = z.infer<typeof helloFrame>;

const pingBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳请求（应用层帧——服务端空闲检测只认应用层入帧，WS 层 ping 无效）。 */
export const pingFrame = requestFrameSchema("ping", pingBodySchema);
export type PingBody = z.infer<typeof pingBodySchema>;
export type PingFrame = z.infer<typeof pingFrame>;

const platformChatBodySchema = z.object({
    /** 消息来源频道（QQ 群号字符串） */
    channel: z.string().min(1),
    sender: z.string().min(1),
    content: z.string().min(1),
});

/** 平台 → 游戏聊天（事件；服务端按绑定表过滤未绑定频道）。 */
export const platformChatFrame = eventFrameSchema("chat", platformChatBodySchema);
export type PlatformChatBody = z.infer<typeof platformChatBodySchema>;
export type PlatformChatFrame = z.infer<typeof platformChatFrame>;

const commandSourceSchema = z.object({
    /** 消息来源频道（QQ 群号字符串） */
    channel: z.string().min(1),
    /** 发送者 QQ 号（协议端负责从群消息提取；管理员判定在服务端） */
    userId: z.string().min(1),
});

const commandBodySchema = z.object({
    /** 待执行的命令行（不含前导斜杠，如 "whitelist list"） */
    command: z.string().min(1),
    source: commandSourceSchema,
});

/** 群指令 → 执行游戏命令（请求；响应为同 id command_result）。 */
export const commandFrame = requestFrameSchema("command", commandBodySchema);
export type CommandBody = z.infer<typeof commandBodySchema>;
export type CommandSource = z.infer<typeof commandSourceSchema>;
export type CommandFrame = z.infer<typeof commandFrame>;

const queryBodySchema = z.object({
    /** 查询类别：status = 最近一帧服务器状态快照；bindings = 当前绑定频道列表 */
    kind: z.union([z.literal("status"), z.literal("bindings")]),
});

/** 状态/绑定查询（请求；响应为同 id query_result）。 */
export const queryFrame = requestFrameSchema("query", queryBodySchema);
export type QueryBody = z.infer<typeof queryBodySchema>;
export type QueryFrame = z.infer<typeof queryFrame>;

// ---- Server → Peer（镜像 messages/ws.ts）----

const helloAckOkBodySchema = z.object({
    ok: z.literal(true),
    serverId: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** 服务端绑定表快照（空数组合法 = 全部不发）。 */
    channelBindings: z.array(z.string().min(1)),
});

const helloAckErrorBodySchema = z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
});

/** 握手结果（响应，同 id）。 */
export const helloAckFrame = z.union([
    requestFrameSchema("hello_ack", helloAckOkBodySchema),
    requestFrameSchema("hello_ack", helloAckErrorBodySchema),
]);
export type HelloAckOkBody = z.infer<typeof helloAckOkBodySchema>;
export type HelloAckErrorBody = z.infer<typeof helloAckErrorBodySchema>;
export type HelloAckBody = HelloAckOkBody | HelloAckErrorBody;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;

const pongBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳响应（不需要处理：收不到就等服务端 1001 关闭走重连）。 */
export const pongFrame = requestFrameSchema("pong", pongBodySchema);
export type PongBody = z.infer<typeof pongBodySchema>;
export type PongFrame = z.infer<typeof pongFrame>;

const gameChatBodySchema = z.object({
    /** 目标频道（服务端按绑定表逐频道 fan-out，每频道一帧） */
    channel: z.string().min(1),
    playerName: z.string().min(1),
    content: z.string().min(1),
});

/** 游戏 → 平台聊天（事件）。 */
export const gameChatFrame = eventFrameSchema("chat", gameChatBodySchema);
export type GameChatBody = z.infer<typeof gameChatBodySchema>;
export type GameChatFrame = z.infer<typeof gameChatFrame>;

const joinBodySchema = z.object({
    channel: z.string().min(1),
    playerName: z.string().min(1),
});

/** 玩家进服（事件，按绑定频道 fan-out）。 */
export const joinFrame = eventFrameSchema("join", joinBodySchema);
export type JoinBody = z.infer<typeof joinBodySchema>;
export type JoinFrame = z.infer<typeof joinFrame>;

const leaveBodySchema = z.object({
    channel: z.string().min(1),
    playerName: z.string().min(1),
});

/** 玩家退服（事件，按绑定频道 fan-out）。 */
export const leaveFrame = eventFrameSchema("leave", leaveBodySchema);
export type LeaveBody = z.infer<typeof leaveBodySchema>;
export type LeaveFrame = z.infer<typeof leaveFrame>;

const statusBodySchema = z.object({
    /** 1 分钟 TPS 均值（Paper getTPS()[0]） */
    tps: z.number().nonnegative(),
    onlinePlayers: z.number().int().nonnegative(),
    uptimeSeconds: z.number().int().nonnegative(),
});

/** 服务器状态（事件；无 channel——全服状态而非频道消息）。 */
export const statusFrame = eventFrameSchema("status", statusBodySchema);
export type StatusBody = z.infer<typeof statusBodySchema>;
export type StatusFrame = z.infer<typeof statusFrame>;

const bindingsUpdatedBodySchema = z.object({
    /** 变更后的完整绑定列表（非增量；空数组合法 = 全部不发）。 */
    channelBindings: z.array(z.string().min(1)),
});

/** 绑定表变更推送（事件）。 */
export const bindingsUpdatedFrame = eventFrameSchema("bindings_updated", bindingsUpdatedBodySchema);
export type BindingsUpdatedBody = z.infer<typeof bindingsUpdatedBodySchema>;
export type BindingsUpdatedFrame = z.infer<typeof bindingsUpdatedFrame>;

/** 群指令的执行结果（响应，同 id）。 */
export const commandResultFrame = requestFrameSchema("command_result", commandResultBodySchema);
export type CommandResultFrame = z.infer<typeof commandResultFrame>;

const queryResultBodySchema = z.union([
    z.object({
        ok: z.literal(true),
        /** data 形状由请求 kind 决定：status → StatusBody 同构；bindings → string[]。 */
        data: z.unknown(),
    }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

/** 查询结果（响应，同 id）。 */
export const queryResultFrame = requestFrameSchema("query_result", queryResultBodySchema);
export type QueryResultBody = z.infer<typeof queryResultBodySchema>;
export type QueryResultFrame = z.infer<typeof queryResultFrame>;

const deathBodySchema = z.object({
    /** 目标频道（服务端按绑定表逐频道 fan-out，每频道一帧） */
    channel: z.string().min(1),
    /** 死亡玩家名（SSOT 原文命名 `player`——与 join/leave 的 playerName 不一致，照抄不「修正」） */
    player: z.string().min(1),
    /** 死亡消息文本（Bukkit deathMessage 可为 null → 服务端以空串兜底，故允许空串） */
    message: z.string(),
});

/** 玩家死亡（事件，按绑定频道 fan-out 对齐 join/leave）。 */
export const deathFrame = eventFrameSchema("death", deathBodySchema);
export type DeathBody = z.infer<typeof deathBodySchema>;
export type DeathFrame = z.infer<typeof deathFrame>;

/** 服务端 → 对端已知帧 type 清单（收帧分发用；不在表内走未知帧容忍）。 */
export const SERVER_TO_PEER_TYPES: readonly string[] = [
    "hello_ack",
    "pong",
    "chat",
    "join",
    "leave",
    "death",
    "status",
    "bindings_updated",
    "command_result",
    "query_result",
];
