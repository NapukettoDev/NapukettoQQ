/**
 * 协议传输实例 schema（OB11 / Satori 共用）
 *
 * HTTP 反向服务器 / WS 事件服务器的实例级 schema 结构两协议一致，仅默认
 * 端口与各协议扩展字段不同——单一工厂按默认端口生成，各协议按需调用。
 */
import { z } from "zod";

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
