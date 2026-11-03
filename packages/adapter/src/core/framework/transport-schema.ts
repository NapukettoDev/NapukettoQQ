/**
 * 协议传输实例 schema（OB11 / Satori 共用，2026-08-08 克隆合并）
 *
 * HTTP 反向服务器 / WS 事件服务器的实例级 schema 结构两协议一致，
 * 仅默认端口与扩展字段不同——提取工厂函数，各协议按需调用。
 */
import { z } from "zod";

/** 传输实例基础 schema（enabled/host/port/token 骨架，HTTP 与 WS 共用）。 */
function createServerSchema(defaultPort: number) {
    return z.object({
        enabled: z.boolean().default(false),
        host: z.string().default("127.0.0.1"),
        port: z.number().int().default(defaultPort),
        /** 实例级 token，覆盖全局 token（缺省继承全局）。 */
        token: z.string().optional(),
    });
}

/** HTTP 反向服务器实例 schema（第三方指令入口 / HTTP RPC，OB11 / Satori 共用）。 */
export function createHttpServerSchema(defaultPort: number) {
    return createServerSchema(defaultPort);
}

/** WS 事件服务器实例 schema（反向 WS server，OB11 / Satori 共用）。 */
export function createWsServerSchema(defaultPort: number) {
    return createServerSchema(defaultPort);
}
