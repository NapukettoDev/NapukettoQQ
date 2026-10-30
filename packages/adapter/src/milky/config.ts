/**
 * Milky 协议配置（zod schema，归属本包，ADR-012）
 *
 * 单一 TOML 的 `[accounts.milky]` 账号段（docs/protocols/milky.md §4）：
 * 单端口 HTTP 模型（/api + /event 同端口），`enabled` 缺省 false = 不启用。
 */
import { z } from "zod";

/** Milky 配置 schema。 */
export const milkyConfigSchema = z.object({
    /** 启用开关（缺省 false：账号段存在但 enabled 未开 = 装配为空转）。 */
    enabled: z.boolean().default(false),
    /** HTTP 监听地址。 */
    host: z.string().min(1).default("127.0.0.1"),
    /** HTTP 监听端口（/api 与 /event 同端口）。 */
    port: z.number().int().min(0).max(65535).default(3001),
    /** access_token（空 = 不校验，仅限内网）。 */
    token: z.string().default(""),
    /** /event 允许的连接形态（缺省两者都开）。 */
    eventModes: z.array(z.enum(["sse", "ws"])).default(["sse", "ws"]),
    /** 额外事件推送地址（WebHook，可多个；协议端在请求头发 Bearer token）。 */
    webhooks: z.array(z.string().min(1)).default([]),
    /** 发送媒体 http(s) URI 下载缓存目录（缺省不下载 = http(s) 发送媒体不可用）。 */
    cacheDir: z.string().optional(),
});

/** Milky 配置类型（由 schema 推导）。 */
export type MilkyConfig = z.infer<typeof milkyConfigSchema>;
