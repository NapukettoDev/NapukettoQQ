/**
 * NapukettoOneBot11Adapter：OneBot 11 协议适配器（P2-3：收发闭环）
 *
 * - 收链路：订阅 kernel 消息事件通道 → RawMessage 翻译 OB11 消息事件 → network 广播
 * - 发链路：handleRequest（OB11 标准 { action, params, echo }）→ 动作注册表 → kernel apis
 *
 * 生命周期走 BaseProtocolAdapter 骨架（start 校验配置 → onStart 订阅 → stop 退订）。
 * 翻译为纯函数（ADR-008）：只读入参（RawMessage），不调 API、不读缓存。
 */

import { existsSync } from "node:fs";
import type {
    BuddyCacheEventChannel,
    BuddyEventChannel,
    BuddyReq,
    EssenceMsgItem,
    GroupEventChannel,
    GroupNotify,
    MsgEventChannel,
    PicElement,
    RawMessage,
} from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import {
    type ActionRegistry,
    type ActionResult,
    BaseProtocolAdapter,
    type ProtocolConfig,
} from "../core/index.js";
import type { EssenceAddedItem, EssenceCacheEntry } from "../core/shared/essence.js";
import {
    diffEssenceList,
    extractEssenceSetSysMsg,
    narrowEssenceGroupArg,
} from "../core/shared/essence.js";
import { subscribeRawMessages } from "../core/shared/raw-message.js";
import { createOb11ActionRegistry } from "./action/index.js";
import type { OneBotApiOptions } from "./api/index.js";
import { OneBotApi } from "./api/index.js";
import type { OB11Config } from "./helper/index.js";
import { collectReceiveNeeds, type ReceiveTranslateContext } from "./helper/index.js";
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
    type SysMsgKindRuleOB11,
    toHex,
} from "./helper/sysmsg.js";
import type { Ob11TransportSet } from "./transport.js";
import { assembleOb11Transports } from "./transport.js";

/** 毫秒 → 秒（Unix 时间戳）。 */
const MS_TO_SEC = 1000;

/**
 * 入站图片补图限时（issue #105）：宿主无 UI 时 `sourcePath` 只是目标路径，事件里报
 * 不存在的路径会让下游读图失败。翻译前主动下载，超时即放弃（保留原路径 + warn），
 * 避免慢网/失败下载拖住消息链。
 */
const IMAGE_EVENT_DOWNLOAD_TIMEOUT_MS = 5_000;

/** PIC 本地文件是否已落盘（picPath → sourcePath）。 */
function picFileExists(pic: PicElement): boolean {
    for (const value of [pic.picPath, pic.sourcePath]) {
        if (value !== undefined && value !== "" && existsSync(value)) {
            return true;
        }
    }
    return false;
}

/** 图片是否已有可用直链（`picUrl` 非空）；有直链时下游优先用 url，无需补本地文件。 */
function picHasUrl(pic: PicElement): boolean {
    return pic.picUrl !== undefined && pic.picUrl !== "";
}

/**
 * info/warn 级 raw 字段截断上限（2026-10-25 输出内容治理）：hex/base64/JSON
 * 原文对运行状态无信息量，保留前缀定位 + 缺省长度；完整值仅在 debug 级
 * （[log.levels].ob11 = "debug"）与日志文件中出现。
 */
const RAW_INFO_LIMIT = 64;

/** raw 字段截断：超限截断 + 缺省长度标注（…(+N)）。 */
function truncRaw(value: string | undefined, keep = RAW_INFO_LIMIT): string {
    if (value === undefined) {
        return "";
    }
    return value.length <= keep ? value : `${value.slice(0, keep)}…(+${value.length - keep})`;
}

/** 数字串判别（uin）。 */
const NUMERIC_RE = /^\d+$/;

/** 数字串 uin → number（缺失/非法 → null，调用方按口径省略或跳过）。 */
function numericUin(value: string | null): number | null {
    return value !== null && NUMERIC_RE.test(value) ? Number(value) : null;
}

/** 最小 logger 面（校准日志用：未知事件形状打 raw JSON；缺省静默）。 */
export interface AdapterLoggerLike {
    warn(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
    /** 校准数据（2026-10-25 级别重分配：info → debug；此面必须支持）。 */
    debug(obj: unknown, msg?: string): void;
}

/** 适配器构造参数（api 相关字段继承 OneBotApiOptions，P2-16 聚合）。 */
export interface OneBot11AdapterOptions extends OneBotApiOptions {
    /** 协议配置（zod 校验 + JSON 读写）。 */
    config: ProtocolConfig<OB11Config>;
    /** network 事件广播（注册传输适配器后 emit 推给第三方）。 */
    broadcaster: EventBroadcaster;
    /** kernel 消息事件通道（消息收链路入口）。 */
    msgChannel: MsgEventChannel;
    /** kernel 群事件通道（可选：Group/onGroupNotifiesUpdated → OB11 request 源）。 */
    groupChannel?: GroupEventChannel;
    /** kernel 好友事件通道（可选：Buddy/onBuddyReqChange → OB11 request 源）。 */
    friendChannel?: BuddyEventChannel;
    /** 好友缓存 diff 通道（可选：BuddyCache/onBuddyAdded → OB11 friend_add 源，B2）。 */
    buddyCacheEvents?: BuddyCacheEventChannel;
    /** 校准日志（可选：未知事件形状 raw JSON；IPC 模式传 loader pino 实例）。 */
    logger?: AdapterLoggerLike;
}

/** OneBot 11 协议适配器。 */
export class NapukettoOneBot11Adapter extends BaseProtocolAdapter<OB11Config> {
    readonly protocol = "onebot11";

    private readonly msgChannel: MsgEventChannel;
    private readonly groupChannel: GroupEventChannel | undefined;
    private readonly friendChannel: BuddyEventChannel | undefined;
    private readonly buddyCacheEvents: BuddyCacheEventChannel | undefined;
    private readonly calibLogger: AdapterLoggerLike | undefined;
    private readonly selfUin: string;
    private readonly oneBotApi: OneBotApi;
    /** 动作注册表（公共只读：IPC 桥等装配方枚举动作名直接挂载）。 */
    readonly registry: ActionRegistry;
    private unsubscribes: Array<() => void> = [];
    private transports: Ob11TransportSet | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private reportSelfMessage = false;
    private messageFormat: "array" | "string" = "array";
    /** 群文件报形式（B4）：true = fileElement 群消息报 group_upload notice 替代 message。 */
    private groupUploadAsNotice = false;
    /** IPC 桥模式标记（subscribeOnly 启动；reload 时跳过传输重建）。 */
    private subscribedOnly = false;
    /** 精华列表缓存（群号 → seq → 条目{操作者/发送者/加精时间}；group_essence diff 路径）。 */
    private readonly essenceCaches = new Map<string, Map<number, EssenceCacheEntry>>();
    /** 精华列表拉取串行链（并发回写乱序会把新列表覆盖成旧列表；732:1 触发器与列表回调共用）。 */
    private essenceChain: Promise<void> = Promise.resolve();

    constructor(opts: OneBot11AdapterOptions) {
        super({
            config: opts.config,
            broadcaster: opts.broadcaster,
            hooks: {
                onStart: (config) => this.startTransports(config as OB11Config),
                onStop: () => this.stopAll(),
                onReload: (config) => this.reloadTransports(config as OB11Config),
            },
        });
        this.msgChannel = opts.msgChannel;
        this.groupChannel = opts.groupChannel;
        this.friendChannel = opts.friendChannel;
        this.buddyCacheEvents = opts.buddyCacheEvents;
        this.calibLogger = opts.logger;
        this.selfUin = opts.self.uin;
        this.oneBotApi = new OneBotApi(opts);
        this.registry = createOb11ActionRegistry({ api: this.oneBotApi });
    }

    /**
     * 配置热更新（P2-6，2026-09-08 实现）：stop 旧传输/心跳/退订 → 按新配置重建。
     * IPC 桥模式（subscribeOnly，无传输）只刷新上报开关字段，不重建。
     */
    private async reloadTransports(config: OB11Config): Promise<void> {
        if (this.subscribedOnly) {
            this.reportSelfMessage = config.reportSelfMessage;
            this.messageFormat = config.messagePostFormat;
            this.groupUploadAsNotice = config.groupUploadAsNotice;
            return;
        }
        await this.stopAll();
        await this.startTransports(config);
    }

    /** 启动传输：装配（HTTP/WS）+ 打开 server/client + 广播 lifecycle enable + 起心跳。 */
    private async startTransports(config: OB11Config): Promise<void> {
        // start() 即装传输：脱离 IPC 桥模式（复查发现的潜在混用序，防御复位）
        this.subscribedOnly = false;
        // 全局上报开关与消息格式（订阅处消费）
        this.reportSelfMessage = config.reportSelfMessage;
        this.messageFormat = config.messagePostFormat;
        this.groupUploadAsNotice = config.groupUploadAsNotice;
        const broadcaster = this.getBroadcaster();
        if (broadcaster !== undefined) {
            this.transports = assembleOb11Transports({
                config,
                broadcaster,
                selfUin: this.selfUin,
                handleRequest: (req, respond) => {
                    this.handleRequest(req, respond).catch((err: unknown) => {
                        let message = String(err);
                        if (err instanceof Error) {
                            message = err.message;
                        }
                        respond({ status: "failed", retcode: 999, data: null, message });
                    });
                },
            });
            // 打开 server + 正向 client
            await Promise.all(this.transports.servers.map((s) => s.open()));
            await Promise.all(this.transports.transports.map((t) => t.open()));
        }
        this.subscribe();
        // lifecycle: enable
        this.broadcastEvent({
            time: Math.floor(Date.now() / MS_TO_SEC),
            self_id: Number(this.selfUin),
            post_type: "meta_event",
            meta_event_type: "lifecycle",
            sub_type: "enable",
        });
        // 心跳
        this.startHeartbeat(config.heartbeatInterval);
    }

    /** 心跳 meta 事件（interval 毫秒，0 关闭）。 */
    private startHeartbeat(intervalMs: number): void {
        if (intervalMs <= 0) {
            return;
        }
        this.heartbeatTimer = setInterval(() => {
            this.broadcastEvent({
                time: Math.floor(Date.now() / MS_TO_SEC),
                self_id: Number(this.selfUin),
                post_type: "meta_event",
                meta_event_type: "heartbeat",
                interval: intervalMs,
                status: { online: true, good: true },
            });
        }, intervalMs);
    }

    /** 停止：心跳 + 传输 + 退订。 */
    private async stopAll(): Promise<void> {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.unsubscribeAll();
        if (this.transports !== null) {
            await this.transports.close();
            this.transports = null;
        }
    }

    /** 订阅 kernel 事件（消息 + 群通知 + 好友请求，幂等）。 */
    private subscribe(): void {
        if (this.unsubscribes.length > 0) {
            return;
        }
        // onRecvMsg 回调参数为消息数组（2026-08-07 运行时实证）——遍历逐条翻译。
        this.unsubscribes.push(
            subscribeRawMessages(this.msgChannel, (msg) => {
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
                if (
                    this.groupUploadAsNotice &&
                    msg.chatType === ChatType.GROUP &&
                    hasFileElement(msg)
                ) {
                    const notice = toGroupUpload(msg, this.selfUin);
                    if (notice !== null) {
                        this.broadcastEvent(notice);
                        return;
                    }
                }
                void this.broadcastMessageEvent(msg);
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
                    this.broadcastEvent(toOfflineFileNotice(item, this.selfUin));
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
                    this.broadcastEvent(toFriendAdd(entry, this.selfUin));
                }),
            );
        }
    }

    /**
     * 仅启动接收链路（IPC 桥模式，2026-08-27）：订阅消息通道维护 messageUnique +
     * 灰色通知翻译，与 start() 的差别仅在传输层——不装配 HTTP/WS、不起心跳、
     * 不广播 lifecycle。配置经 seed 装配（load() 返回内存初值）。
     */
    async subscribeOnly(): Promise<void> {
        const config = await this.config.load();
        this.reportSelfMessage = config.reportSelfMessage;
        this.messageFormat = config.messagePostFormat;
        this.groupUploadAsNotice = config.groupUploadAsNotice;
        this.subscribedOnly = true;
        this.subscribe();
    }

    /** 仅退订（与 subscribeOnly 配对的进程级清理；传输关闭仍走 stop()）。 */
    unsubscribeOnly(): void {
        this.subscribedOnly = false;
        this.unsubscribeAll();
    }

    /** sysmsg 规则的 uid→uin 解析器（collectUids 声明才批量转换；失败/缺省恒 0）。 */
    private async sysMsgUinResolver(
        rule: SysMsgKindRuleOB11,
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
    ): Promise<(uid: string) => number> {
        if (rule.collectUids === undefined) {
            return () => 0;
        }
        const uids = rule.collectUids(tree, env).filter((uid) => uid !== "");
        if (uids.length === 0) {
            return () => 0;
        }
        try {
            const map = await this.oneBotApi.uidToUin(uids);
            return (uid: string) => Number(map.get(uid) ?? 0);
        } catch {
            return () => 0;
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
        const uinOf = await this.sysMsgUinResolver(rec.rule, tree, env);
        const ctx = {
            selfUin: Number(this.selfUin),
            time: env.time ?? Math.floor(Date.now() / 1000),
        };
        const event = rec.rule.extract(tree, env, uinOf, ctx);
        if (event === null) {
            return false;
        }
        this.broadcastEvent(event);
        return true;
    }

    /** sysmsg 732:1 → 加速触发器：抽取群号踢入串行 sync 链（抽取失败走校准路径）。 */
    private triggerEssenceSync(tree: readonly SysMsgField[]): boolean {
        const hit = extractEssenceSetSysMsg(tree);
        if (hit === null) {
            return false;
        }
        this.enqueueEssenceSync(String(hit.groupCode));
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
        this.enqueueEssenceSync(groupCode);
    }

    /** 精华 sync 入队（串行防乱序：并发回写会把新列表覆盖成旧列表）。 */
    private enqueueEssenceSync(groupCode: string): void {
        this.essenceChain = this.essenceChain.then(
            () => this.syncEssenceList(groupCode),
            () => undefined,
        );
    }

    /** 单群精华列表同步：拉取 → diff → 广播 → 更新缓存（基线未建立只建基线）。 */
    private async syncEssenceList(groupCode: string): Promise<void> {
        let items: EssenceMsgItem[];
        try {
            items = await this.oneBotApi.webApi.getEssenceMsgList(groupCode);
        } catch (e) {
            this.calibLogger?.warn(
                { group: groupCode, err: String(e) },
                "ob11: 精华列表拉取失败（diff 跳过）",
            );
            return;
        }
        const prev = this.essenceCaches.get(groupCode);
        const { cache, added, removed } = diffEssenceList(prev, items);
        this.essenceCaches.set(groupCode, cache);
        if (prev === undefined) {
            return;
        }
        await this.broadcastEssenceAdded(groupCode, added);
        await this.broadcastEssenceRemoved(groupCode, removed, prev);
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
            const messageId = await this.resolveEssenceMsgId(groupCode, item.messageSeq);
            if (messageId === null) {
                continue; // resolveEssenceMsgId 内已校准日志
            }
            const operatorId = numericUin(item.operatorUin);
            this.broadcastEvent({
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
            const messageId = await this.resolveEssenceMsgId(groupCode, seq);
            if (messageId === null) {
                continue;
            }
            this.broadcastEvent({
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

    /**
     * 精华 message_id 反查：msgSeq → 近段历史扫描（60 条，对齐 milky
     * resolveMsgIdBySeq fallback 层）→ MessageUnique.alloc 幂等分配（可被 get_msg
     * 反查的正确空间，对照 recall 的 msgSeq 错位）。未命中返回 null（跳过事件）。
     */
    private async resolveEssenceMsgId(groupCode: string, seq: number): Promise<number | null> {
        const peer = { chatType: ChatType.GROUP, peerUid: groupCode };
        const msgs = await this.oneBotApi.msgApi.fetchMessages(peer, { count: 60 }).catch(() => []);
        const hit = msgs.find((m) => Number(m.msgSeq) === seq);
        if (hit === undefined) {
            this.calibLogger?.warn(
                { group: groupCode, seq },
                "ob11: 精华 message_id 反查未命中（跳过事件）",
            );
            return null;
        }
        return this.oneBotApi.messageUnique.alloc(hit.msgId, peer);
    }

    /**
     * 广播消息事件（P2-19：接收方向 ID 转换）。
     * 收集 at uid → 一次批量 uidToUin → 构造上下文 → 翻译广播。
     * 群消息另查发送者角色（GroupCache 缓存优先，失败回退缺省 member）。
     * 翻译失败退化为原样（不阻塞上报）。
     */
    private async broadcastMessageEvent(msg: RawMessage): Promise<void> {
        // 入站图片先保活本地文件（issue #105）：翻译仍是纯函数，I/O 只发生在边界
        const message = await this.ensureLocalImageFiles(msg);
        const elements = toCanonicalElements(message);
        const { atUids } = collectReceiveNeeds(elements);
        let uidToUin: Map<string, string> | undefined;
        if (atUids.length > 0) {
            try {
                uidToUin = await this.oneBotApi.uidToUin(atUids);
            } catch {
                // uid 解析失败：at 原样（uid），不阻塞事件上报
            }
        }
        const senderRole =
            msg.chatType === ChatType.GROUP
                ? await this.oneBotApi.groupMemberRole(msg.peerUid, msg.senderUid)
                : undefined;
        const ctx: ReceiveTranslateContext = {
            ...(uidToUin !== undefined ? { uidToUin } : {}),
            ...(senderRole !== undefined ? { senderRole } : {}),
            msgIdToOb11Id: (msgId) => this.oneBotApi.messageUnique.getMessageId(msgId),
        };
        this.broadcastEvent(
            toOb11MessageEvent(
                message,
                this.selfUin,
                this.oneBotApi.messageUnique,
                this.messageFormat,
                ctx,
            ),
        );
    }

    /**
     * 入站图片补本地文件（issue #105）。
     *
     * 自建宿主没有 UI，QQ NT 只给 `sourcePath` 目标路径，原图要显式下载才落盘；入站
     * `originImageUrl` 缺 rkey 不能当直链。事件里直接报这条不存在的路径会让下游
     * （如 AstrBot）读图抛 FileNotFoundError，因此翻译前按元素并发调
     * `MsgApi.downloadImage` 并把真实路径回填到 `sourcePath`。
     *
     * fail-soft：单张下载失败/超时只打 warn 并保留原路径，不阻塞消息事件。
     * 已有 `picUrl` 时不补（下游优先用 url，避免每张图都等下载）。
     */
    private async ensureLocalImageFiles(msg: RawMessage): Promise<RawMessage> {
        const targets: Array<{ index: number; elementId: string }> = [];
        msg.elements.forEach((el, index) => {
            const pic = el.picElement;
            if (pic === undefined || picFileExists(pic) || picHasUrl(pic)) {
                return;
            }
            targets.push({ index, elementId: el.elementId ?? "" });
        });
        if (targets.length === 0) {
            return msg;
        }
        const peer = { chatType: msg.chatType, peerUid: msg.peerUid };
        const results = await Promise.all(
            targets.map(async (target) => {
                try {
                    const { filePath } = await this.oneBotApi.msgApi.downloadImage(
                        msg.msgId,
                        peer,
                        { elementId: target.elementId, timeoutMs: IMAGE_EVENT_DOWNLOAD_TIMEOUT_MS },
                    );
                    return { index: target.index, filePath };
                } catch (err) {
                    this.calibLogger?.warn(
                        {
                            msgId: msg.msgId,
                            elementId: target.elementId,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        "ob11: 入站图片主动下载失败（保留原路径）",
                    );
                    return null;
                }
            }),
        );
        const hits = results.filter(
            (hit): hit is { index: number; filePath: string } => hit !== null,
        );
        if (hits.length === 0) {
            return msg;
        }
        const elements = [...msg.elements];
        for (const hit of hits) {
            const el = elements[hit.index];
            if (el?.picElement === undefined) {
                continue;
            }
            elements[hit.index] = {
                ...el,
                // picPath 是 canonical 的首选路径，必须一并回填，避免残留的旧路径继续被读取
                picElement: { ...el.picElement, picPath: hit.filePath, sourcePath: hit.filePath },
            };
        }
        return { ...msg, elements };
    }

    /** 广播 grayTip → notice 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastNotice(msg: RawMessage): Promise<void> {
        const uids = collectGrayTipUids(msg);
        let uidToUin = new Map<string, string>();
        if (uids.length > 0) {
            uidToUin = await this.oneBotApi.uidToUin(uids);
        }
        const notice = toOb11NoticeEvent(msg, {
            selfUin: this.selfUin,
            uidToUin,
            ...(this.calibLogger !== undefined ? { logger: this.calibLogger } : {}),
        });
        if (notice !== null) {
            this.broadcastEvent(notice);
        }
    }

    /** 广播群系统通知 → OB11 group request 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastGroupRequests(notifies: unknown[]): Promise<void> {
        const ctx: RequestTranslateContext = {
            selfUin: this.selfUin,
            uidToUin: await this.uidToUinMap(collectGroupNotifyUids(notifies)),
        };
        for (const n of notifies) {
            const event = toOb11GroupRequestEvent(n as GroupNotify, ctx);
            if (event !== null) {
                this.broadcastEvent(event);
            }
        }
    }

    /** 广播好友申请 → OB11 friend request 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastFriendRequests(reqs: BuddyReq[]): Promise<void> {
        const ctx: RequestTranslateContext = {
            selfUin: this.selfUin,
            uidToUin: await this.uidToUinMap(
                reqs.map((r) => r.friendUid).filter((uid) => uid !== ""),
            ),
        };
        for (const req of reqs) {
            this.broadcastEvent(toOb11FriendRequestEvent(req, ctx));
        }
    }

    /** uid 批量 → uin（失败退空 Map：翻译层退化为 uid 数值，不阻塞请求上报）。 */
    private async uidToUinMap(uids: string[]): Promise<Map<string, string>> {
        if (uids.length === 0) {
            return new Map();
        }
        try {
            return await this.oneBotApi.uidToUin(uids);
        } catch {
            return new Map();
        }
    }

    /** 退订（幂等）。 */
    private unsubscribeAll(): void {
        for (const off of this.unsubscribes) {
            off();
        }
        this.unsubscribes = [];
    }

    /**
     * 请求分发（挂到 network transport 的 onRequest）：
     * OB11 标准请求 { action, params, echo } → 动作注册表 → handle（HTTP）/websocketHandle（WS）。
     */
    async handleRequest(req: unknown, respond: (res: unknown) => void): Promise<void> {
        const parsed = (req ?? {}) as { action?: unknown; params?: unknown; echo?: unknown };
        // params 缺省 {}（OB11 规范允许省略；schema 校验在动作内，此处不判类型）
        const { action: rawAction, echo } = parsed;
        const params = parsed.params ?? {};
        let action = "";
        if (typeof rawAction === "string") {
            action = rawAction;
        }
        if (action === "") {
            respond({
                status: "failed",
                retcode: 404,
                data: null,
                message: "请求缺少 action",
            });
            return;
        }
        const act = this.registry.get(action);
        if (act === undefined) {
            respond({
                status: "failed",
                retcode: 404,
                data: null,
                message: `未知动作: ${action}`,
            });
            return;
        }
        let result: ActionResult<unknown>;
        if (echo === undefined) {
            result = await act.handle(params);
        } else {
            result = await act.websocketHandle(params, echo);
        }
        respond(result);
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
