/**
 * NapukettoMilkyAdapter：Milky 协议适配器（P0，docs/protocols/milky.md）
 *
 * 第四个协议适配器（与 OB11/Satori/KuroBot 并行）：单端口 HTTP（/api + /event）
 * + WebHook。收链路订阅 kernel 消息通道 → 翻译 Milky 事件（message_receive /
 * message_recall）→ 广播；发链路 /api 动作 → kernel apis。
 *
 * 生命周期走 BaseProtocolAdapter 骨架；config.enabled=false 时空转（不订阅、
 * 不起传输）。翻译为纯函数（ADR-008）：实体回填 / ID 转换在广播路径异步取得
 * 后经 ctx 注入。
 */
import type { CanonicalElement, MsgEventChannel, RawMessage } from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { BaseProtocolAdapter, type ProtocolConfig, type ProtocolHooks } from "../core/index.js";
import { subscribeRawMessages } from "../core/raw-message.js";
import { createMilkyActionRegistry } from "./action/index.js";
import { MilkyApi, type MilkyApiOptions } from "./api.js";
import type { MilkyConfig } from "./config.js";
import { toGroupEntity, toGroupMemberEntity } from "./helper/entities.js";
import { MessageSeqIndex } from "./helper/seq-index.js";
import {
    type ReceiveTranslateContext,
    toMessageRecallEvent,
    toMessageReceiveEvent,
} from "./helper/translate.js";
import { assembleMilkyTransports, type MilkyLoggerLike } from "./transport.js";

/** 适配器构造参数（api 相关字段继承 MilkyApiOptions）。 */
export interface MilkyAdapterOptions extends MilkyApiOptions {
    config: ProtocolConfig<MilkyConfig>;
    broadcaster: EventBroadcaster;
    /** kernel 消息事件通道（收链路入口）。 */
    msgChannel: MsgEventChannel;
    /** 校准日志（webhook 失败 / 启停提示；IPC 模式传 loader pino 实例）。 */
    logger?: MilkyLoggerLike;
}

export class NapukettoMilkyAdapter extends BaseProtocolAdapter<MilkyConfig> {
    readonly protocol = "milky";

    private readonly msgChannel: MsgEventChannel;
    private readonly calibLogger: MilkyLoggerLike | undefined;
    private readonly api: MilkyApi;
    private readonly seqIndex = new MessageSeqIndex();
    /** 动作注册表（公共只读：装配方/测试枚举）。 */
    readonly registry: ReturnType<typeof createMilkyActionRegistry>;
    private unsubscribes: Array<() => void> = [];
    private stopTransports: (() => Promise<void>) | null = null;

    constructor(opts: MilkyAdapterOptions) {
        const hooks: ProtocolHooks = {
            onStart: (config) => this.startTransports(config as MilkyConfig),
            onStop: () => this.stopAll(),
            onReload: (config) => this.reloadTransports(config as MilkyConfig),
        };
        super({
            config: opts.config,
            broadcaster: opts.broadcaster,
            hooks,
        });
        this.msgChannel = opts.msgChannel;
        this.calibLogger = opts.logger;
        this.api = new MilkyApi(opts, this.seqIndex);
        this.registry = createMilkyActionRegistry({ api: this.api });
    }

    /** 启动传输 + 订阅（enabled=false 空转：不订阅不起传输）。 */
    private async startTransports(config: MilkyConfig): Promise<void> {
        if (!config.enabled) {
            this.calibLogger?.info({}, "milky: 未启用（enabled=false），跳过装配");
            return;
        }
        const broadcaster = this.getBroadcaster();
        if (broadcaster !== undefined) {
            const set = assembleMilkyTransports({
                config,
                broadcaster,
                registry: this.registry,
                ...(this.calibLogger !== undefined ? { logger: this.calibLogger } : {}),
            });
            this.stopTransports = set.close;
        }
        this.subscribe();
        this.calibLogger?.info(
            { host: config.host, port: config.port, modes: config.eventModes },
            "milky: adapter started",
        );
    }

    /** 热更新：停止重建（enabled 切换生效）。 */
    private async reloadTransports(config: MilkyConfig): Promise<void> {
        await this.stopAll();
        await this.startTransports(config);
    }

    /** 停止：退订 + 关传输。 */
    private async stopAll(): Promise<void> {
        this.unsubscribeAll();
        if (this.stopTransports !== null) {
            await this.stopTransports();
            this.stopTransports = null;
        }
    }

    /** 订阅 kernel 消息通道（幂等）。 */
    private subscribe(): void {
        if (this.unsubscribes.length > 0) {
            return;
        }
        this.unsubscribes.push(
            subscribeRawMessages(this.msgChannel, (msg) => {
                void this.handleIncoming(msg);
            }),
        );
    }

    /** 退订（幂等）。 */
    private unsubscribeAll(): void {
        for (const off of this.unsubscribes) {
            off();
        }
        this.unsubscribes = [];
    }

    /** 单条消息：seq 登记 → grayTip→recall / 普通→message_receive（自消息不上报）。 */
    private async handleIncoming(msg: RawMessage): Promise<void> {
        // seq 双向登记（含自消息：本账号发出的消息也要可反查）
        this.seqIndex.record(msg);
        if (hasGrayTip(msg)) {
            const event = await this.buildRecallEvent(msg);
            if (event !== null) {
                this.broadcastEvent(event);
            }
            return;
        }
        // 自消息不上报（P0 固定行为，与 OB11 默认一致）
        if (String(msg.senderUin) === this.api.self.uin) {
            return;
        }
        const event = await this.buildMessageReceiveEvent(msg);
        this.broadcastEvent(event);
    }

    /** message_receive 组装：at uid→uin + reply 回填 + 群实体回填（全部 fail-soft）。 */
    private async buildMessageReceiveEvent(msg: RawMessage): Promise<unknown> {
        const elements = toCanonicalElements(msg);
        const ctx: ReceiveTranslateContext = { selfUin: this.api.self.uin };
        await this.fillMentionUids(elements, ctx);
        this.fillReplyMeta(elements, ctx);
        await this.fillGroupEntities(msg, ctx);
        return toMessageReceiveEvent(msg, ctx);
    }

    /** at uid → uin 批量转换（mention.user_id 用；失败 mention 段跳过）。 */
    private async fillMentionUids(
        elements: CanonicalElement[],
        ctx: ReceiveTranslateContext,
    ): Promise<void> {
        const atUids = elements
            .filter((el) => el.type === "at" && el.target !== "all")
            .map((el) => (el as { target: string }).target);
        if (atUids.length === 0) {
            return;
        }
        try {
            ctx.uidToUin = await this.api.uidToUin(atUids);
        } catch {
            // 转换失败：mention 段跳过
        }
    }

    /** reply 引用元信息回填（seqIndex 命中即用；未命中不强查）。 */
    private fillReplyMeta(elements: CanonicalElement[], ctx: ReceiveTranslateContext): void {
        const replyIds = elements
            .filter((el) => el.type === "reply")
            .map((el) => (el as { messageId: string }).messageId);
        const meta = this.seqIndex.collectReplyMeta(replyIds);
        if (meta.size > 0) {
            ctx.replyMeta = meta;
        }
    }

    /** 群场景实体回填（GroupCache 缓存优先，失败最小实体兜底）。 */
    private async fillGroupEntities(msg: RawMessage, ctx: ReceiveTranslateContext): Promise<void> {
        if (msg.chatType !== ChatType.GROUP || this.api.groupCache === undefined) {
            return;
        }
        const [detail, member] = await Promise.all([
            this.api.groupCache.getGroupDetail(msg.peerUid).catch(() => undefined),
            this.api.groupCache.getMember(msg.peerUid, msg.senderUid).catch(() => undefined),
        ]);
        ctx.groupEntity = toGroupEntity(detail, msg.peerUid);
        ctx.groupMemberEntity = toGroupMemberEntity(member, msg.peerUid, msg.senderUin);
    }

    /** message_recall 组装（非撤回 grayTip 返回 null 静默）。 */
    private async buildRecallEvent(msg: RawMessage): Promise<unknown> {
        const uidToUin = await this.resolveOperatorUin(msg);
        return toMessageRecallEvent(msg, {
            selfUin: this.api.self.uin,
            ...(uidToUin !== undefined ? { uidToUin } : {}),
        });
    }

    /** 撤回操作者 uid → uin（未撤回/转换失败返回 undefined，operator_id 兜底 0）。 */
    private resolveOperatorUin(msg: RawMessage): Promise<Map<string, string> | undefined> {
        const operatorUid = findRevokeOperatorUid(msg);
        if (operatorUid === undefined) {
            return Promise.resolve(undefined);
        }
        return this.api.uidToUin([operatorUid]).catch(() => undefined);
    }
}

/** 撤回 grayTip 的操作者 uid（非撤回消息返回 undefined）。 */
function findRevokeOperatorUid(msg: RawMessage): string | undefined {
    const uid = msg.elements.find((el) => el.grayTipElement?.revokeElement !== undefined)
        ?.grayTipElement?.revokeElement?.operatorUid;
    return uid === undefined || uid === "" ? undefined : uid;
}

/** 是否含 grayTip 元素（与 OB11 收链路同判据）。 */
function hasGrayTip(msg: RawMessage): boolean {
    return msg.elements.some((el) => el.grayTipElement !== undefined);
}
