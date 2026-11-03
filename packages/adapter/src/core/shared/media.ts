/**
 * adapter core 媒体辅助：语音归一化（ADR-011 media 严格解耦的协议层落点）
 *
 * 协议层（onebot11 / satori）发送语音前统一走 ensureSilk：把非 silk 音频
 * 转成 QQ 语音格式（silk v3）。转码依赖 @napuketto/media（encodePcmToSilk），
 * 只发生在 adapter 层；kernel 不 import media（红线），只接收已是 silk 的路径。
 */
import { open } from "node:fs/promises";
import { encodePcmToSilk } from "@napuketto/media";

/** 读文件头 8 字节（判断 silk 魔数）。 */
async function readFileHead(path: string): Promise<string> {
    const handle = await open(path, "r");
    try {
        const buf = Buffer.alloc(8);
        await handle.read(buf, 0, 8, 0);
        return buf.toString("utf8");
    } finally {
        await handle.close();
    }
}

/**
 * 语音转码：非 silk 输入（任意音频格式，经 @napuketto/media 归一化）转 silk。
 * 已是 silk（#!SILK_V3 头）原样返回；转码失败原样返回（由 kernel 发送时兜底）。
 */
export async function ensureSilk(path: string): Promise<string> {
    try {
        const header = await readFileHead(path);
        if (header.startsWith("#!SILK")) {
            return path;
        }
        return await encodePcmToSilk(path);
    } catch {
        return path;
    }
}
