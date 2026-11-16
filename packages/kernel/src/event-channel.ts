/**
 * 类型化事件通道（ADR-003）
 *
 * - 事件名约定 `${Service}/${method}`（如 "Msg/onRecvMsg"），签名从 Listener 接口编译期推导
 * - 事件名写错 → 编译期报错（类型推导）
 * - `on` 返回 unsubscribe；`waitFor` 注册临时监听 → filter → 超时自动清理（替代魔法字符串方案）
 * - error 兜底：监听器抛异常不打断派发，统一经 `onError` 通知
 *
 * 组合实现而非 extends EventEmitter：EventEmitter.on 返回 `this`，与设计要求的
 * 返回 unsubscribe 冲突；组合更干净，且内核无全局单例（ADR-015 推论）。
 *
 * 类型推导说明：不直接 `ListenerEvents<L, Name>[E]` 索引（泛型下会扩宽到
 * string|number|symbol 索引，索引出 unknown），而是用 Extract 按事件名从
 * `{ name, fn }` 联合精确提取 handler / 参数类型，保证实例化后签名精确。
 */
import { EventEmitter } from "node:events";
import { kernelError } from "./infra/index.js";

/** waitFor 默认超时（毫秒）。 */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** Listener 接口形状（宽约束；精确签名由实例化时的具体接口保证）。 */
type ListenerShape = Record<string, unknown>;

/** 事件名：`${Service}/${method}`。 */
type EventName<L extends ListenerShape, Name extends string> = `${Name}/${keyof L & string}`;

/** 按事件名从 Listener 精确提取 handler 类型（条件类型 infer，泛型安全）。 */
type EventHandler<
    L extends ListenerShape,
    Name extends string,
    E extends EventName<L, Name>,
> = Extract<
    {
        [K in keyof L]: L[K] extends (...args: infer A) => infer R
            ? { name: `${Name}/${K & string}`; fn: (...args: A) => R }
            : never;
    }[keyof L],
    { name: E }
>["fn"];

/** 按事件名从 Listener 精确提取参数类型。 */
type EventArgs<
    L extends ListenerShape,
    Name extends string,
    E extends EventName<L, Name>,
> = Extract<
    {
        [K in keyof L]: L[K] extends (...args: infer A) => unknown
            ? { name: `${Name}/${K & string}`; args: A }
            : never;
    }[keyof L],
    { name: E }
>["args"];

/** 从 Listener 接口推导事件映射（文档/调试用）：`{ "Msg/onRecvMsg": fn }`。 */
export type ListenerEvents<L extends ListenerShape, Name extends string> = {
    [K in keyof L as `${Name}/${K & string}`]: L[K];
};

/**
 * 类型化事件通道。
 *
 * @typeParam L - Listener 接口（探测产物，如 MsgListener）
 * @typeParam Name - Service 名（事件名前缀，如 "Msg"）
 */
export class NTEventChannel<L extends ListenerShape, Name extends string> {
    readonly serviceName: Name;

    private readonly emitter = new EventEmitter();
    private readonly errorHandlers = new Set<(err: unknown) => void>();
    private readonly anyHandlers = new Set<(event: string, ...args: unknown[]) => void>();

    constructor(serviceName: Name) {
        this.serviceName = serviceName;
        // 单个 Service 多订阅者（缓存维护 + 协议翻译），关闭默认 10 个监听器上限
        this.emitter.setMaxListeners(0);
    }

    /**
     * 订阅事件：返回 unsubscribe（只注销该 handler，不影响其他订阅者）。
     * 每个 Service 只注册一次原生监听，缓存维护与协议翻译都订阅这里。
     */
    on<E extends EventName<L, Name>>(event: E, handler: EventHandler<L, Name, E>): () => void {
        this.emitter.addListener(event as string, handler as (...args: unknown[]) => void);
        return () => {
            this.emitter.removeListener(event as string, handler as (...args: unknown[]) => void);
        };
    }

    /**
     * 请求-响应桥：注册临时监听 → filter 命中 → resolve；超时自动清理并 reject。
     * 替代魔法字符串事件名方案。
     */
    waitFor<E extends EventName<L, Name>>(
        event: E,
        opts: {
            filter?: (...args: EventArgs<L, Name, E>) => boolean;
            timeout?: number;
        } = {},
    ): Promise<EventArgs<L, Name, E>> {
        const timeoutMs = opts.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const handler = (...args: EventArgs<L, Name, E>) => {
                if (opts.filter && !opts.filter(...args)) {
                    return; // 不匹配：保持监听，等待下一条
                }
                cleanup();
                resolve(args);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(kernelError(`等待事件超时: ${event as string}`, "TIMEOUT"));
            }, timeoutMs);
            const cleanup = (): void => {
                clearTimeout(timer);
                this.emitter.removeListener(
                    event as string,
                    handler as (...args: unknown[]) => void,
                );
            };
            this.emitter.addListener(event as string, handler as (...args: unknown[]) => void);
        });
    }

    /**
     * 类型化派发：wrapper-loader 的原生回调经此推入通道。
     * 2026-08-07 修复：原生 EventEmitter.emit 中一个 listener 抛异常会中断后续
     * listener 派发（Node 语义）——改为快照数组逐个 try/catch，保证「单个订阅者
     * 异常不打断派发」（协议翻译层异常不饿死缓存维护等其他订阅者）。
     */
    /**
     * 订阅所有事件（IPC 子进程模式整通道转发用：事件名 `"${service}/${method}"`
     * 经 handler 首参透出，args 原样透传）。返回退订函数。
     */
    onAny(handler: (event: string, ...args: unknown[]) => void): () => void {
        this.anyHandlers.add(handler);
        return () => {
            this.anyHandlers.delete(handler);
        };
    }

    emit<E extends EventName<L, Name>>(event: E, ...args: EventArgs<L, Name, E>): void {
        // 全事件订阅（IPC 转发）：单个订阅者异常不打断派发，统一走 error 兜底
        for (const anyHandler of this.anyHandlers) {
            try {
                anyHandler(event as string, ...args);
            } catch (err) {
                this.notifyError(err);
            }
        }
        const listeners = this.emitter.listeners(event as string);
        for (const listener of listeners) {
            try {
                (listener as (...a: unknown[]) => void)(...args);
            } catch (err) {
                // error 兜底：单个订阅者异常不打断派发，统一通知 onError
                this.notifyError(err);
            }
        }
    }

    /** 通知所有错误处理器（单个异常不打断其他处理器）。 */
    private notifyError(err: unknown): void {
        for (const handler of this.errorHandlers) {
            handler(err);
        }
    }

    /** 订阅错误通知（监听器抛出的异常 / 其他内部错误）。 */
    onError(handler: (err: unknown) => void): () => void {
        this.errorHandlers.add(handler);
        return () => {
            this.errorHandlers.delete(handler);
        };
    }
}
