/**
 * 协议传输实例 schema（OB11 / Satori 共用）
 *
 * HTTP 反向服务器 / WS 事件服务器的实例级 schema 结构两协议一致，仅默认
 * 端口与各协议扩展字段不同——单一工厂按默认端口生成，各协议按需调用。
 */
import { isIP } from "node:net";
import { z } from "zod";

const PLACEHOLDER_TOKENS = new Set(["change-me", "changeme", "replace_with_random_token"]);
const MAPPED_IPV4_LOOPBACK = /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/;

/** 只信任可在校验时确认的回环 IP。主机名的最终绑定由运行环境解析。 */
function isLoopbackHost(host: string): boolean {
    const family = isIP(host);
    if (family === 4) return host.startsWith("127.");
    if (family !== 6 || host.includes("%")) return false;
    const { hostname } = new URL(`http://[${host}]`);
    return hostname === "[::1]" || MAPPED_IPV4_LOOPBACK.test(hostname);
}

export function validateListenerToken(
    host: string,
    token: string | undefined,
    ctx: z.RefinementCtx,
    path: (string | number)[],
): void {
    if (isLoopbackHost(host)) return;
    const value = token?.trim().toLowerCase();
    if (!value || PLACEHOLDER_TOKENS.has(value)) {
        ctx.addIssue({
            code: "custom",
            path,
            message:
                "非回环监听要求有效 token。请设置随机 token（实例可继承协议级 token），或仅供可信本机使用时改绑 127.0.0.1 / ::1。",
        });
    }
}

interface ServerConfig {
    enabled: boolean;
    host: string;
    token?: string | undefined;
}

/** 对启用的实例使用与装配相同的 token 覆盖规则。 */
export function validateServerTokens(
    config: {
        token?: string | undefined;
        httpServers: ServerConfig[];
        wsServers: ServerConfig[];
    },
    ctx: z.RefinementCtx,
): void {
    for (const key of ["httpServers", "wsServers"] as const) {
        for (const [index, item] of config[key].entries()) {
            if (item.enabled) {
                validateListenerToken(item.host, item.token ?? config.token, ctx, [
                    key,
                    index,
                    "token",
                ]);
            }
        }
    }
}

/**
 * 传输实例 schema（enabled/host/port/token 骨架；HTTP 反向服务器与 WS 事件
 * 服务器共用同一结构，OB11 / Satori 仅默认端口不同）。
 */
export function createServerSchema(defaultPort: number) {
    return z.object({
        enabled: z.boolean().default(false),
        host: z.string().default("127.0.0.1"),
        port: z.number().int().default(defaultPort),
        /** 实例级 token，覆盖全局 token（缺省继承全局）。 */
        token: z.string().optional(),
    });
}
