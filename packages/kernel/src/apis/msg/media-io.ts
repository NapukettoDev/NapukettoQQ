/**
 * 富媒体发送的文件 IO 原语：stat / md5 摘要，错误统一映射为 INVALID_PARAM（ADR-009）；
 * 摘要按流式读取避免大文件整块进内存，并校验读取期间文件大小不变。
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { kernelError } from "../../infra/index.js";

/** 读文件 stat（富媒体发送预处理；文件不存在抛 INVALID_PARAM）。 */
export async function statFile(path: string, label = "图片"): Promise<{ size: number }> {
    try {
        return await stat(path);
    } catch {
        throw kernelError(`${label}文件不存在: ${path}`, "INVALID_PARAM");
    }
}

/** 计算文件 md5（十六进制小写）。 */
export async function hashFile(path: string, label = "图片"): Promise<string> {
    try {
        const flags =
            constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
        const handle = await open(path, flags);
        try {
            const info = await handle.stat();
            if (!info.isFile()) throw new Error("摘要输入必须是普通文件");
            const hash = createHash("md5");
            const chunk = Buffer.alloc(64 * 1024);
            let remaining = info.size;
            while (remaining > 0) {
                const { bytesRead } = await handle.read(
                    chunk,
                    0,
                    Math.min(remaining, chunk.length),
                );
                if (bytesRead === 0) throw new Error("摘要读取期间文件缩短");
                hash.update(chunk.subarray(0, bytesRead));
                remaining -= bytesRead;
            }
            if ((await handle.read(chunk, 0, 1)).bytesRead !== 0) {
                throw new Error("摘要读取期间文件增长");
            }
            return hash.digest("hex");
        } finally {
            await handle.close();
        }
    } catch {
        throw kernelError(`${label}文件读取失败: ${path}`, "INVALID_PARAM");
    }
}
