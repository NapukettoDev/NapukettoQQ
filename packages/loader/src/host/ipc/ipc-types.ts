/**
 * ipc-types.ts：IPC 协议消息（koishi 插件 ↔ self-host 子进程，单一来源）。
 *
 * 协议契约（koishi 插件 design.md §5.6）：`{ v, type, id?, payload }` JSON 行。
 * 用 zod v4 定义单一 schema，两侧（loader host + koishi 插件）import 同一份：
 * 类型经 z.infer 派生、运行时经 safeParse 校验，消除「两份手写 types.ts」漂移。
 *
 * 命名（2026-11 统一）：Schema 变量一律 `camelCase` + `Schema` 结尾；对外已发布的
 * `Ipc*Schema` 在文件底部保留 alias re-export（公开导出契约零破坏）。
 */
import { z } from "zod";

/** IPC 协议版本（解码校验）。 */
export const IPC_VERSION = 1;

/** 引导阶段（status 消息）。 */
const ipcBootPhaseSchema = z.enum([
    "booting", // 子进程已启动（spawn 成功）
    "dlopening", // dlopen wrapper.node
    "logging", // 登录流程进行中
    "sessioning", // session 初始化中
    "ready", // session READY + 业务 service 装配完成
    "failed", // 引导失败（携带错误）
]);

/** 结构化日志级别（pino level）。 */
const ipcLogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

/** 登录状态（与 kernel LoginState 结构等价）。 */
const loginStateSchema = z.enum(["idle", "waiting_scan", "scanned", "logged_in", "failed"]);

/** selfInfo（与 kernel SelfInfo 结构等价）。 */
const selfInfoSchema = z.object({
    uin: z.string(),
    uid: z.string(),
    nick: z.string(),
});

/** status 消息 payload。 */
const ipcStatusPayloadSchema = z.object({
    phase: ipcBootPhaseSchema,
    message: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
});

/** login 消息 payload。 */
const ipcLoginPayloadSchema = z.object({
    state: loginStateSchema,
    selfInfo: selfInfoSchema.optional(),
    /** 失败原因（state=failed 时；如「登录超时，请刷新页面重试」）。 */
    message: z.string().optional(),
});

/** event 消息 payload（kernel 事件通道形状，翻译层按 service/name 断言具体类型）。 */
const ipcEventPayloadSchema = z.object({
    service: z.string(),
    name: z.string(),
    args: z.array(z.unknown()),
});

/** log 消息 payload。 */
const ipcLogPayloadSchema = z.object({
    level: ipcLogLevelSchema,
    message: z.string(),
});

/** 动作响应 payload（result 消息）。 */
const ipcResultPayloadSchema = z.union([
    z.object({ ok: z.literal(true), value: z.unknown().optional() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/** 动作请求 payload（action 消息）。 */
const ipcActionPayloadSchema = z.object({
    action: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
});

/** 控制指令 payload（control 消息，父→子）。 */
const ipcControlPayloadSchema = z.union([
    z.object({ command: z.literal("stop") }), // 优雅退出
    z.object({ command: z.literal("restart") }), // 退出并期望驱动层重启
    z.object({
        command: z.literal("login"),
        uin: z.string().optional(),
        qr: z.boolean().optional(),
    }), // 触发登录（uin 指定账号 / qr=true 强制扫码；登录期成功结果抢占初始登录竞速，2026-09-08）
    z.object({ command: z.literal("status") }), // 状态查询：重播最近一条 status（丢失重同步，2026-09-06）
]);

// ── 消息联合 ──

const ipcStatusMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("status"),
    payload: ipcStatusPayloadSchema,
});

const ipcLoginMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("login"),
    payload: ipcLoginPayloadSchema,
});

const ipcQrMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("qr"),
    payload: z.object({ pngBase64: z.string(), qrcodeUrl: z.string() }),
});

const ipcEventMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("event"),
    payload: ipcEventPayloadSchema,
});

const ipcResultMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("result"),
    id: z.number(),
    payload: ipcResultPayloadSchema,
});

const ipcLogMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("log"),
    payload: ipcLogPayloadSchema,
});

const ipcPingMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("ping"),
});

const ipcPongMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("pong"),
});

const ipcActionMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("action"),
    id: z.number(),
    payload: ipcActionPayloadSchema,
});

const ipcControlMessageSchema = z.object({
    v: z.literal(IPC_VERSION),
    type: z.literal("control"),
    payload: ipcControlPayloadSchema,
});

/** IPC 消息判别联合（协议边界，运行时经 safeParse 校验）。 */
const ipcMessageSchema = z.discriminatedUnion("type", [
    ipcStatusMessageSchema,
    ipcLoginMessageSchema,
    ipcQrMessageSchema,
    ipcEventMessageSchema,
    ipcResultMessageSchema,
    ipcLogMessageSchema,
    ipcPingMessageSchema,
    ipcPongMessageSchema,
    ipcActionMessageSchema,
    ipcControlMessageSchema,
]);

// ── 派生类型（z.infer，两侧消费同名类型，无镜像漂移） ──

export type IpcBootPhase = z.infer<typeof ipcBootPhaseSchema>;
export type IpcLogLevel = z.infer<typeof ipcLogLevelSchema>;
export type IpcStatusPayload = z.infer<typeof ipcStatusPayloadSchema>;
export type IpcLoginPayload = z.infer<typeof ipcLoginPayloadSchema>;
export type IpcEventPayload = z.infer<typeof ipcEventPayloadSchema>;
export type IpcLogPayload = z.infer<typeof ipcLogPayloadSchema>;
export type IpcResultPayload = z.infer<typeof ipcResultPayloadSchema>;
export type IpcActionPayload = z.infer<typeof ipcActionPayloadSchema>;
export type IpcControlPayload = z.infer<typeof ipcControlPayloadSchema>;
export type IpcStatusMessage = z.infer<typeof ipcStatusMessageSchema>;
export type IpcLoginMessage = z.infer<typeof ipcLoginMessageSchema>;
export type IpcQrMessage = z.infer<typeof ipcQrMessageSchema>;
export type IpcEventMessage = z.infer<typeof ipcEventMessageSchema>;
export type IpcResultMessage = z.infer<typeof ipcResultMessageSchema>;
export type IpcLogMessage = z.infer<typeof ipcLogMessageSchema>;
export type IpcPingMessage = z.infer<typeof ipcPingMessageSchema>;
export type IpcPongMessage = z.infer<typeof ipcPongMessageSchema>;
export type IpcActionMessage = z.infer<typeof ipcActionMessageSchema>;
export type IpcControlMessage = z.infer<typeof ipcControlMessageSchema>;
export type IpcMessage = z.infer<typeof ipcMessageSchema>;

// ── 公开导出兼容 alias（2026-11 命名统一前已发布，禁止删除） ──

export {
    ipcActionPayloadSchema as IpcActionPayloadSchema,
    /** @deprecated 请使用 `IpcActionPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcActionPayloadSchema,
    ipcBootPhaseSchema as IpcBootPhaseSchema,
    /** @deprecated 请使用 `IpcBootPhaseSchema`（保留以兼容外部 Koishi 插件） */
    ipcBootPhaseSchema,
    ipcControlPayloadSchema as IpcControlPayloadSchema,
    /** @deprecated 请使用 `IpcControlPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcControlPayloadSchema,
    ipcEventPayloadSchema as IpcEventPayloadSchema,
    /** @deprecated 请使用 `IpcEventPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcEventPayloadSchema,
    ipcLoginPayloadSchema as IpcLoginPayloadSchema,
    /** @deprecated 请使用 `IpcLoginPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcLoginPayloadSchema,
    ipcLogLevelSchema as IpcLogLevelSchema,
    /** @deprecated 请使用 `IpcLogLevelSchema`（保留以兼容外部 Koishi 插件） */
    ipcLogLevelSchema,
    ipcLogPayloadSchema as IpcLogPayloadSchema,
    /** @deprecated 请使用 `IpcLogPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcLogPayloadSchema,
    ipcMessageSchema as IpcMessageSchema,
    /** @deprecated 请使用 `IpcMessageSchema`（保留以兼容外部 Koishi 插件） */
    ipcMessageSchema,
    ipcResultPayloadSchema as IpcResultPayloadSchema,
    /** @deprecated 请使用 `IpcResultPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcResultPayloadSchema,
    ipcStatusPayloadSchema as IpcStatusPayloadSchema,
    /** @deprecated 请使用 `IpcStatusPayloadSchema`（保留以兼容外部 Koishi 插件） */
    ipcStatusPayloadSchema,
};
