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
    LoginEventChannel,
    MsgEventChannel,
    RawMessage,
    RecentContact,
    RecentContactEventChannel,
    RecentContactListChanged,
} from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { BaseProtocolAdapter, type ProtocolConfig, type ProtocolHooks } from "../core/index.js";
import { narrowBuddyReqs } from "../core/shared/buddy-req.js";
import type { EssenceAddedItem } from "../core/shared/essence.js";
import { EssenceListSync, narrowEssenceGroupArg } from "../core/shared/essence.js";
import { collectGrayTipUids, hasGrayTip } from "../core/shared/gray-tip.js";
import { forEachRawMessage, subscribeRawMessages } from "../core/shared/raw-message.js";
import {
    decodeProtoTree,
    extractSysMsgEnvelope,
    narrowSysMsgBlobs,
    type SysMsgEnvelope,
    type SysMsgField,
    type SysMsgKindRule,
    toHex,
} from "../core/shared/sysmsg.js";
import type { RequestTranslateContext } from "../core/shared/uid-uin.js";
import { createMilkyActionRegistry } from "./action/index.js";
import { MilkyApi, type MilkyApiOptions } from "./api.js";
import type { MilkyConfig } from "./config.js";
import { toFriendFileUploadData } from "./helper/event/file-upload.js";
import { type NoticeTranslateContext, toMilkyNoticeEvent } from "./helper/event/notice.js";
import { PinWatch, toPeerPinChangeData } from "./helper/event/peer-pin.js";
import {
    collectNotifyUids,
    toFriendRequestEvent,
    toGroupRequestEvent,
} from "./helper/event/request.js";
import { recognizeMilkySysMsg } from "./helper/event/sysmsg.js";
import {
    type ReceiveTranslateContext,
    toGroupFileUploadEvent,
    toMessageRecallEvent,
    toMessageReceiveEvent,
} from "./helper/event/translate.js";
import { toGroupEntity, toGroupMemberEntity } from "./helper/message/entities.js";
import { incomingForwardSegment } from "./helper/message/segments.js";
import { RecentKeyCache } from "./helper/state/recent-keys.js";
import { MessageSeqIndex } from "./helper/state/seq-index.js";
import { assembleMilkyTransports, type MilkyLoggerLike } from "./transport.js";
import type { BotOfflineData, GroupEssenceMessageChangeData, PeerPinChangeData } from "./types.js";

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
    /** kernel 会话列表事件通道（批次三：peer_pin_change；缺省不订阅）。 */
    recentContactChannel?: RecentContactEventChannel;
    /** kernel 登录状态事件通道（批次三：bot_offline；缺省不订阅）。 */
    loginChannel?: LoginEventChannel;
    /** 校准日志（webhook 失败 / 启停提示 / 未知事件形状；IPC 模式传 loader pino 实例）。 */
    logger?: MilkyLoggerLike;
}

/** sysmsg 识别命中产物（信封 + 规则 + 已提取 data 体）。 */
interface SysMsgHit {
    env: SysMsgEnvelope;
    rule: SysMsgKindRule<unknown>;
    data: unknown;
}

export class NapukettoMilkyAdapter extends BaseProtocolAdapter<MilkyConfig> {
    readonly protocol = "milky";

    private readonly msgChannel: MsgEventChannel;
    private readonly groupChannel: GroupEventChannel | undefined;
    private readonly buddyChannel: BuddyEventChannel | undefined;
    private readonly recentContactChannel: RecentContactEventChannel | undefined;
    private readonly loginChannel: LoginEventChannel | undefined;
    /** peer_pin 翻转检测（批次三；启动期 getPinnedContacts 播种）。 */
    private readonly pinWatch = new PinWatch();
    /** friend_file_upload 双回调去重（同载荷，按 msgId）。 */
    private readonly fileKeys = new RecentKeyCache(10 * 60 * 1000);
    /** essence 双路径去重（732:1 快路径 vs 列表 diff，键 群:seq:方向）。 */
    private readonly essenceKeys = new RecentKeyCache(5 * 60 * 1000);
    /** 精华列表串行同步（core 共享组件：缓存 + 串行链 + diff）。 */
    private readonly essenceSync: EssenceListSync;
    private readonly calibLogger: MilkyLoggerLike | undefined;
    private readonly api: MilkyApi;
    private readonly seqIndex = new MessageSeqIndex();
    /** 动作注册表（公共只读：装配方/测试枚举）。 */
    readonly registry: ReturnType<typeof createMilkyActionRegistry>;
    private unsubscribes: Array<() => void> = [];
    private stopTransports: (() => Promise<void>) | null = null;

    constructor(opts: MilkyAdapterOptions) {
        const hooks: ProtocolHooks<MilkyConfig> = {
            onStart: (config) => this.startTransports(config),
            onStop: () => this.stopAll(),
            onReload: (config) => this.reloadTransports(config),
        };
        super({
            config: opts.config,
            broadcaster: opts.broadcaster,
            hooks,
        });
        this.msgChannel = opts.msgChannel;
        this.groupChannel = opts.groupChannel;
        this.buddyChannel = opts.buddyChannel;
        this.recentContactChannel = opts.recentContactChannel;
        this.loginChannel = opts.loginChannel;
        this.calibLogger = opts.logger;
        this.api = new MilkyApi(opts, this.seqIndex);
        this.essenceSync = new EssenceListSync({
            fetchList: (groupCode) => this.api.webApi.getEssenceMsgList(groupCode),
            onAdded: (groupCode, added) => this.broadcastEssenceAdded(groupCode, added),
            onRemoved: (groupCode, removed) => this.broadcastEssenceRemoved(groupCode, removed),
            onFetchError: (groupCode, err) => {
                this.calibLogger?.warn(
                    { group: groupCode, err: String(err) },
                    "milky: 精华列表拉取失败（diff 跳过）",
                );
            },
        });
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
            // 启动监听（satori/OB11 startTransports 同款）：server.open 实绑端口，
            // hub / webhook client 的 open 均为 no-op。2026-11-01 实机发现：缺此步
            // milky HTTP 从未监听（P0 起；集成测试一直显式 open 掩盖了该缺口）。
            await Promise.all(set.adapters.map((a) => a.open()));
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
        // sysmsg 总闸（批次三：732:16 表情回应 / 732:1 精华设置快路径）
        this.unsubscribes.push(
            this.msgChannel.on("Msg/onRecvSysMsg", (arg) => {
                this.handleSysMsg(arg);
            }),
        );
        // 私聊文件（批次三 friend_file_upload）：双回调同载荷，处理器内按 msgId 去重
        this.unsubscribes.push(
            this.msgChannel.on("Msg/onRecvOfflineFileMsg", (msgs) => {
                this.handleFileMessages(msgs);
            }),
            this.msgChannel.on("Msg/onFileMsgCome", (msgs) => {
                this.handleFileMessages(msgs);
            }),
        );
        this.subscribeGroupAndBuddy();
        this.subscribeBatch3();
    }

    /** 群通知 + 好友请求通道（P1 事件源；通道缺省不订阅）。 */
    private subscribeGroupAndBuddy(): void {
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

    /** 批次三通道：精华列表变更 / 置顶翻转（含播种基线）/ bot_offline。 */
    private subscribeBatch3(): void {
        if (this.groupChannel !== undefined) {
            const groupChannel = this.groupChannel;
            // 精华列表变更（批次三：remove 路径 + operator 回填，列表 diff）
            this.unsubscribes.push(
                groupChannel.on("Group/onGroupEssenceListChange", (arg) => {
                    this.handleEssenceChange(arg);
                }),
            );
        }
        if (this.recentContactChannel !== undefined) {
            const recentContactChannel = this.recentContactChannel;
            this.unsubscribes.push(
                recentContactChannel.on("RecentContact/onRecentContactListChangedVer2", (lists) => {
                    this.handlePinChanges(lists);
                }),
            );
            this.seedPinWatch();
        }
        if (this.loginChannel !== undefined) {
            const loginChannel = this.loginChannel;
            this.unsubscribes.push(
                loginChannel.on("Login/onLoginDisConnected", (...args) => {
                    this.broadcastBotOffline("disconnected", args);
                }),
                loginChannel.on("Login/onLogoutSucceed", (...args) => {
                    this.broadcastBotOffline("logout", args);
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
            (el) => el.multiForwardMsgElement != null,
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
            (el) => el.multiForwardMsgElement != null,
        )?.multiForwardMsgElement;
        if (forward !== undefined && forward.resId !== "") {
            this.seqIndex.recordForward(forward.resId, {
                chatType: msg.chatType,
                peerUid: msg.peerUid,
                msgId: msg.msgId,
            });
        }
    }

    // ------------------------------------------------------------------
    // 批次三事件（milky.md §0.8.6）：sysmsg 识别表 / 私聊文件 / 精华 diff /
    // 置顶翻转 / 下线。载荷证据 = 2026-11-01 三轮录制 + set_peer_pin 翻转实验。
    // ------------------------------------------------------------------

    /**
     * sysmsg 总闸：解码 → 识别 → 表命中才广播（732:16 表情回应 / 732:1 精华
     * 设置）；未识别 debug 校准日志。规则提取失败不广播半成品事件。
     */
    private handleSysMsg(arg: unknown): void {
        const blobs = narrowSysMsgBlobs(arg);
        if (blobs === null) {
            this.calibLogger?.warn(
                { raw: truncate(JSON.stringify(arg)) },
                "milky: onRecvSysMsg 未知参数形状",
            );
            return;
        }
        for (const blob of blobs) {
            this.handleSysMsgBlob(blob);
        }
    }

    /** 单条字节块：解码 → 识别 → 提取；任一步失败走校准日志返回 null。 */
    private handleSysMsgBlob(blob: Uint8Array): void {
        const hit = this.sysMsgHit(blob);
        if (hit === null) {
            return;
        }
        if (!this.claimEssenceFastPath(hit)) {
            return;
        }
        this.broadcastEvent({
            time: hit.env.time ?? Math.floor(Date.now() / 1000),
            self_id: Number(this.api.self.uin),
            event_type: hit.rule.kind,
            data: hit.data,
        });
    }

    /** 解码 + 识别 + 提取（每步失败各自打 debug 校准日志）。 */
    private sysMsgHit(blob: Uint8Array): SysMsgHit | null {
        const tree = decodeProtoTree(blob);
        if (tree === null) {
            this.calibLogger?.debug(
                { raw: toHex(blob).slice(0, 1024) },
                "milky: onRecvSysMsg protobuf 解码失败",
            );
            return null;
        }
        const env = extractSysMsgEnvelope(tree);
        const rule = this.sysMsgRule(env, tree, blob);
        if (rule === null) {
            return null;
        }
        return { env, rule: rule.rule, data: rule.data };
    }

    /** 识别 + 规则提取（未识别/提取失败 → 校准日志 + null）。 */
    private sysMsgRule(
        env: SysMsgEnvelope,
        tree: readonly SysMsgField[],
        blob: Uint8Array,
    ): { rule: SysMsgKindRule<unknown>; data: unknown } | null {
        const rec = recognizeMilkySysMsg(env.msgType, env.subType);
        if (rec.kind !== "notice") {
            this.calibLogger?.debug(
                {
                    verdict: rec.kind,
                    msgType: env.msgType,
                    subType: env.subType,
                    strings: env.strings,
                    raw: toHex(blob).slice(0, 1024),
                },
                "milky: onRecvSysMsg 校准数据（未识别，不广播）",
            );
            return null;
        }
        const ctx = {
            selfUin: Number(this.api.self.uin),
            time: env.time ?? Math.floor(Date.now() / 1000),
        };
        const data = rec.rule.extract(tree, env, () => 0, ctx);
        if (data === null) {
            this.calibLogger?.debug(
                { kind: rec.rule.kind, msgType: env.msgType, subType: env.subType },
                "milky: sysmsg 规则提取失败（不广播）",
            );
            return null;
        }
        return { rule: rec.rule, data };
    }

    /** 精华快路径去重守卫：非精华事件恒 true；精华事件 claim 失败（已由列表 diff 抢发）→ false。 */
    private claimEssenceFastPath(hit: SysMsgHit): boolean {
        if (hit.rule.kind !== "group_essence_message_change") {
            return true;
        }
        const essence = hit.data as GroupEssenceMessageChangeData;
        return this.essenceKeys.claim(`${essence.group_id}:${essence.message_seq}:1`);
    }

    /** 私聊文件消息 → friend_file_upload（双回调同载荷，按 msgId 去重）。 */
    private handleFileMessages(msgs: unknown): void {
        forEachRawMessage(msgs, (msg) => {
            // senderUin 缺失时的 uid 反查需异步批量，此处从简（录制实证 senderUin
            // 恒有值；缺失场景 user_id=0 + 校准日志）
            const data = toFriendFileUploadData(msg, this.api.self.uin, new Map());
            if (data === null) {
                return;
            }
            if (data.user_id === 0) {
                this.calibLogger?.debug(
                    { msgId: msg.msgId, senderUid: msg.senderUid },
                    "milky: friend_file_upload senderUin 缺失（user_id=0）",
                );
            }
            if (!this.fileKeys.claim(`file:${msg.msgId}`)) {
                return;
            }
            this.broadcastEvent({
                time: secondsOf(msg.msgTime),
                self_id: Number(this.api.self.uin),
                event_type: "friend_file_upload",
                data,
            });
        });
    }

    /** 精华列表变更：拉全量列表 diff（remove 路径 + operator 回填；串行防乱序）。 */
    private handleEssenceChange(arg: unknown): void {
        const groupCode = narrowEssenceGroupArg(arg);
        if (groupCode === null) {
            this.calibLogger?.warn(
                { raw: truncate(JSON.stringify(arg)) },
                "milky: onGroupEssenceListChange 未知参数形状",
            );
            return;
        }
        this.essenceSync.enqueue(groupCode);
    }

    /** diff 新增项广播（is_set=true；operator = add_digest_uin；快路径已发则跳过）。 */
    private broadcastEssenceAdded(groupCode: string, added: readonly EssenceAddedItem[]): void {
        const now = Math.floor(Date.now() / 1000);
        const selfId = Number(this.api.self.uin);
        for (const item of added) {
            // 732:1 快路径已广播过则跳过（去重窗口内）
            if (!this.essenceKeys.claim(`${groupCode}:${item.messageSeq}:1`)) {
                continue;
            }
            const data = essenceAddedData(groupCode, item);
            this.broadcastEvent({
                time: now,
                self_id: selfId,
                event_type: "group_essence_message_change",
                data,
            });
        }
    }

    /** diff 移除项广播（is_set=false；取消无 sysmsg，operator 不可得省略）。 */
    private broadcastEssenceRemoved(groupCode: string, removed: readonly number[]): void {
        const now = Math.floor(Date.now() / 1000);
        const selfId = Number(this.api.self.uin);
        for (const seq of removed) {
            if (!this.essenceKeys.claim(`${groupCode}:${seq}:0`)) {
                continue;
            }
            this.broadcastEvent({
                time: now,
                self_id: selfId,
                event_type: "group_essence_message_change",
                data: { group_id: Number(groupCode), message_seq: seq, is_set: false },
            });
        }
    }

    /** 会话列表变更 → peer_pin_change（topFlag 翻转检测，条目自带 chatType 判场景）。 */
    private handlePinChanges(lists: unknown): void {
        const arr = Array.isArray(lists) ? lists : [lists];
        for (const list of arr) {
            this.handlePinChangeList(list);
        }
    }

    /** 单个变更列表：changedList 逐条目翻转检测 + 广播。 */
    private handlePinChangeList(list: unknown): void {
        for (const entry of changedListOf(list)) {
            this.handlePinEntry(entry);
        }
    }

    /** 单个变更条目：翻译 + 翻转检测 + 广播（首见/未变/不支持场景静默跳过）。 */
    private handlePinEntry(entry: unknown): void {
        const payload = pinPayloadOf(entry);
        if (payload === null) {
            return;
        }
        if (!this.pinWatch.observe(payload.chatType, payload.peerUin, payload.topFlag)) {
            return;
        }
        this.broadcastEvent({
            time: secondsOf(payload.topFlagTime),
            self_id: Number(this.api.self.uin),
            event_type: "peer_pin_change",
            data: payload.data,
        });
    }

    /** 启动基线：置顶会话播种（重启后首个取消置顶也能观测到翻转；失败静默）。 */
    private seedPinWatch(): void {
        void this.api.recentContactApi
            .getPinnedContacts()
            .then((pins) => {
                this.pinWatch.seed(pins);
            })
            .catch(() => undefined);
    }

    /** bot_offline：Login 桥回调（载荷零样本，reason 固定值 + raw 校准日志待野捕）。 */
    private broadcastBotOffline(reason: string, args: unknown[]): void {
        this.calibLogger?.debug(
            { reason, raw: truncate(JSON.stringify(args)) },
            "milky: bot_offline（reason 为固定值，回调载荷待野捕校准）",
        );
        this.broadcastEvent({
            time: Math.floor(Date.now() / 1000),
            self_id: Number(this.api.self.uin),
            event_type: "bot_offline",
            data: { reason } satisfies BotOfflineData,
        });
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

/** 撤回 grayTip 元素（非撤回消息返回 undefined）。 */
function findRevokeElement(msg: RawMessage) {
    return msg.elements.find((el) => el.grayTipElement?.revokeElement != null)?.grayTipElement
        ?.revokeElement;
}

/** 字符串截断（raw 日志防刷屏）。 */
function truncate(raw: string | undefined): string {
    return raw === undefined ? "" : raw.slice(0, 2000);
}

/** 数字串判别（uin / 秒级时间戳）。 */
const NUMERIC_RE = /^\d+$/;

/** diff 新增项 → 事件载荷（operator = add_digest_uin，非数字串省略）。 */
function essenceAddedData(
    groupCode: string,
    item: { messageSeq: number; operatorUin: string | null },
): GroupEssenceMessageChangeData {
    const base = { group_id: Number(groupCode), message_seq: item.messageSeq };
    if (item.operatorUin !== null && NUMERIC_RE.test(item.operatorUin)) {
        return { ...base, operator_id: Number(item.operatorUin), is_set: true };
    }
    return { ...base, is_set: true };
}

/** 变更列表 → changedList 条目数组（形状不符 → 空）。 */
function changedListOf(list: unknown): readonly unknown[] {
    if (list === null || typeof list !== "object") {
        return [];
    }
    const changed = (list as RecentContactListChanged).changedList;
    return Array.isArray(changed) ? changed : [];
}

/** 变更条目 → 翻转检测输入（null = 条目不支持/缺置顶字段）。 */
function pinPayloadOf(entry: unknown): PinPayload | null {
    if (entry === null || typeof entry !== "object") {
        return null;
    }
    return pinPayloadFrom(entry as RecentContact);
}

/** 单条置顶变更条目的翻转检测输入。 */
interface PinPayload {
    chatType: number;
    peerUin: string;
    topFlag: number;
    topFlagTime: string | undefined;
    data: PeerPinChangeData;
}

function pinPayloadFrom(contact: RecentContact): PinPayload | null {
    const topFlag = contact.topFlag;
    const payload = toPeerPinChangeData(contact);
    if (topFlag === undefined || payload === null) {
        return null;
    }
    return {
        chatType: contact.chatType,
        peerUin: payload.peerUin,
        topFlag,
        topFlagTime: payload.topFlagTime,
        data: payload.data,
    };
}

/** 秒级时间戳归一（空/非法 → 当前时间；topFlagTime/msgTime 均为秒级字符串）。 */
function secondsOf(raw: string | undefined): number {
    if (raw !== undefined && NUMERIC_RE.test(raw)) {
        return Number(raw);
    }
    return Math.floor(Date.now() / 1000);
}
