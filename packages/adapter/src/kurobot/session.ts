/**
 * kurobot 会话共享状态（自 event-pipeline.ts 拆出）
 *
 * 双向处理器共用的运行时状态：出站绑定集（hello_ack 快照 + bindings_updated
 * 全量替换；空集 = 全部不发）、pending 命令/查询表（UUID 关联）、最近 status
 * 快照与接收行绑定过滤 holder 同步。生命周期由 adapter 协调。
 */
import type { ReceiveLogFilterHolder } from "./adapter.js";
import type { KurobotConnectionOptions } from "./connection.js";
import type { StatusBody } from "./schema.js";

/** 会话状态装配参数（adapter 注入）。 */
export interface KurobotSessionDeps {
    /** 接收行绑定过滤 holder（绑定集变更后同步；停止/终止时清空）。 */
    receiveFilter?: ReceiveLogFilterHolder | undefined;
    logger?: KurobotConnectionOptions["logger"] | undefined;
}

/** kurobot 会话共享状态（绑定集 / pending 表 / status 快照 / 接收过滤）。 */
export class KurobotSession {
    private readonly receiveFilter: ReceiveLogFilterHolder | undefined;
    private readonly log: KurobotConnectionOptions["logger"];
    /** 出站绑定集（空集 = 全部不发，对齐服务端空绑定丢弃语义）。 */
    private bindings = new Set<string>();
    /** command 请求 UUID → 回发群号（command_result 帧无 channel，靠 id 关联）。 */
    readonly pendingCommands = new Map<string, string>();
    /** query 请求 UUID → 查询类别。 */
    readonly pendingQueries = new Map<string, "status" | "bindings">();
    /** 最近一帧 status 快照（仅缓存不发群，M-04 决策同构）。 */
    lastStatus: StatusBody | null = null;

    constructor(deps: KurobotSessionDeps) {
        this.receiveFilter = deps.receiveFilter;
        this.log = deps.logger;
    }

    /** 启动期重置：清绑定集与 pending 表、status 快照（对齐原 startKurobot 序）。 */
    resetForStart(): void {
        this.bindings = new Set();
        this.clearPending();
        this.lastStatus = null;
    }

    /** 清 pending 表（重连握手 / 停止 / 终止时；跨连接的 UUID 不复用）。 */
    clearPending(): void {
        this.pendingCommands.clear();
        this.pendingQueries.clear();
    }

    /** 清接收过滤（null = 不过滤；停止 / 连接终止时）。 */
    clearReceiveFilter(): void {
        if (this.receiveFilter !== undefined) {
            this.receiveFilter.current = null;
        }
    }

    /** 绑定集整体替换（hello_ack / bindings_updated / query_result）+ 同步接收过滤。 */
    applyBindings(bindings: readonly string[]): void {
        this.bindings = new Set(bindings);
        this.syncReceiveFilter();
    }

    /** 出站绑定判定：空集 = 全部不发；非绑定群不发。 */
    isBound(channel: string): boolean {
        return this.bindings.size > 0 && this.bindings.has(channel);
    }

    /** command_result 关联：取回发群号并出表（无对应请求 → undefined）。 */
    takeCommand(id: string): string | undefined {
        const channel = this.pendingCommands.get(id);
        if (channel !== undefined) {
            this.pendingCommands.delete(id);
        }
        return channel;
    }

    /** query_result 处理：bindings 刷新绑定集（防御性收窄）；status 缓存。 */
    applyQueryResult(
        id: string,
        body: { ok: true; data?: unknown } | { ok: false; error: string },
    ): void {
        const kind = this.pendingQueries.get(id);
        if (kind === undefined) {
            this.log?.warn({ id }, "kurobot: query_result 无对应请求，丢弃");
            return;
        }
        this.pendingQueries.delete(id);
        if (!body.ok) {
            this.log?.warn({ kind, error: body.error }, "kurobot: 查询失败");
            return;
        }
        if (kind === "bindings" && isStringArray(body.data)) {
            this.applyBindings(body.data);
            return;
        }
        this.log?.debug({ kind, data: body.data }, "kurobot: 查询结果已记录");
    }

    /** status 帧入账（仅缓存不发群，防刷屏）。 */
    applyStatus(body: StatusBody): void {
        this.lastStatus = body;
        this.log?.debug({ status: body }, "kurobot: status 已缓存");
    }

    /** 同步接收行过滤判定到 holder（绑定集变更后调用；私聊恒放行）。 */
    private syncReceiveFilter(): void {
        if (this.receiveFilter === undefined) {
            return;
        }
        this.receiveFilter.current = (peerUin, isGroup) => !isGroup || this.bindings.has(peerUin);
    }
}

/** string[] 防御性收窄（query_result bindings data）。 */
function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
