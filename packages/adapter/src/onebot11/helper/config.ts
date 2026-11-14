/**
 * OneBot 11 协议配置（zod schema，归属本包）
 * 协议配置 schema 在各自协议包，kernel 只提供 ConfigBase 基类。
 *
 * 多实例化：对齐 NapCat——httpServers / httpPostUrls / wsServers /
 * wsReverseUrls 四个数组实例（每实例可覆盖全局 token）；旧单对象字段 http/httpPost/ws/
 * wsReverse 废弃（zod strip 静默忽略，不兼容迁移）。
 */
import { z } from "zod";
import { createServerSchema } from "../../core/framework/transport-schema.js";

/** HTTP 反向服务器默认端口。 */
const DEFAULT_HTTP_PORT = 3000;
/** 反向 WS server 默认端口。 */
const DEFAULT_WS_PORT = 3001;
/** 心跳 meta 事件默认间隔（毫秒）。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 3000;
/** WS 传输 ping 默认间隔（毫秒）。 */
const DEFAULT_WS_HEARTBEAT_MS = 30_000;
/** WS 反向断线重连默认延迟（毫秒）。 */
const DEFAULT_RECONNECT_DELAY_MS = 5000;

/** 消息内容格式（NapCat messagePostFormat）。 */
const MESSAGE_FORMATS = ["array", "string"] as const;

/** HTTP 反向服务器实例（第三方 POST 指令入口）。 */
const httpServerSchema = createServerSchema(DEFAULT_HTTP_PORT);

/** HTTP 正向上报实例（Webhook 事件推送）。 */
const httpPostSchema = z.object({
    enabled: z.boolean().default(false),
    url: z.string().optional(),
    /** 实例级 token，覆盖全局 token（缺省继承全局）。 */
    token: z.string().optional(),
    /** 上报超时（毫秒），缺省不超时。 */
    timeoutMs: z.number().int().optional(),
});

/** 反向 WS server 实例（第三方 WS 连入，带 WS ping 间隔扩展字段）。 */
const wsServerSchema = createServerSchema(DEFAULT_WS_PORT).extend({
    /** WS ping 间隔（毫秒）。 */
    heartbeatInterval: z.number().int().default(DEFAULT_WS_HEARTBEAT_MS),
});

/** 正向 WS client 实例（主动连接第三方，双向）。 */
const wsReverseSchema = z.object({
    enabled: z.boolean().default(false),
    url: z.string().optional(),
    /** 实例级 token，覆盖全局 token（缺省继承全局）。 */
    token: z.string().optional(),
    /** 断线重连延迟（毫秒）。 */
    reconnectDelayMs: z.number().int().default(DEFAULT_RECONNECT_DELAY_MS),
    /** 最大重连次数（缺省无限）。 */
    maxReconnectAttempts: z.number().int().optional(),
    /** wss:// 是否校验证书（自签证书场景设 false，对齐 NapCat enableSelfSigned）。 */
    rejectUnauthorized: z.boolean().default(true),
    /** WS ping 间隔（毫秒）。 */
    heartbeatInterval: z.number().int().default(DEFAULT_WS_HEARTBEAT_MS),
});

/** OB11 配置 schema。 */
export const ob11ConfigSchema = z.object({
    /** 鉴权 token（全局默认，实例未指定时继承）。 */
    token: z.string().optional(),
    /** 心跳 meta 事件间隔（毫秒），0 关闭心跳。 */
    heartbeatInterval: z.number().int().default(DEFAULT_HEARTBEAT_INTERVAL_MS),
    /** 是否上报机器人自己发的消息（缺省 false = OB11 规范行为）。 */
    reportSelfMessage: z.boolean().default(false),
    /** 消息内容格式：array = 消息段数组（标准），string = CQ 码字符串。 */
    messagePostFormat: z.enum(MESSAGE_FORMATS).default("array"),
    /**
     * 群文件报形式（）：false（缺省）= message 事件 + file 段
     * （go-cqhttp 兼容;此前 file 元素被静默丢弃,本版本起透出）；true = 含
     * fileElement 的群消息改报 group_upload notice 事件（替代 message 事件）。
     */
    groupUploadAsNotice: z.boolean().default(false),
    /** HTTP 反向服务器列表。 */
    httpServers: z.array(httpServerSchema).default([]),
    /** HTTP 正向上报列表。 */
    httpPostUrls: z.array(httpPostSchema).default([]),
    /** 反向 WS server 列表。 */
    wsServers: z.array(wsServerSchema).default([]),
    /** 正向 WS client 列表。 */
    wsReverseUrls: z.array(wsReverseSchema).default([]),
});

/** OB11 配置类型（由 schema 推导）。 */
export type OB11Config = z.infer<typeof ob11ConfigSchema>;
