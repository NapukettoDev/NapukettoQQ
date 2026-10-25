/**
 * NapukettoOneBot11Adapter：OneBot 11 协议适配器（P2-3：收发闭环）
 *
 * - 收链路：订阅 kernel 消息事件通道 → RawMessage 翻译 OB11 消息事件 → network 广播
 * - 发链路：handleRequest（OB11 标准 { action, params, echo }）→ 动作注册表 → kernel apis
 *
 * 生命周期走 BaseProtocolAdapter 骨架（start 校验配置 → onStart 订阅 → stop 退订）。
 * 翻译为纯函数（ADR-008）：只读入参（RawMessage），不调 API、不读缓存。
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
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import {
    type ActionRegistry,
    type ActionResult,
    BaseProtocolAdapter,
    type ProtocolConfig,
} from "../core/index.js";
import { forEachRawMessage } from "../core/raw-message.js";
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
    recognizeSysMsg,
    toHex,
} from "./helper/sysmsg.js";
import type { Ob11TransportSet } from "./transport.js";
import { assembleOb11Transports } from "./transport.js";

/** 毫秒 → 秒（Unix 时间戳）。 */
const MS_TO_SEC = 1000;

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
            this.msgChannel.on("Msg/onRecvMsg", (msgs) => {
                forEachRawMessage(msgs, (msg) => {
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
                });
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
                    this.handleSysMsgBlob(blob);
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
            // 群精华列表变化（c3，2026-09-10）：raw 校准日志（OB11 group_essence
            // 候选源；真实 payload 到达后回填翻译；debug 级，2026-10-25）
            this.unsubscribes.push(
                this.groupChannel.on("Group/onGroupEssenceListChange", (arg) => {
                    this.calibLogger?.debug(
                        { raw: truncRaw(JSON.stringify(arg)) },
                        "ob11: onGroupEssenceListChange raw（group_essence 校准数据）",
                    );
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

    /**
     * 单条 sysmsg 字节块：解码 → 识别 → 命中才广播，未识别打结构化校准日志
     * （识别表为空时全部走日志路径，design.md §7.5）。
     */
    private handleSysMsgBlob(blob: Uint8Array): void {
        const tree = decodeProtoTree(blob);
        if (tree === null) {
            this.calibLogger?.warn(
                { raw: truncRaw(toHex(blob).slice(0, 1024)) },
                "ob11: onRecvSysMsg protobuf 解码失败",
            );
            return;
        }
        const env = extractSysMsgEnvelope(tree);
        const rec = recognizeSysMsg(env.msgType, env.subType);
        if (rec.kind === "notice") {
            const event = rec.rule.extract(tree, env);
            if (event !== null) {
                this.broadcastEvent(event);
                return;
            }
            // 提取失败：降级校准日志（不硬广播半成品事件）
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
     * 广播消息事件（P2-19：接收方向 ID 转换）。
     * 收集 at uid → 一次批量 uidToUin → 构造上下文 → 翻译广播。
     * 翻译失败退化为原样（不阻塞上报）。
     */
    private async broadcastMessageEvent(msg: RawMessage): Promise<void> {
        const elements = toCanonicalElements(msg);
        const { atUids } = collectReceiveNeeds(elements);
        let uidToUin: Map<string, string> | undefined;
        if (atUids.length > 0) {
            try {
                uidToUin = await this.oneBotApi.uidToUin(atUids);
            } catch {
                // uid 解析失败：at 原样（uid），不阻塞事件上报
            }
        }
        const ctx: ReceiveTranslateContext = {
            ...(uidToUin !== undefined ? { uidToUin } : {}),
            msgIdToOb11Id: (msgId) => this.oneBotApi.messageUnique.getMessageId(msgId),
        };
        this.broadcastEvent(
            toOb11MessageEvent(
                msg,
                this.selfUin,
                this.oneBotApi.messageUnique,
                this.messageFormat,
                ctx,
            ),
        );
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
        const uids: string[] = [];
        for (const n of notifies) {
            const notify = n as { user1?: { uid?: unknown }; user2?: { uid?: unknown } };
            for (const u of [notify.user1, notify.user2]) {
                if (typeof u?.uid === "string" && u.uid !== "") {
                    uids.push(u.uid);
                }
            }
        }
        let uidToUin = new Map<string, string>();
        if (uids.length > 0) {
            try {
                uidToUin = await this.oneBotApi.uidToUin(uids);
            } catch {
                // uid 解析失败：退化为 uid 数值（不阻塞请求上报）
            }
        }
        const ctx: RequestTranslateContext = { selfUin: this.selfUin, uidToUin };
        for (const n of notifies) {
            const event = toOb11GroupRequestEvent(n as GroupNotify, ctx);
            if (event !== null) {
                this.broadcastEvent(event);
            }
        }
    }

    /** 广播好友申请 → OB11 friend request 事件（批量 uidToUin 后翻译，纯函数）。 */
    private async broadcastFriendRequests(reqs: BuddyReq[]): Promise<void> {
        const uids = reqs.map((r) => r.friendUid).filter((uid) => uid !== "");
        let uidToUin = new Map<string, string>();
        if (uids.length > 0) {
            try {
                uidToUin = await this.oneBotApi.uidToUin(uids);
            } catch {
                // uid 解析失败：退化为 uid 数值（不阻塞请求上报）
            }
        }
        const ctx: RequestTranslateContext = { selfUin: this.selfUin, uidToUin };
        for (const req of reqs) {
            this.broadcastEvent(toOb11FriendRequestEvent(req, ctx));
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
