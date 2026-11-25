/**
 * 子进程输出逐行切分（boot / supervisor 共用）：不用 `readline.createInterface` 是因为它对
 * 「无换行符的超大输出」没有缓冲上限（原生层 wrapper.node 刷屏会把整块数据积在内存里）。
 * 这里用 StringDecoder 拼多字节、`\r\n` 归一，并给单行缓冲设上限，超出部分丢弃并标记截断。
 */
import { StringDecoder } from "node:string_decoder";

/** 单行缓冲上限（字符，UTF-16 code unit）：64 KiB 对正常日志行足够宽松，异常无换行输出在此截断。 */
export const MAX_LINE_LENGTH = 64 * 1024;

/** 截断行尾标记（保留 grep 可见性，避免静默丢数据）。 */
const TRUNCATED_SUFFIX = "…[truncated]";

/**
 * 监听 input 的 data/end，按换行切分后逐行回调（不含换行符，末行无换行也会回调）。
 * @param input 子进程 stdout/stderr（可读流）
 * @param onLine 行回调（空行也回调，与 readline 行为一致）
 * @param maxLineLength 单行缓冲上限（字符），超出部分丢弃并标记截断
 * @returns 解绑函数（流结束后无需调用；需要提前停止转发时用）
 */
export function forwardLines(
    input: NodeJS.ReadableStream,
    onLine: (line: string) => void,
    maxLineLength: number = MAX_LINE_LENGTH,
): () => void {
    const decoder = new StringDecoder("utf8");
    let partial = "";
    let discarding = false;

    /** 当前行结束：输出（截断行补标记）并清空缓冲。 */
    const flushLine = (): void => {
        const line = partial.endsWith("\r") ? partial.slice(0, -1) : partial;
        partial = "";
        if (discarding) {
            discarding = false;
            onLine(`${line}${TRUNCATED_SUFFIX}`);
            return;
        }
        onLine(line);
    };

    /** 消费一段已解码文本：按 \n 切分，未完结部分留在 partial。 */
    const consume = (text: string): void => {
        let cursor = 0;
        while (cursor < text.length) {
            const newline = text.indexOf("\n", cursor);
            const end = newline === -1 ? text.length : newline;
            if (!discarding) {
                const segment = text.slice(cursor, end);
                const remaining = maxLineLength - partial.length;
                if (segment.length <= remaining) {
                    partial += segment;
                } else {
                    partial += segment.slice(0, Math.max(remaining, 0));
                    discarding = true;
                }
            }
            if (newline === -1) {
                return;
            }
            flushLine();
            cursor = newline + 1;
        }
    };

    const onData = (chunk: Buffer | string): void => {
        consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
    };
    const onEnd = (): void => {
        // 冲刷解码器里残留的半个多字节字符；无换行的末行也要转发。
        consume(decoder.end());
        if (partial !== "" || discarding) {
            flushLine();
        }
    };

    input.on("data", onData);
    input.on("end", onEnd);
    return () => {
        input.off("data", onData);
        input.off("end", onEnd);
    };
}
