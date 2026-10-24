/**
 * ipc-codec.ts：IPC 消息编解码（JSON 行协议，与 koishi 插件侧 src/ipc/codec.ts 对齐）。
 *
 * 每行一条 JSON 消息，`\n` 结尾。解码用 IpcMessageSchema.safeParse 校验：
 * 非法行 / 空行 / v 不匹配 / type 未知 / payload 形状非法 → null，调用方忽略，
 * 不崩通道。
 */
import { type IpcMessage, IpcMessageSchema } from "./ipc-types.js";
import { toJsonSafe } from "./json-safe.js";

/** 编码为 JSON 行（追加换行）。Map/Set 先规整为可序列化形态（见 json-safe.ts）。 */
export function encodeIpcMessage(message: IpcMessage): string {
    return `${JSON.stringify(toJsonSafe(message))}\n`;
}

/** 解码一行 JSON；非法行/空行/形状不合法返回 null。 */
export function decodeIpcMessage(line: string): IpcMessage | null {
    const trimmed = line.trim();
    if (trimmed === "") {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        const result = IpcMessageSchema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}
