/**
 * OB11 收链路订阅接线板：管理 unsubscribes 与 kernel 频道 → 领域处理器路由；
 * 域处理在 inbound/，异步回填在 enrichment.ts。
 */
import type {
    BuddyCacheEventChannel,
    BuddyEventChannel,
    GroupEventChannel,
    MsgEventChannel,
} from "@napuketto/kernel";
import { type AdapterLoggerLike, logEventFailure } from "../shared/log.js";
import { subscribeRawMessages } from "../shared/raw-message.js";
import type { OneBotApi } from "./api/one-bot-api.js";
import { Ob11Enrichment } from "./enrichment.js";
import type { OB11Config } from "./helper/index.js";
import { Ob11InboundEssence } from "./inbound/essence.js";
import { Ob11InboundFileNotice } from "./inbound/file-notice.js";
import { Ob11InboundMessage } from "./inbound/message.js";
import { Ob11InboundRequest } from "./inbound/request.js";
import { Ob11InboundSysMsg } from "./inbound/sysmsg.js";

export interface Ob11EventPipelineDeps {
    selfUin: string;
    api: OneBotApi;
    broadcast: (event: unknown) => void;
    logger?: AdapterLoggerLike | undefined;
    msgChannel: MsgEventChannel;
    groupChannel?: GroupEventChannel | undefined;
    friendChannel?: BuddyEventChannel | undefined;
    buddyCacheEvents?: BuddyCacheEventChannel | undefined;
}

export class Ob11EventPipeline {
    private readonly deps: Ob11EventPipelineDeps;
    private readonly essence: Ob11InboundEssence;
    private readonly message: Ob11InboundMessage;
    private readonly sysMsg: Ob11InboundSysMsg;
    private readonly request: Ob11InboundRequest;
    private readonly fileNotice: Ob11InboundFileNotice;
    private unsubscribes: Array<() => void> = [];

    constructor(deps: Ob11EventPipelineDeps) {
        this.deps = deps;
        const enrich = new Ob11Enrichment({ api: deps.api, logger: deps.logger });
        this.essence = new Ob11InboundEssence({ ...deps, enrich });
        this.message = new Ob11InboundMessage({ ...deps, enrich });
        this.sysMsg = new Ob11InboundSysMsg({ ...deps, enrich, essence: this.essence });
        this.request = new Ob11InboundRequest({ ...deps, enrich });
        this.fileNotice = new Ob11InboundFileNotice(deps);
    }

    applyConfig(config: OB11Config): void {
        this.message.applyConfig(config);
    }

    /** 订阅 kernel 事件（消息 + 群 + 好友 + 好友缓存，幂等；路由到 inbound/）。 */
    subscribe(): void {
        if (this.unsubscribes.length > 0) {
            return;
        }
        const { msgChannel, groupChannel, friendChannel, buddyCacheEvents } = this.deps;
        this.unsubscribes.push(
            subscribeRawMessages(msgChannel, (msg) => this.message.handleRawMessage(msg)),
            msgChannel.on("Msg/onRecvOfflineFileMsg", (a) => this.fileNotice.offlineFile(a)),
            msgChannel.on("Msg/onRecvSysMsg", (a) => this.sysMsg.handleRawArg(a)),
            msgChannel.on("Msg/onRecvOnlineFileMsg", (a) => this.fileNotice.onlineFile(a)),
        );
        if (groupChannel !== undefined) {
            this.unsubscribes.push(
                groupChannel.on("Group/onGroupNotifiesUpdated", (doubt, notifies) => {
                    // 回填/翻译失败只丢本批事件，不打断收链路
                    this.request
                        .groupNotifies(doubt, notifies)
                        .catch((err: unknown) =>
                            logEventFailure(
                                this.deps.logger,
                                "ob11: group request 翻译失败（整批丢弃）",
                                err,
                            ),
                        );
                }),
                groupChannel.on("Group/onGroupEssenceListChange", (a) => this.essence.change(a)),
            );
        }
        if (friendChannel !== undefined) {
            this.unsubscribes.push(
                friendChannel.on("Buddy/onBuddyReqChange", (a) => this.request.buddyReqs(a)),
            );
            for (const evt of ["Buddy/onBuddyListChange", "Buddy/onBuddyListChangedV2"] as const) {
                this.unsubscribes.push(
                    friendChannel.on(evt, (a) => this.fileNotice.buddyList(evt, a)),
                );
            }
        }
        if (buddyCacheEvents !== undefined) {
            this.unsubscribes.push(
                buddyCacheEvents.on("BuddyCache/onBuddyAdded", (e) => this.fileNotice.friendAdd(e)),
            );
        }
    }

    unsubscribeAll(): void {
        for (const off of this.unsubscribes) {
            off();
        }
        this.unsubscribes = [];
    }
}
