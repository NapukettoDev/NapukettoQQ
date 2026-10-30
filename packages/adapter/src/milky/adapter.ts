/**
 * NapukettoMilkyAdapter：Milky 协议适配器（P0 2026-10-28，P1 2026-10-30）
 *
 * 第四个协议适配器（与 OB11/Satori/KuroBot 并行）：单端口 HTTP（/api + /event）
 * + WebHook。收链路三源（P1）：
 *  - 消息通道（Msg/onRecvMsg）：seq 登记 → grayTip→notice / 文件消息→group_file_upload
 *    （群场景）/ 普通→message_receive（自消息不上报）；
 *  - 群通知通道（Group/onGroupNotifiesUpdated）：入群请求 / 成员邀请 / 邀请自身；
 *  - 好友请求通道（Buddy/onBuddyReqChange）：friend_request（防御收窄）。
 * 发链路 /api 动作 → kernel apis。
 *
 * 生命周期走 BaseProtocolAdapter 骨架；config.enabled=false 时空转（不订阅、
 * 不起传输）。翻译为纯函数（ADR-008）：实体回填 / ID 转换在广播路径异步取得
 * 后经 ctx 注入。
 */
import type {
    BuddyEventChannel,
    CanonicalElement,
    GroupEventChannel,
    GroupNotify,
    MsgEventChannel,
    RawMessage,
} from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { narrowBuddyReqs } from "../core/buddy-req.js";
import { collectGrayTipUids } from "../core/gray-tip.js";
import { BaseProtocolAdapter, type ProtocolConfig, type ProtocolHooks } from "../core/index.js";
import { subscribeRawMessages } from "../core/raw-message.js";
import type { RequestTranslateContext } from "../core/uid-uin.js";
import { createMilkyActionRegistry } from "./action/index.js";
import { MilkyApi, type MilkyApiOptions } from "./api.js";
import type { MilkyConfig } from "./config.js";
import { toGroupEntity, toGroupMemberEntity } from "./helper/entities.js";
import { type NoticeTranslateContext, toMilkyNoticeEvent } from "./helper/notice.js";
import { collectNotifyUids, toFriendRequestEvent, toGroupRequestEvent } from "./helper/request.js";
import { incomingForwardSegment } from "./helper/segments.js";
import { MessageSeqIndex } from "./helper/seq-index.js";
import {
    type ReceiveTranslateContext,
    toGroupFileUploadEvent,
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
    /** kernel 群事件通道（P1：群请求/邀请推送；缺省不订阅）。 */
    groupChannel?: GroupEventChannel;
    /** kernel 好友事件通道（P1：好友申请推送；缺省不订阅）。 */
    buddyChannel?: BuddyEventChannel;
    /** 校准日志（webhook 失败 / 启停提示 / 未知事件形状；IPC 模式传 loader pino 实例）。 */
    logger?: MilkyLoggerLike;
}

export class NapukettoMilkyAdapter extends BaseProtocolAdapter<MilkyConfig> {
    readonly protocol = "milky";

    private readonly msgChannel: MsgEventChannel;
    private readonly groupChannel: GroupEventChannel | undefined;
    private readonly buddyChannel: BuddyEventChannel | undefined;
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
        this.groupChannel = opts.groupChannel;
        this.buddyChannel = opts.buddyChannel;
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

    /** 订阅 kernel 事件（消息 + 群通知 + 好友请求，幂等）。 */
    private subscribe(): void {
        if (this.unsubscribes.length > 0) {
            return;
        }
        this.unsubscribes.push(
            subscribeRawMessages(this.msgChannel, (msg) => {
                void this.handleIncoming(msg);
            }),
        );
        if (this.groupChannel !== undefined) {
            const groupChannel = this.groupChannel;
            this.unsubscribes.push(
                groupChannel.on("Group/onGroupNotifiesUpdated", (doubt, notifies) => {
                    void this.handleGroupNotifies(doubt, notifies);
                }),
            );
        }
        if (this.buddyChannel !== undefined) {
            const buddyChannel = this.buddyChannel;
            this.unsubscribes.push(
                buddyChannel.on("Buddy/onBuddyReqChange", (arg) => {
                    this.handleBuddyReqs(arg);
                }),
            );
        }
    }

    /** 退订（幂等）。 */
    private unsubscribeAll(): void {
        for (const off of this.unsubscribes) {
            off();
        }
        this.unsubscribes = [];
    }

    /** 单条消息：seq 登记 → grayTip→notice / 群文件上传 / message_receive（自消息不上报）。 */
    private async handleIncoming(msg: RawMessage): Promise<void> {
        // seq 双向登记（含自消息：本账号发出的消息也要可反查）；转发 resId 登记索引
        this.seqIndex.record(msg);
        this.recordForward(msg);
        if (hasGrayTip(msg)) {
            await this.broadcastNotice(msg);
            return;
        }
        // 群文件上传：群场景文件消息 → group_file_upload 事件（Milky 语义，
        // 场景守卫在翻译函数内）
        const upload = toGroupFileUploadEvent(msg, this.api.self.uin);
        if (upload !== null) {
            this.broadcastEvent(upload);
            return;
        }
        // 自消息不上报（与 OB11 默认一致）
        if (String(msg.senderUin) === this.api.self.uin) {
            return;
        }
        this.broadcastEvent(await this.buildMessageReceiveEvent(msg));
    }

    /** grayTip → notice 事件广播（REVOKE 走 message_recall，其余走 notice 翻译）。 */
    private async broadcastNotice(msg: RawMessage): Promise<void> {
        const uidToUin = await this.resolveUidToUin(collectGrayTipUids(msg));
        const event =
            findRevokeElement(msg) !== undefined
                ? toMessageRecallEvent(msg, {
                      selfUin: this.api.self.uin,
                      ...(uidToUin !== undefined ? { uidToUin } : {}),
                  })
                : toMilkyNoticeEvent(msg, this.noticeCtx(uidToUin));
        if (event !== null) {
            this.broadcastEvent(event);
        }
    }

    /** notice 翻译上下文（uidToUin 缺省空 Map；logger 透传校准日志）。 */
    private noticeCtx(uidToUin: Map<string, string> | undefined): NoticeTranslateContext {
        return {
            selfUin: this.api.self.uin,
            ...(uidToUin !== undefined ? { uidToUin } : { uidToUin: new Map() }),
            ...(this.calibLogger !== undefined ? { logger: this.calibLogger } : {}),
        };
    }

    /** 群通知通道：入群请求 / 成员邀请 / 邀请自身（uid→uin 批量后翻译）。 */
    private async handleGroupNotifies(doubt: boolean, notifies: GroupNotify[]): Promise<void> {
        const ctx = await this.requestCtx(collectNotifyUids(notifies));
        for (const notify of notifies) {
            const event = toGroupRequestEvent(notify, doubt, ctx);
            if (event !== null) {
                this.broadcastEvent(event);
            }
        }
    }

    /** 好友请求通道：Buddy/onBuddyReqChange（防御收窄，未知形状 raw 日志）。 */
    private handleBuddyReqs(arg: unknown): void {
        const reqs = narrowBuddyReqs(arg);
        if (reqs === null) {
            this.calibLogger?.warn(
                { raw: truncate(JSON.stringify(arg)) },
                "milky: onBuddyReqChange 未知参数形状",
            );
            return;
        }
        void (async () => {
            const ctx = await this.requestCtx(reqs.map((req) => req.friendUid));
            for (const req of reqs) {
                this.broadcastEvent(toFriendRequestEvent(req, ctx));
            }
        })();
    }

    /** request 翻译上下文（uid→uin 批量转换）。 */
    private async requestCtx(uids: string[]): Promise<RequestTranslateContext> {
        const uidToUin = await this.resolveUidToUin(uids);
        return {
            selfUin: this.api.self.uin,
            ...(uidToUin !== undefined ? { uidToUin } : { uidToUin: new Map() }),
        };
    }

    /** message_receive 组装：at uid→uin + reply 回填 + 群实体回填 + 转发段（全部 fail-soft）。 */
    private async buildMessageReceiveEvent(msg: RawMessage): Promise<unknown> {
        const elements = toCanonicalElements(msg);
        const ctx: ReceiveTranslateContext = { selfUin: this.api.self.uin };
        await this.fillMentionUids(elements, ctx);
        this.fillReplyMeta(elements, ctx);
        await this.fillGroupEntities(msg, ctx);
        const forward = msg.elements.find(
            (el) => el.multiForwardMsgElement !== undefined,
        )?.multiForwardMsgElement;
        if (forward !== undefined) {
            ctx.forwardSegments = [incomingForwardSegment(forward.resId, forward.fileName)];
        }
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

    /** 转发 resId → 定位登记（get_forwarded_messages 反查用）。 */
    private recordForward(msg: RawMessage): void {
        const forward = msg.elements.find(
            (el) => el.multiForwardMsgElement !== undefined,
        )?.multiForwardMsgElement;
        if (forward !== undefined && forward.resId !== "") {
            this.seqIndex.recordForward(forward.resId, {
                chatType: msg.chatType,
                peerUid: msg.peerUid,
                msgId: msg.msgId,
            });
        }
    }

    /** uid 批量 → uin（空集/失败返回 undefined 语义：调用方用空 Map）。 */
    private resolveUidToUin(uids: string[]): Promise<Map<string, string> | undefined> {
        const unique = [...new Set(uids.filter((uid) => uid !== ""))];
        if (unique.length === 0) {
            return Promise.resolve(undefined);
        }
        return this.api.uidToUin(unique).catch(() => undefined);
    }
}

/** 是否含 grayTip 元素（与 OB11 收链路同判据）。 */
function hasGrayTip(msg: RawMessage): boolean {
    return msg.elements.some((el) => el.grayTipElement !== undefined);
}

/** 撤回 grayTip 元素（非撤回消息返回 undefined）。 */
function findRevokeElement(msg: RawMessage) {
    return msg.elements.find((el) => el.grayTipElement?.revokeElement !== undefined)?.grayTipElement
        ?.revokeElement;
}

/** 字符串截断（raw 日志防刷屏）。 */
function truncate(raw: string | undefined): string {
    return raw === undefined ? "" : raw.slice(0, 2000);
}
