/**
 * network 测试公共辅助（ws-server / ws-client 等用例共享）
 *
 * 一切网络行为收敛到 127.0.0.1 临时端口：
 * - `getFreePort`：先占坑再释放，规避固定端口的并行冲突；
 * - `waitOpen` / `waitJsonMessage` / `waitClose`：ws 连接的事件等待原语；
 * - `take`：noUncheckedIndexedAccess 下的数组元素收窄；
 * - `realDelay`：fake timers 激活前捕获的真实 setTimeout，供定时器用例
 *   在虚拟时钟推进后等待真实 I/O 落地（进/出 fake timers 成对，不污染真实 socket）。
 */
import { createServer } from "node:net";
import { WebSocket } from "ws";

/** 向系统申请一个空闲的 127.0.0.1 端口（绑定 0 读取实际端口后立即释放）。 */
export function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            if (addr === null || typeof addr === "string") {
                srv.close(() => reject(new Error("未取得临时端口")));
                return;
            }
            const { port } = addr;
            srv.close(() => resolve(port));
        });
    });
}

/** 收窄可能为 undefined 的数组元素（测试前置断言，失败即用例失败）。 */
export function take<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
        throw new Error(`测试前置失败: ${what}`);
    }
    return value;
}

/** 等待 ws 连接建立（open）；握手失败（如鉴权拒绝、路径不匹配）则 reject。 */
export function waitOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (err) => reject(err));
    });
}

/** 等待下一条 JSON 文本消息（解析后返回）。 */
export function waitJsonMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
        ws.once("message", (raw) => {
            try {
                resolve(JSON.parse(String(raw)) as unknown);
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        ws.once("error", reject);
    });
}

/** 等待连接关闭，返回 close code 与 reason（Buffer → 文本）。 */
export function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.once("error", (err) => reject(err));
    });
}

/** 建立 ws 连接并等待 open 完成。 */
export async function connectOk(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    await waitOpen(ws);
    return ws;
}

/** 真实 setTimeout 引用（模块加载期捕获，早于 fake timers 替换）。 */
const realSetTimeout: typeof setTimeout = globalThis.setTimeout;

/** 用真实时钟等待指定毫秒（fake timers 下等待真实 I/O 完成的逃生口）。 */
export function realDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        realSetTimeout(resolve, ms);
    });
}
