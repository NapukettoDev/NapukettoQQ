/**
 * OB11 收链路事件管道（2026-11-14 自 adapter.ts 拆分）
 *
 * 接管 kernel 各事件通道（msg/group/friend/buddyCache）的订阅与退订、自消息
 * 过滤、群文件报形式开关、精华串行同步触发，以及翻译后的广播派发。翻译前的
 * 异步回填（uid→uin / 角色 / msgId 反查）走 Ob11Enrichment（ADR-008），翻译
 * 函数保持纯函数。
 */
import type {
    BuddyCacheEventChannel,
    BuddyEventChannel,
    BuddyReq,
    GroupEventChannel,
    GroupNotify,
    MsgEventChannel,
    RawMessage,
} from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import type { EssenceAddedItem, EssenceCacheEntry } from "../core/shared/essence.js";
import {
    EssenceListSync,
    extractEssenceSetSysMsg,
    narrowEssenceGroupArg,
} from "../core/shared/essence.js";
import type { AdapterLoggerLike } from "../core/shared/log.js";
import { truncRaw } from "../core/shared/log.js";
import { subscribeRawMessages } from "../core/shared/raw-message.js";
import { MS_TO_SEC, numericUin } from "../core/shared/uid-uin.js";
import type { OneBotApi } from "./api/index.js";
import { Ob11Enrichment } from "./enrichment.js";
import type { OB11Config } from "./helper/index.js";
import { toOb11MessageEvent } from "./helper/message-event.js";
import {
    collectGrayTipUids,
    hasFileElement,
    hasGrayTip,
    toFriendAdd,
    toGroupUpload,
    toOb11NoticeEvent,
} from "./helper/notice.js";
import { narrowOfflineFiles, toOfflineFileNotice } from "./helper/notice-extra.js";
import {
    narrowBuddyReqs,
    type RequestTranslateContext,
    toOb11FriendRequestEvent,
    toOb11GroupRequestEvent,
} from "./helper/request.js";
import {
    decodeProtoTree,
    extractSysMsgEnvelope,
    narrowSysMsgBlobs,
    recognizeOb11SysMsg,
    type SysMsgEnvelope,
    type SysMsgField,
    toHex,
} from "./helper/sysmsg.js";

/** 事件管道装配参数（频道 / api / 事件出口由 adapter 注入）。 */
export interface Ob11EventPipelineDeps {
    /** 当前账号 uin（自消息过滤 + self_id 口径）。 */
    selfUin: string;
    api: OneBotApi;
    /** 事件出口（BaseProtocolAdapter.broadcastEvent 透传）。 */
    broadcast: (event: unknown) => void;
    /** 校准日志（可选：未知事件形状 raw JSON；缺省静默）。 */
    logger?: AdapterLoggerLike | undefined;
    msgChannel: MsgEventChannel;
    groupChannel?: GroupEventChannel | undefined;
    friendChannel?: BuddyEventChannel | undefined;
    buddyCacheEvents?: BuddyCacheEventChannel | undefined;
}

/** OB11 收链路事件管道（订阅 / 过滤 / 精华同步 / 翻译派发）。 */
export class Ob11EventPipeline {
    private readonly selfUin: string;
    private readonly api: OneBotApi;
    private readonly broadcast: (event: unknown) => void;
    private readonly calibLogger: AdapterLoggerLike | undefined;
    private readonly msgChannel: MsgEventChannel;
    private readonly groupChannel: GroupEventChannel | undefined;
    private readonly friendChannel: BuddyEventChannel | undefined;
    private readonly buddyCacheEvents: BuddyCacheEventChannel | undefined;
    private readonly enrich: Ob11Enrichment;
    /** 精华列表串行同步（core 共享组件：缓存 + 串行链 + diff；732:1 触发器与列表回调共用）。 */
    private readonly essenceSync: EssenceListSync;
    private unsubscribes: Array<() => void> = [];
    // 收链路开关（start/subscribeOnly/reload 经 applyConfig 刷新）
    private reportSelfMessage = false;
    private messageFormat: "array" | "string" = "array";
    /** 群文件报形式（B4）：true = fileElement 群消息报 group_upload notice 替代 message。 */
    private groupUploadAsNotice = false;

    constructor(deps: Ob11EventPipelineDeps) {
        this.selfUin = deps.selfUin;
        this.api = deps.api;
        this.broadcast = deps.broadcast;
        this.calibLogger = deps.logger;
        this.msgChannel = deps.msgChannel;
        this.groupChannel = deps.groupChannel;
        this.friendChannel = deps.friendChannel;
        this.buddyCacheEvents = deps.buddyCacheEvents;
        this.enrich = new Ob11Enrichment({
            api: deps.api,
            ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        });
        this.essenceSync = new EssenceListSync({
            fetchList: (groupCode) => this.api.webApi.getEssenceMsgList(groupCode),
            onAdded: (groupCode, added) => this.broadcastEssenceAdded(groupCode, added),
            onRemoved: (groupCode, removed, prev) =>
                this.broadcastEssenceRemoved(groupCode, removed, prev),
            onFetchError: (groupCode, err) => {
                this.calibLogger?.warn(
                    { group: groupCode, err: String(err) },
                    "ob11: 精华列表拉取失败（diff 跳过）",
                );
            },
        });
    }

    /** 刷新收链路开关（start / subscribeOnly / reload 共用）。 */
    applyConfig(config: OB11Config): void {
        this.reportSelfMessage = config.reportSelfMessage;
        this.messageFormat = config.messagePostFormat;
        this.groupUploadAsNotice = config.groupUploadAsNotice;
    }

    /** 订阅 kernel 事件（消息 + 群通知 + 好友请求，幂等）。 */
    subscribe(): void {
        if (this.unsubscribes.length > 0) {
            return;
        }
        // onRecvMsg 回调参数为消息数组（2026-08-07 运行时实证）——遍历逐条翻译。
        this.unsubscribes.push(
            subscribeRawMessages(this.msgChannel, (msg) => {
                this.handleRawMessage(msg);
            }),
        );
        // 离线文件（c3，2026-09-10）：Msg/onRecvOfflineFileMsg → OB11 offline_file
        // notice（payload 形状待校准：防御性收窄，未知形状 raw 日志积累）
        this.unsubscribes.push(
            this.msgChannel.on("Msg/onRecvOfflineFileMsg", (arg) => {
                const items = narrowOfflineFiles(arg);
                if (items === null) {
                    this.calibLogger?.warn(
                        { raw: truncRaw(JSON.stringify(arg)) },
                        "ob11: onRecvOfflineFileMsg 未知参数形状",
                    );
                    return;
                }
                for (const item of items) {
                    this.broadcast(toOfflineFileNotice(item, this.selfUin));
                }
            }),
        );
        // sys msg 总闸（c3 接线；2026-09-10 解码回填，design.md §7）：
        // 解码 → 识别 → 表命中才广播；未识别走结构化校准日志。
        // ⚠️ 识别表当前为空（card/title/sign 判别值无样本支撑）= 全部校准日志。
        this.unsubscribes.push(
            this.msgChannel.on("Msg/onRecvSysMsg", (arg) => {
                const blobs = narrowSysMsgBlobs(arg);
                if (blobs === null) {
                    this.calibLogger?.warn(
                        { raw: truncRaw(JSON.stringify(arg)) },
                        "ob11: onRecvSysMsg 未知参数形状",
                    );
                    return;
                }
                for (const blob of blobs) {
                    void this.handleSysMsgBlob(blob);
                }
            }),
        );
        // 在线文件：raw 校准日志（OB11 无对应通知类型；debug 级，2026-10-25）
        this.unsubscribes.push(
            this.msgChannel.on("Msg/onRecvOnlineFileMsg", (arg) => {
                this.calibLogger?.debug(
                    { raw: JSON.stringify(arg)?.slice(0, 2000) },
                    "ob11: onRecvOnlineFileMsg raw（校准数据）",
                );
            }),
        );
        // 群系统通知 → OB11 group request（仅未处理的邀请/申请；doubt 可疑通知跳过）
        if (this.groupChannel !== undefined) {
            this.unsubscribes.push(
                this.groupChannel.on("Group/onGroupNotifiesUpdated", (doubt, notifies) => {
                    if (doubt || !Array.isArray(notifies)) {
                        return;
                    }
                    void this.broadcastGroupRequests(notifies);
                }),
            );
            // 群精华列表变化（c3，2026-09-10 订阅；2026-11-03 起翻译广播）：
            // 列表 diff 是唯一发射路径（design.md §1），732:1 sysmsg 作加速触发器
            // 踢入同一串行链——谁先到谁触发，diff 幂等 + 串行天然去重。
            this.unsubscribes.push(
                this.groupChannel.on("Group/onGroupEssenceListChange", (arg) => {
                    this.handleEssenceChange(arg);
                }),
            );
        }
        // 好友申请 → OB11 friend request（参数形状待真实事件校准，防御性收窄）
        if (this.friendChannel !== undefined) {
            this.unsubscribes.push(
                this.friendChannel.on("Buddy/onBuddyReqChange", (arg) => {
                    const reqs = narrowBuddyReqs(arg);
                    if (reqs === null) {
                        // 未知形状：raw 日志积累校准数据（T10 实测后回填 narrowBuddyReqs）
                        this.calibLogger?.warn(
                            { raw: truncRaw(JSON.stringify(arg)) },
                            "ob11: onBuddyReqChange 未知参数形状",
                        );
                        return;
                    }
                    void this.broadcastFriendRequests(reqs);
                }),
            );
            // 好友列表变化：T10 实证 = BuddyCategory[] 全量快照（翻译走 kernel
            // BuddyCache diff，见下方 buddyCacheEvents）；此处 raw 日志保留积累
            // 校准数据（快照字段较多，slice 截断）
            for (const evt of ["Buddy/onBuddyListChange", "Buddy/onBuddyListChangedV2"] as const) {
                this.unsubscribes.push(
                    this.friendChannel.on(evt, (arg) => {
                        this.calibLogger?.info(
                            { raw: truncRaw(JSON.stringify(arg)) },
                            `ob11: ${evt} raw（friend_add 校准数据）`,
                        );
                    }),
                );
            }
        }
        // 好友缓存 diff（B2，2026-09-08）：快照对比出的新增 → friend_add notice。
        // diff/baseline 逻辑在 kernel BuddyCache（onBuddyListChange 全量快照，
        // 首帧只建 baseline），adapter 翻译保持纯函数。
        if (this.buddyCacheEvents !== undefined) {
            this.unsubscribes.push(
                this.buddyCacheEvents.on("BuddyCache/onBuddyAdded", (entry) => {
                    this.broadcast(toFriendAdd(entry, this.selfUin));
                }),
            );
        }
    }

    /** 退订（幂等）。 */
    unsubscribeAll(): void {
        for (const off of this.unsubscribes) {
            off();
        }
        this.unsubscribes = [];
    }

    /** 单条收向消息：grayTip→notice / 自消息过滤 / 群文件开关 / message 事件。 */
    private handleRawMessage(msg: RawMessage): void {
        // grayTip（系统事件）→ notice；否则 → 消息事件
        if (hasGrayTip(msg)) {
            this.broadcastNotice(msg).catch(() => {
                // notice 翻译失败静默（grayTip 解析宽容）
            });
            return;
        }
        // 自身消息：默认不上报（OB11 规范行为；reportSelfMessage=true 时上报）
        if (!this.reportSelfMessage && String(msg.senderUin) === this.selfUin) {
            return;
        }
        // 群文件报形式开关（B4）：on = group_upload notice 替代 message 事件
        if (this.groupUploadAsNotice && msg.chatType === ChatType.GROUP && hasFileElement(msg)) {
            const notice = toGroupUpload(msg, this.selfUin);
            if (notice !== null) {
                this.broadcast(notice);
                return;
            }
        }
        void this.broadcastMessageEvent(msg);
    }

    /**
     * 广播消息事件（P2-19）：回填 ctx 后交纯函数翻译。
     * 收方向 ID 转换在边界批量完成（enrichment），翻译失败不在此吞。
     */
    private async broadcastMessageEvent(msg: RawMessage): Promise<void> {
        const ctx = await this.enrich.messageContext(msg);
        this.broadcast(
            toOb11MessageEvent(msg, this.selfUin, this.api.messageUnique, this.messageFormat, ctx),
        );
    }

    /** 广播 grayTip → notice 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastNotice(msg: RawMessage): Promise<void> {
        const uidToUin = await this.enrich.noticeUidMap(collectGrayTipUids(msg));
        const notice = toOb11NoticeEvent(msg, {
            selfUin: this.selfUin,
            uidToUin,
            ...(this.calibLogger !== undefined ? { logger: this.calibLogger } : {}),
        });
        if (notice !== null) {
            this.broadcast(notice);
        }
    }

    /** 广播群系统通知 → OB11 group request 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastGroupRequests(notifies: unknown[]): Promise<void> {
        const ctx: RequestTranslateContext = {
            selfUin: this.selfUin,
            uidToUin: await this.enrich.uidToUinMap(collectGroupNotifyUids(notifies)),
        };
        for (const n of notifies) {
            const event = toOb11GroupRequestEvent(n as GroupNotify, ctx);
            if (event !== null) {
                this.broadcast(event);
            }
        }
    }

    /** 广播好友申请 → OB11 friend request 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastFriendRequests(reqs: BuddyReq[]): Promise<void> {
        const ctx: RequestTranslateContext = {
            selfUin: this.selfUin,
            uidToUin: await this.enrich.uidToUinMap(
                reqs.map((r) => r.friendUid).filter((uid) => uid !== ""),
            ),
        };
        for (const req of reqs) {
            this.broadcast(toOb11FriendRequestEvent(req, ctx));
        }
    }

    /**
     * 单条 sysmsg 字节块：解码 → 识别 → 命中才广播，未识别打结构化校准日志
     * （识别表 2026-11-01 起含 732:21 group_card；732:1 精华为加速触发器，
     * design.md §1/§7.5）。规则声明 collectUids 时先批量 uid→uin 再提取。
     */
    private async handleSysMsgBlob(blob: Uint8Array): Promise<void> {
        const tree = decodeProtoTree(blob);
        if (tree === null) {
            this.calibLogger?.warn(
                { raw: truncRaw(toHex(blob).slice(0, 1024)) },
                "ob11: onRecvSysMsg protobuf 解码失败",
            );
            return;
        }
        const env = extractSysMsgEnvelope(tree);
        const rec = recognizeOb11SysMsg(env.msgType, env.subType);
        if (await this.handleRecognizedSysMsg(tree, env, rec)) {
            return;
        }
        // 校准遥测（协议逆向用）：info/warn 级不出（2026-10-25 级别重分配 + 截断），
        // debug 级保留全量字段（含 raw hex）供校准采集
        this.calibLogger?.debug(
            {
                verdict: rec.kind,
                msgType: env.msgType,
                subType: env.subType,
                subTypeAlt: env.subTypeAlt,
                groupCodes: env.groupCodes,
                time: env.time,
                actorUin: env.actorUin,
                actorUid: env.actorUid,
                strings: env.strings,
                raw: toHex(blob).slice(0, 1024),
            },
            "ob11: onRecvSysMsg 校准数据（未识别，不广播）",
        );
    }

    /**
     * 已识别 sysmsg 处理（732:1 精华触发器 / 识别表规则广播）；命中返回 true。
     * 提取失败返回 false 落入校准路径（不硬广播半成品事件）。
     */
    private async handleRecognizedSysMsg(
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
        rec: ReturnType<typeof recognizeOb11SysMsg>,
    ): Promise<boolean> {
        // 732:1 群精华设置（识别表实证）：push 无 sender/operator，不直接翻译，
        // 作加速触发器踢入列表 diff 串行链（design.md §1 group_essence bullet）
        if (env.msgType === 732 && env.subType === 1 && this.triggerEssenceSync(tree)) {
            return true;
        }
        if (rec.kind !== "notice") {
            return false;
        }
        const uinOf = await this.enrich.sysMsgUinResolver(rec.rule, tree, env);
        const ctx = {
            selfUin: Number(this.selfUin),
            time: env.time ?? Math.floor(Date.now() / MS_TO_SEC),
        };
        const event = rec.rule.extract(tree, env, uinOf, ctx);
        if (event === null) {
            return false;
        }
        this.broadcast(event);
        return true;
    }

    /** sysmsg 732:1 → 加速触发器：抽取群号踢入串行 sync 链（抽取失败走校准路径）。 */
    private triggerEssenceSync(tree: readonly SysMsgField[]): boolean {
        const hit = extractEssenceSetSysMsg(tree);
        if (hit === null) {
            return false;
        }
        this.essenceSync.enqueue(String(hit.groupCode));
        return true;
    }

    /** 精华列表变更：拉全量列表 diff（唯一发射路径；参数收窄失败走校准日志）。 */
    private handleEssenceChange(arg: unknown): void {
        const groupCode = narrowEssenceGroupArg(arg);
        if (groupCode === null) {
            this.calibLogger?.warn(
                { raw: truncRaw(JSON.stringify(arg)) },
                "ob11: onGroupEssenceListChange 未知参数形状",
            );
            return;
        }
        this.essenceSync.enqueue(groupCode);
    }

    /** diff 新增项 → group_essence add（sender 必填，operator 回填，message_id 反查）。 */
    private async broadcastEssenceAdded(
        groupCode: string,
        added: readonly EssenceAddedItem[],
    ): Promise<void> {
        for (const item of added) {
            const senderId = numericUin(item.senderUin);
            if (senderId === null) {
                this.calibLogger?.warn(
                    { group: groupCode, seq: item.messageSeq },
                    "ob11: 精华新增 sender_uin 缺失（跳过事件）",
                );
                continue;
            }
            const messageId = await this.enrich.resolveEssenceMsgId(groupCode, item.messageSeq);
            if (messageId === null) {
                continue; // resolveEssenceMsgId 内已校准日志
            }
            const operatorId = numericUin(item.operatorUin);
            this.broadcast({
                time: item.addDigestTime ?? Math.floor(Date.now() / MS_TO_SEC),
                self_id: Number(this.selfUin),
                post_type: "notice",
                notice_type: "group_essence",
                sub_type: "add",
                group_id: Number(groupCode),
                sender_id: senderId,
                ...(operatorId !== null ? { operator_id: operatorId } : {}),
                message_id: messageId,
            });
        }
    }

    /** diff 移除项 → group_essence delete（sender 从 prev 缓存回填；operator 无数据源省略）。 */
    private async broadcastEssenceRemoved(
        groupCode: string,
        removed: readonly number[],
        prev: ReadonlyMap<number, EssenceCacheEntry>,
    ): Promise<void> {
        for (const seq of removed) {
            const senderId = numericUin(prev.get(seq)?.senderUin ?? null);
            if (senderId === null) {
                this.calibLogger?.warn(
                    { group: groupCode, seq },
                    "ob11: 精华移除 sender 不可得（跳过事件）",
                );
                continue;
            }
            const messageId = await this.enrich.resolveEssenceMsgId(groupCode, seq);
            if (messageId === null) {
                continue;
            }
            this.broadcast({
                time: Math.floor(Date.now() / MS_TO_SEC),
                self_id: Number(this.selfUin),
                post_type: "notice",
                notice_type: "group_essence",
                sub_type: "delete",
                group_id: Number(groupCode),
                sender_id: senderId,
                message_id: messageId,
            });
        }
    }
}

/** 收集群系统通知涉及的 uid（user1/user2 双方，空 uid 跳过）。 */
function collectGroupNotifyUids(notifies: unknown[]): string[] {
    const uids: string[] = [];
    for (const n of notifies) {
        const notify = n as { user1?: { uid?: unknown }; user2?: { uid?: unknown } };
        for (const u of [notify.user1, notify.user2]) {
            if (typeof u?.uid === "string" && u.uid !== "") {
                uids.push(u.uid);
            }
        }
    }
    return uids;
}
