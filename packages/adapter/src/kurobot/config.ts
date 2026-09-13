/**
 * kurobot 协议配置（zod schema，归属本包，ADR-012；任务书 KUROBOT-PROMPT §1.2）
 *
 * 单一 TOML 的 `[accounts.kurobot]` 账号段（段存在即启用、不写不启用），
 * seed 注入对齐 onebot11/satori 的 ConfigBase 模式。
 */
import { z } from "zod";

/** 群消息渲染模板占位符（MVP 纯文本：{player} / {content} / {message}）。 */
export const TEMPLATE_PLACEHOLDERS = ["player", "content", "message"] as const;

/** kurobot 配置 schema。 */
export const kurobotConfigSchema = z.object({
    /** KuroBot 服务端完整地址（必填，ws:// 或 wss://）。 */
    url: z.url().refine((u) => u.startsWith("ws://") || u.startsWith("wss://"), {
        message: "url 必须是 ws:// 或 wss:// 地址",
    }),
    /** 鉴权 token（缺省空 = 不带；服务端配置了非空 token 则必须一致，否则 close 1008）。 */
    token: z.string().default(""),
    /** 自报身份（缺省 napukettoqq，能取到 adapter 包版本则 napukettoqq/<版本>）。 */
    client: z.string().min(1).optional(),
    /** 群命令前缀（前缀开头 → command 帧，不再作为 chat 发送）。 */
    commandPrefix: z.string().min(1).default("/"),
    /** 应用层心跳间隔毫秒（服务端空闲阈值 30s，任何入帧重置；须显著小于 30000）。 */
    pingIntervalMs: z.number().int().positive().default(15000),
    /** MC 聊天渲染模板。 */
    chatTemplate: z.string().min(1).default("[{player}] {content}"),
    /** 玩家进服渲染模板。 */
    joinTemplate: z.string().min(1).default("{player} 加入了服务器"),
    /** 玩家退服渲染模板。 */
    leaveTemplate: z.string().min(1).default("{player} 离开了服务器"),
    /** 玩家死亡渲染模板（message 为空串时以「死亡了」代入）。 */
    deathTemplate: z.string().min(1).default("{player} {message}"),
});

/** kurobot 配置类型（由 schema 推导）。 */
export type KurobotConfig = z.infer<typeof kurobotConfigSchema>;

/**
 * ConfigBase 必填的 defaults 形参兜底值（url 必填 → 无法 `parse({})`）。
 * 装配走 seed 模式（段存在才装配，seed 已校验），defaults 不参与生效值；
 * 仅在「无 seed 且配置文件缺失」的直连场景被落盘——端口 0 地址连接会失败退避，
 * 不会静默假在线。
 */
export function kurobotConfigDefaults(): KurobotConfig {
    return kurobotConfigSchema.parse({ url: "ws://127.0.0.1:0" });
}
