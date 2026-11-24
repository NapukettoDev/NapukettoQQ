import { kernelError } from "../errors.js";

/** 结构化字段名策略；统一小写匹配，新增凭据字段只需扩展此集合。 */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
    "token",
    "access_token",
    "authorization",
    "cookie",
    "cookies",
    "set-cookie",
    "password",
    "secret",
    "ticket",
    "clientkey",
    "skey",
    "p_skey",
    "csrf_token",
    "bkn",
    "qrcodeurl",
    "qr_code_url",
    "qrcode_url",
]);

/** 只遍历刚解析的 JSON 树；不会触碰业务对象、getter、toJSON 或循环引用。 */
function redactFields(record: unknown): void {
    const pending = [record];
    while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value !== "object" || value === null) {
            continue;
        }
        // JSON.parse 只会产生对象和数组；数组的数字键也按相同规则遍历。
        for (const [key, child] of Object.entries(value)) {
            if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
                Object.defineProperty(value, key, {
                    value: "[Redacted]",
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            } else if (typeof child === "object" && child !== null) {
                pending.push(child);
            }
        }
    }
}

/**
 * pino streamWrite 钩子接收完整 JSON 行；在所有目的地之前保护最终序列化结构。
 * 不解析字符串中的 JSON / URL / 自由文本。失败时不回退输出原始记录。
 */
export function redactLogLine(chunk: string): string {
    try {
        const record: unknown = JSON.parse(chunk);
        redactFields(record);
        return `${JSON.stringify(record)}\n`;
    } catch {
        // JSON.parse 的异常可能带原文；不能将它作为 cause 交回日志链。
        throw kernelError("日志结构化脱敏失败", "INVALID_STATE");
    }
}
